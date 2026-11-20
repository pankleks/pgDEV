// Read-only gate for agent-issued SQL. The tool layer refuses anything that is
// not a plain read before it reaches the database; the statement then runs in
// a read-only transaction as well (runReadOnlyBatch in queryexec.ts), so
// PostgreSQL is the real guarantee and this classifier only exists to give a
// clearer message (and to catch locking clauses that would otherwise fail with
// a database error). The classifier's split is never trusted for safety.

import { splitStatements } from '../sqlsplit.js'
import { scanSqlLexemes } from '../sqllex.js'

const READ_COMMANDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN'])

export type ReadOnlyCheck = { ok: true } | { ok: false; reason: string }

/** Blank the contents of strings, comments, quoted identifiers and dollar
 * bodies so a keyword check cannot match inside them. Index-preserving. */
function maskLiterals(sql: string): string {
  let out = ''
  scanSqlLexemes(sql, (lex) => {
    const opaque =
      lex.kind === 'string' || lex.kind === 'dollar' || lex.kind === 'lineComment' ||
      lex.kind === 'blockComment' || (lex.kind === 'ident' && lex.quoted)
    out += opaque ? ' '.repeat(lex.end - lex.start) : lex.raw
  })
  return out
}

/** The first keyword of a statement, uppercased, skipping leading comments. */
function firstKeyword(stmt: string): string {
  let keyword = ''
  scanSqlLexemes(stmt, (lex) => {
    if (lex.kind === 'whitespace' || lex.kind === 'lineComment' || lex.kind === 'blockComment') return
    if (lex.kind === 'ident' && !lex.quoted) keyword = lex.name.toUpperCase()
    return false
  })
  return keyword
}

/** True when the statement carries a row-locking clause, which a read-only
 * transaction refuses anyway; the caller turns this into a clearer message. */
function hasLockingClause(stmt: string): boolean {
  return /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(maskLiterals(stmt))
}

// Functions a read-only transaction does not contain: they signal or stop
// other sessions, reload or rotate server state, read or write server files,
// open their own writable connections (dblink), reset statistics, manage
// replication or change the session's role/settings (set_config), so a
// SELECT calling them still has effects. Matched as calls, by name, whatever
// the schema qualification. This is a guard against direct calls only: an
// existing wrapper function can still reach them, so the real limit is the
// privileges of the connection's login.
const BLOCKED_FUNCTIONS = new Set([
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'pg_promote', 'pg_log_backend_memory_contexts', 'pg_switch_wal',
  'pg_wal_replay_pause', 'pg_wal_replay_resume', 'pg_drop_replication_slot',
  'pg_replication_slot_advance', 'pg_backup_start', 'pg_backup_stop',
  'pg_start_backup', 'pg_stop_backup',
  'pg_read_file', 'pg_read_binary_file', 'pg_stat_file', 'pg_ls_dir', 'lo_import', 'lo_export',
  'pg_file_write', 'pg_file_rename', 'pg_file_unlink', 'pg_file_sync', 'pg_logdir_ls',
  'pg_stat_statements_reset', 'set_config',
])
const BLOCKED_PREFIXES = ['dblink', 'pg_ls_', 'pg_stat_reset', 'pg_create_', 'pg_replication_origin_']

function isBlockedFunction(name: string): boolean {
  return BLOCKED_FUNCTIONS.has(name) || BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** The first blocked function the statement calls (`name(`), or null. An
 * unquoted name folds to lowercase; a quoted one must match exactly. */
function blockedCall(stmt: string): string | null {
  let previous: { name: string; quoted: boolean } | null = null
  let found: string | null = null
  scanSqlLexemes(stmt, (lex) => {
    if (lex.kind === 'whitespace' || lex.kind === 'lineComment' || lex.kind === 'blockComment') return
    if (lex.kind === 'punct' && lex.raw === '(' && previous) {
      const name = previous.quoted ? previous.name : previous.name.toLowerCase()
      if (isBlockedFunction(name)) {
        found = name
        return false
      }
    }
    previous = lex.kind === 'ident' ? { name: lex.name, quoted: lex.quoted } : null
  })
  return found
}

/**
 * Check a whole batch: every statement must be a bare read. An empty batch is
 * refused, and one write anywhere rejects the batch (the agent gets a clear
 * message instead of a half-applied batch).
 */
export function isReadOnlySql(sql: string): ReadOnlyCheck {
  const statements = splitStatements(sql)
  if (!statements.length) return { ok: false, reason: 'The query is empty.' }
  for (const stmt of statements) {
    const keyword = firstKeyword(stmt)
    if (!READ_COMMANDS.has(keyword)) {
      return {
        ok: false,
        reason:
          `"${keyword || '?'}" is not a read-only statement. The agent may run SELECT, WITH, ` +
          'VALUES, TABLE, SHOW or EXPLAIN; stage writes and DDL with set_active_query or ' +
          'open_query_tab and run them in pgDEV yourself (or enable "Allow AI writes" on this ' +
          'connection in pgDEV).',
      }
    }
    const blocked = blockedCall(stmt)
    if (blocked) {
      return {
        ok: false,
        reason:
          `${blocked}() acts outside the agent's read-only transaction, so the agent may not call it. ` +
          'Stage the statement with set_active_query or open_query_tab and let the user run it.',
      }
    }
    if (hasLockingClause(stmt)) {
      return {
        ok: false,
        reason: 'Row-locking clauses (FOR UPDATE/SHARE) cannot run in the agent\'s read-only session.',
      }
    }
  }
  return { ok: true }
}

// Write mode: the batch is one transaction pgDEV commits only when every
// statement succeeded (runAgentWriteBatch). The agent may not end or split it,
// change session settings (SET ROLE, SET statement_timeout, RESET ALL), or
// start COPY, which needs a client stream.
// Statements PostgreSQL refuses inside a transaction block (VACUUM, CREATE
// DATABASE, ... CONCURRENTLY, ALTER SYSTEM) fail on their own.
const WRITE_REFUSED = new Set([
  'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE',
  'SET', 'RESET', 'DISCARD', 'COPY',
])

/** Check a batch the agent runs with write access on this connection. */
export function isAgentWriteSql(sql: string): ReadOnlyCheck {
  const statements = splitStatements(sql)
  if (!statements.length) return { ok: false, reason: 'The query is empty.' }
  for (const stmt of statements) {
    const keyword = firstKeyword(stmt)
    if (!keyword) return { ok: false, reason: 'Each statement must start with a SQL command.' }
    if (WRITE_REFUSED.has(keyword) || /^\s*PREPARE\s+TRANSACTION\b/i.test(maskLiterals(stmt))) {
      return {
        ok: false,
        reason:
          `"${keyword}" is not allowed for the agent. pgDEV runs each query call in one transaction ` +
          'and commits it when every statement succeeds; transaction control, SET/RESET, DISCARD and ' +
          'COPY are refused. Stage such scripts with set_active_query or open_query_tab.',
      }
    }
    const blocked = blockedCall(stmt)
    if (blocked) {
      return {
        ok: false,
        reason:
          `${blocked}() acts outside the agent's transaction, so the agent may not call it. ` +
          'Stage the statement with set_active_query or open_query_tab and let the user run it.',
      }
    }
  }
  return { ok: true }
}
