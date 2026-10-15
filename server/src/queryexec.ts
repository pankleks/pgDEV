import type { PoolClient } from 'pg'
import { getPool, setRunning, getRunning, deleteRunning, runningKeysForConnection } from './pools.js'
import { rawTextTypes } from './pgtypes.js'
import { cancelClientQuery } from './pgcancel.js'
import { guardCheckedOutClient } from './checkout.js'
import { nextStatement, splitStatementsWithOffsets } from './sqlsplit.js'
import { observeSqlState, standardConformingStrings } from './sqlstate.js'
import { boundedQuery } from './boundedquery.js'
import { pgErrorMessage } from './pgerror.js'
import { plainSelectTable } from './selectshape.js'
import { fetchRowEditInfo, editableGrid } from './catalog/rowedit.js'
import { typeLength } from './typelength.js'
import { explainSql } from './explain.js'
import type { EditableGrid } from './schema-types.js'
import {
  transactionControl,
  hasOpenTransaction,
  canUseCursor,
  requiresAutocommit,
} from './queryshape.js'
import {
  sessionKey,
  getSession,
  setSession,
  beginSession,
  finishSession,
  teardownSession,
  assertTransaction,
} from './sessions.js'

// Per-tab operation generations: every runBatch run bumps the tab's counter,
// so a close that lands mid-operation can invalidate exactly that
// operation's session-retention decision (see closeTabSession).
const operationGeneration = new Map<string, number>()
const closedGeneration = new Map<string, number>()

// Only query text and an offset survive between pages — never a client or lock.
interface PagingQuery {
  sql: string
  offset: number
  fields: FieldInfo[]
  searchPath: string
  stringMode: string
  role: string
  busy: boolean
}
const pagingQueries = new Map<string, PagingQuery>()

// Batch execution engine, extracted from the Fastify route so HTTP concerns
// (status codes, reply shapes) stay in routes/query.ts and client ownership
// lives in exactly one place: from checkout to release, the client is owned
// either by this function (request-owned) or by an explicit transaction.

export interface MappedCommand {
  kind: 'command'
  command: string
  rowCount: number
}

export interface MappedData {
  kind: 'data'
  columns: string[]
  columnTypes: string[]
  columnTypeLengths: (number | null)[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  limited: boolean
  totalRowCount?: number
  editable?: EditableGrid
}

export type MappedResult = MappedCommand | MappedData

export type BatchError =
  | { kind: 'empty' }
  | { kind: 'running' }
  | { kind: 'connect'; message: string }
  | { kind: 'no-more' }
  | { kind: 'sql'; message: string; position: string | null; code: string | null }

export type BatchOutcome =
  | { kind: 'ok'; results: MappedResult[]; durationMs: number; transactionOpen: boolean }
  | { kind: 'error'; error: BatchError }

export type MoreOutcome =
  | { kind: 'ok'; rows: unknown[][]; rowCount: number; truncated: boolean }
  | { kind: 'error'; error: BatchError }

export function normalizeCell(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return `<bytea ${v.length} bytes>`
  if (typeof v === 'object' && v !== null && !(v instanceof Date)) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return v
}

interface FieldInfo {
  name: string
  tableID: number
  dataTypeID: number
  dataTypeModifier: number
}

interface DataPage {
  fields: FieldInfo[]
  rows: unknown[][]
  hasMore: boolean
  limited?: boolean
  totalRowCount?: number
}

async function fetchRows(
  client: PoolClient,
  cursor: string,
  count: number,
): Promise<{ fields: FieldInfo[]; rows: unknown[][] }> {
  const res = await client.query({
    // Cursor names are server-generated (`pgdev_cur_N`), never user input.
    text: `FETCH FORWARD ${count} FROM "${cursor}"`,
    rowMode: 'array',
    types: rawTextTypes,
  })
  return {
    fields: (res.fields ?? []) as FieldInfo[],
    rows: res.rows
      .map((row: unknown[]) => row.map((cell) => normalizeCell(cell))),
  }
}

async function fetchPage(
  client: PoolClient,
  cursor: string,
  cap: number,
): Promise<DataPage> {
  const fetched = await fetchRows(client, cursor, cap + 1)
  const hasMore = fetched.rows.length > cap
  return {
    fields: fetched.fields,
    rows: fetched.rows.slice(0, cap),
    hasMore,
  }
}

async function closeCursor(
  client: PoolClient,
  cursor: string,
): Promise<void> {
  try {
    await client.query(`CLOSE "${cursor}"`)
  } catch {
    // Cursor may already be gone (error/cancel race) — teardown handles it.
  }
}

async function typeNamesFor(
  client: PoolClient,
  pages: DataPage[],
): Promise<Map<string, string>> {
  const typeIds = [
    ...new Set(pages.flatMap((p) => p.fields.map((f) => f.dataTypeID))),
  ]
  const typeNames = new Map<string, string>()
  if (!typeIds.length) return typeNames
  // Same client: no extra pool slot, so concurrent tabs can't starve.
  const tres = await client.query(
    `SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY ($1::oid[])`,
    [typeIds],
  )
  for (const t of tres.rows) typeNames.set(t.oid, t.name)
  return typeNames
}

const sqlError = (err: unknown, baseOffset = 0): BatchError => {
  const e = err as Error & { position?: string; code?: string }
  return {
    kind: 'sql',
    message: pgErrorMessage(err, 'Query failed'),
    position: toGlobalPosition(e.position, baseOffset),
    code: e.code ?? null,
  }
}

/**
 * Map a PostgreSQL 1-based statement-local error offset to a 1-based offset
 * in the submitted batch. `baseOffset` is the 0-based start of the trimmed
 * statement within the batch, so global = base + local. Returns null when
 * there is nothing meaningful to point at (no position, non-numeric, FETCH
 * failures whose position is relative to internal FETCH text).
 */
function toGlobalPosition(
  position: string | null | undefined,
  baseOffset: number,
): string | null {
  if (position == null) return null
  const local = Number(position)
  if (!Number.isFinite(local)) return null
  const floored = Math.floor(local)
  if (floored < 1) return null
  if (!Number.isFinite(baseOffset) || baseOffset < 0) return null
  return String(Math.floor(baseOffset) + floored)
}

/** A per-statement failure already mapped to batch-relative coordinates. */
interface MappedStatementError {
  __pgdevMapped: true
  error: BatchError
}

function mappedStatementError(err: unknown, baseOffset: number | null): MappedStatementError {
  return {
    __pgdevMapped: true,
    error:
      baseOffset === null
        ? { kind: 'sql', message: pgErrorMessage(err, 'Query failed'), position: null, code: (err as { code?: string })?.code ?? null }
        : sqlError(err, baseOffset),
  }
}

function isMappedStatementError(err: unknown): err is MappedStatementError {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as MappedStatementError).__pgdevMapped === true &&
    !!(err as MappedStatementError).error
  )
}

/** Transaction state shared with the statement loop, so a failure mid-batch
 * knows whether a transaction is still open. */
interface TxnState {
  inTxn: boolean
  userManaged: boolean
}

/**
 * Execute the batch's statements on one client, resolving result metadata on
 * the same client. Cursor DECLARE is attempted only for the final statement
 * (and only when the caller allows cursors); `txn` tracks user-typed
 * transaction control so the caller knows what to keep or close.
 */
async function executeStatements(
  client: PoolClient,
  sql: string,
  cap: number,
  useCursors: boolean,
  txn: TxnState,
): Promise<{ mapped: MappedResult[]; openCursor: string | null; fields: FieldInfo[] }> {
  const results: (
    | { kind: 'command'; command: string; rowCount: number }
    | { kind: 'data'; page: DataPage }
  )[] = []
  let seq = 0
  let openCursor: string | null = null
  const statements: string[] = []

  // Direct execution for non-cursor statements. Throws on error so the batch
  // aborts with the statement's real message (never masked). Also tracks
  // user-typed transaction control (COMMIT/ROLLBACK/END).
  const execDirect = async (stmt: string): Promise<void> => {
    const control = transactionControl(stmt)
    const bounded = await boundedQuery(client, stmt, cap)
    const res = bounded.result
    if (control === 'end' || control === 'chain') {
      // Ends the transaction server-side, taking any open cursor with it.
      openCursor = null
    }
    if (control === 'end') {
      txn.inTxn = false
      txn.userManaged = false
    }
    if (control === 'start' || control === 'chain') {
      txn.inTxn = true
      txn.userManaged = true
    }
    if (!res.fields || res.fields.length === 0) {
      results.push({
        kind: 'command',
        command: res.command ?? 'OK',
        rowCount: res.rowCount ?? 0,
      })
    } else {
      const rows = bounded.rows.map((row: unknown[]) =>
        row.map((cell) => normalizeCell(cell)),
      )
      results.push({
        kind: 'data',
        page: {
          fields: (res.fields ?? []) as FieldInfo[],
          rows,
          hasMore: false,
          limited: bounded.totalRowCount > cap,
          totalRowCount: bounded.totalRowCount,
        },
      })
    }
  }

  let offset = 0
  while (true) {
    const mode = standardConformingStrings(client)
    const part = nextStatement(sql, offset, mode)
    if (!part) break
    offset = part.end
    const stmt = part.text
    statements.push(stmt)
    const cursor = `pgdev_cur_${++seq}`
    const cursorForThisStatement = useCursors && !txn.userManaged && canUseCursor(stmt) && !nextStatement(sql, offset, mode)
    const base = part.start
    if (!txn.inTxn || !cursorForThisStatement) {
      try {
        await execDirect(stmt)
      } catch (err) {
        throw mappedStatementError(err, base)
      }
      continue
    }
    await client.query('SAVEPOINT pgdev_sp')
    try {
      await client.query(`DECLARE "${cursor}" NO SCROLL CURSOR FOR ${stmt}`)
    } catch (declareError) {
      // Not a cursor-compatible statement (DDL, writes, EXPLAIN, …):
      // roll back to the savepoint so the failed DECLARE doesn't poison
      // the transaction, then run it directly. The retried error is
      // statement-relative (no DECLARE prefix to subtract), so map that one.
      try {
        await client.query('ROLLBACK TO SAVEPOINT pgdev_sp')
      } catch {
        throw mappedStatementError(declareError, base)
      }
      try {
        await execDirect(stmt)
      } catch (err) {
        throw mappedStatementError(err, base)
      }
      continue
    }
    // A FETCH failure is a query failure, not evidence that the statement
    // should be executed again without a cursor. Its position (if any) is
    // relative to the internal FETCH text, so it maps to null.
    let page: DataPage
    try {
      page = await fetchPage(client, cursor, cap)
    } catch (err) {
      throw mappedStatementError(err, null)
    }
    if (page.hasMore) {
      // Only the last result set is pageable in the UI; earlier
      // truncated cursors are closed (their counts stay in Messages).
      if (openCursor) await closeCursor(client, openCursor)
      openCursor = cursor
    } else {
      await closeCursor(client, cursor)
    }
    results.push({ kind: 'data', page })
  }

  const typeNames = await typeNamesFor(
    client,
    results.flatMap((r) => (r.kind === 'data' ? [r.page] : [])),
  )
  const mapped: MappedResult[] = results.map((r) => {
    if (r.kind === 'command') {
      return { kind: 'command' as const, command: r.command, rowCount: r.rowCount }
    }
    return {
      kind: 'data' as const,
      columns: r.page.fields.map((f) => f.name),
      columnTypes: r.page.fields.map((f) => typeNames.get(String(f.dataTypeID)) ?? ''),
      columnTypeLengths: r.page.fields.map((f) =>
        typeLength(typeNames.get(String(f.dataTypeID)) ?? '', f.dataTypeModifier),
      ),
      rows: r.page.rows,
      rowCount: r.page.rows.length,
      truncated: r.page.hasMore,
      limited: r.page.limited ?? false,
      totalRowCount: r.page.totalRowCount,
    }
  })
  const last = results[results.length - 1]

  // Row-editing metadata: results are 1:1 with statements, so each data
  // result can consult its own statement's shape. This is advisory only —
  // a catalog failure costs the edit buttons, never the query result.
  for (const [index, statement] of statements.entries()) {
    const mappedResult = mapped[index]
    if (mappedResult?.kind !== 'data') continue
    const source = plainSelectTable(statement)
    if (!source) continue
    // Resolve the relation that produced these fields, not the SQL name:
    // later statements may have changed search_path or replaced the table.
    const result = results[index]
    if (result?.kind !== 'data') continue
    const oid = result.page.fields[0]?.tableID
    if (!oid || result.page.fields.some((field) => field.tableID !== oid)) continue
    try {
      const info = await fetchRowEditInfo(client, { oid })
      if (!info) continue
      const editable = editableGrid(info, mappedResult.columns, source.columns)
      if (editable) mappedResult.editable = editable
    } catch {
      // Metadata only: leave the result without edit support.
    }
  }

  return {
    mapped,
    openCursor,
    fields: last?.kind === 'data' ? last.page.fields : [],
  }
}

/**
 * Continue a user-opened transaction on its pinned client. No implicit BEGIN
 * and no cursor paging: the user's COMMIT/ROLLBACK ends the session, and a
 * failed statement leaves the transaction open in PostgreSQL's aborted state
 * so the same ROLLBACK semantics as psql apply.
 */
async function runOnTransactionSession(
  connId: string,
  runKey: string,
  sql: string,
  cap: number,
): Promise<BatchOutcome> {
  if (getRunning(runKey)) return { kind: 'error', error: { kind: 'running' } }
  const sess = beginSession(runKey)
  if (!sess) return { kind: 'error', error: { kind: 'running' } }
  setRunning(runKey, sess.client)
  const start = performance.now()
  const txn: TxnState = { inTxn: true, userManaged: true }
  try {
    const { mapped } = await executeStatements(sess.client, sql, cap, false, txn)
    if (txn.inTxn) {
      await finishSession(runKey, sess, 'keep')
      return { kind: 'ok', results: mapped, durationMs: Math.round(performance.now() - start), transactionOpen: true }
    }
    // The user's COMMIT/ROLLBACK ran as part of the batch: hand the client
    // back without issuing another control statement.
    await finishSession(runKey, sess, 'none')
    return { kind: 'ok', results: mapped, durationMs: Math.round(performance.now() - start), transactionOpen: false }
  } catch (err) {
    // Keep an open (aborted) transaction so the user can roll back; if the
    // batch already ended it, there is nothing to keep.
    if (txn.inTxn) await finishSession(runKey, sess, 'keep')
    else await finishSession(runKey, sess, 'none')
    if (isMappedStatementError(err)) return { kind: 'error', error: err.error }
    return { kind: 'error', error: sqlError(err) }
  } finally {
    deleteRunning(runKey, sess.client)
  }
}

/** Options for one SQL batch (see routes/query.ts and routes/ai.ts). */
export interface BatchOptions {
  explain?: 'explain' | 'analyze'
  /** Expected transaction session id; null explicitly requires none. */
  transactionId?: string | null
  /** False for one-shot batches (agent reads): every result is bounded and no
   * paging state is retained — a mirrored result cannot page, so the
   * backend must not hold a pool slot for it. */
  pageable?: boolean
}

/** Execute a SQL batch for one tab. See routes/query.ts for the HTTP mapping. */
export async function runBatch(
  connId: string,
  tabKey: string,
  sql: string,
  cap: number,
  options: BatchOptions = {},
): Promise<BatchOutcome> {
  const transactionId = options.transactionId
  const pageable = options.pageable !== false
  if (!sql.trim()) return { kind: 'error', error: { kind: 'empty' } }
  const pool = getPool(connId)
  const runKey = sessionKey(connId, tabKey)
  const generation = (operationGeneration.get(runKey) ?? 0) + 1
  operationGeneration.set(runKey, generation)
  assertTransaction(runKey, transactionId)
  if (getRunning(runKey) || pagingQueries.get(runKey)?.busy) return { kind: 'error', error: { kind: 'running' } }
  pagingQueries.delete(runKey)

  // A user-opened transaction keeps its client pinned for the tab; continue it
  // instead of checking out a new one.
  const active = getSession(runKey)
  if (active?.kind === 'transaction') {
    if (options.explain) {
      try { sql = explainSql(sql, options.explain, standardConformingStrings(active.client)) }
      catch (err) { return { kind: 'error', error: sqlError(err) } }
    }
    if (!nextStatement(sql, 0, standardConformingStrings(active.client))) return { kind: 'error', error: { kind: 'empty' } }
    return runOnTransactionSession(connId, runKey, sql, cap)
  }

  // Clean up any prior non-transaction session.
  await teardownSession(runKey, 'rollback')

  const start = performance.now()
  let client: PoolClient
  try {
    client = await pool.connect()
  } catch (err) {
    return { kind: 'error', error: { kind: 'connect', message: pgErrorMessage(err) } }
  }
  // Checkout can wait: a different request may have opened a transaction meanwhile.
  try {
    assertTransaction(runKey, transactionId)
  } catch (err) {
    client.release()
    throw err
  }
  if (getRunning(runKey)) {
    client.release()
    return { kind: 'error', error: { kind: 'running' } }
  }
  // Pinned sessions hold this client for the life of the session; without a
  // listener a backend-side termination crashes the process (see checkout.ts).
  guardCheckedOutClient(client)

  // From here the client is owned either by the session map (kept open for
  // a user transaction) or released explicitly on every exit.
  let sessionKept = false
  const txn: TxnState = { inTxn: false, userManaged: false }
  setRunning(runKey, client)
  try {
    await observeSqlState(client)
    if (options.explain) sql = explainSql(sql, options.explain, standardConformingStrings(client))
    const statements = splitStatementsWithOffsets(sql, {
      standardConformingStrings: standardConformingStrings(client),
    }).map((part) => part.text)
    if (!statements.length) {
      client.release()
      return { kind: 'error', error: { kind: 'empty' } }
    }
    const autocommit = statements.some(requiresAutocommit)
    // User-opened transactions retain their client and are never committed
    // just to make a top-level command legal.
    const manual = hasOpenTransaction(statements)
    if (!autocommit && !manual) {
      await client.query('BEGIN')
      txn.inTxn = true
      // Backstop while executing the request, never between normal pages.
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '5min'`)
    }

    // Only the final statement may page. Its cursor closes before COMMIT.
    // Earlier results are bounded and drained. Manual transactions keep the
    // transaction, not paging state. One-shot batches (agent reads) never page:
    // their rows are mirrored to a tab whose key cannot reach this session.
    const useCursors = !options.explain && pageable && !autocommit && !manual && statements.every(canUseCursor)
    const { mapped, openCursor, fields } = await executeStatements(client, sql, cap, useCursors, txn)
    let paging: PagingQuery | null = null
    if (openCursor) {
      await closeCursor(client, openCursor)
      const settings = await client.query<{ search_path: string; string_mode: string; role: string }>(
        "SELECT current_setting('search_path') AS search_path, current_setting('standard_conforming_strings') AS string_mode, current_setting('role') AS role",
      )
      // Replay only the final SELECT, never earlier statements from the batch.
      const last = mapped.at(-1)
      paging = {
        sql: statements.at(-1)!, offset: last?.kind === 'data' ? last.rows.length : 0,
        fields, searchPath: settings.rows[0].search_path, stringMode: settings.rows[0].string_mode,
        role: settings.rows[0].role, busy: false,
      }
    }
    // A close that landed while this batch ran abandons the tab: nothing may
    // be kept, and the (possibly empty) transaction is rolled back instead of
    // committed. Consumed so a later run on the same tab retains normally.
    const abandoned = closedGeneration.get(runKey) === generation
    if (abandoned) closedGeneration.delete(runKey)

    if (!abandoned && txn.userManaged && txn.inTxn) {
      // A forgotten transaction must not pin this client forever: bound its
      // idle life server-side as a backstop to the session reaper.
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '5min'`)
      setSession(runKey, connId, client, null, null, 'transaction')
      sessionKept = true
    } else {
      if (txn.inTxn) {
        if (abandoned) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Connection already gone; release() will drop it.
          }
        } else {
          try {
            await client.query('COMMIT')
          } catch (err) {
            try {
              await client.query('ROLLBACK')
            } catch {
              // Transaction already gone.
            }
            throw err
          }
        }
      }
      client.release()
    }
    if (paging && !abandoned) pagingQueries.set(runKey, paging)
    return {
      kind: 'ok',
      results: mapped,
      durationMs: Math.round(performance.now() - start),
      transactionOpen: !openCursor && txn.userManaged && txn.inTxn && !abandoned,
    }
  } catch (err) {
    await teardownSession(runKey, 'rollback')
    if (!sessionKept) {
      // Error before any session was kept: the client may still hold the
      // open (possibly aborted) transaction — roll back explicitly so a
      // dirty client never returns to the pool.
      if (txn.inTxn) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // Connection already gone; release() will drop it.
        }
      }
      try {
        client.release()
      } catch {
        // Already released.
      }
    }
    if (isMappedStatementError(err)) return { kind: 'error', error: err.error }
    return { kind: 'error', error: sqlError(err) }
  } finally {
    deleteRunning(runKey, client)
  }
}

/** Rerun the SELECT for one page and commit before returning any rows. */
export async function fetchNextPage(
  connId: string,
  tabKey: string,
  cap: number,
): Promise<MoreOutcome> {
  const pool = getPool(connId)
  const runKey = sessionKey(connId, tabKey)
  if (getRunning(runKey)) return { kind: 'error', error: { kind: 'running' } }
  const paging = pagingQueries.get(runKey)
  if (!paging) {
    return { kind: 'error', error: { kind: 'no-more' } }
  }
  if (paging.busy) return { kind: 'error', error: { kind: 'running' } }
  paging.busy = true
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    guardCheckedOutClient(client)
    if (pagingQueries.get(runKey) !== paging) {
      return { kind: 'error', error: { kind: 'no-more' } }
    }
    setRunning(runKey, client)
    // A later page must never repeat writes hidden in a CTE or SELECT function.
    await client.query('BEGIN READ ONLY')
    await client.query("SELECT set_config('search_path', $1, true), set_config('standard_conforming_strings', $2, true), set_config('role', $3, true)",
      [paging.searchPath, paging.stringMode, paging.role])
    await client.query(`DECLARE "pgdev_page" NO SCROLL CURSOR FOR ${paging.sql}`)
    // ponytail: O(offset) replay; keyset paging needs a known unique sort key.
    await client.query(`MOVE FORWARD ${paging.offset} FROM "pgdev_page"`)
    const page = await fetchPage(client, 'pgdev_page', cap)
    const shape = (fields: FieldInfo[]) => fields.map((f) => [f.name, f.tableID, f.dataTypeID, f.dataTypeModifier])
    if (JSON.stringify(shape(page.fields)) !== JSON.stringify(shape(paging.fields))) {
      throw new Error('Result columns changed between pages. Re-run the query.')
    }
    await client.query('COMMIT')
    if (pagingQueries.get(runKey) === paging) {
      paging.offset += page.rows.length
      if (!page.hasMore) pagingQueries.delete(runKey)
    }
    return { kind: 'ok', rows: page.rows, rowCount: page.rows.length, truncated: page.hasMore }
  } catch (err) {
    if (pagingQueries.get(runKey) === paging) pagingQueries.delete(runKey)
    if (client) await client.query('ROLLBACK').catch(() => {})
    return { kind: 'error', error: sqlError(err) }
  } finally {
    paging.busy = false
    if (client) {
      deleteRunning(runKey, client)
      client.release()
    }
  }
}

/** Send a PostgreSQL cancel for the tab's running query, if any. */
export function cancelRunning(connId: string, tabKey: string): boolean {
  const running = getRunning(sessionKey(connId, tabKey))
  if (!running) return false
  cancelClientQuery(running)
  return true
}

/**
 * Cancel every query running on a connection, so disconnecting does not block
 * `pool.end()` on a request-owned (non-session) client until its statement
 * timeout fires. Sessions are handled separately by closeSessionsForConnection.
 */
export function cancelConnection(connId: string): void {
  for (const key of pagingQueries.keys()) if (key.startsWith(`${connId}|`)) pagingQueries.delete(key)
  for (const key of runningKeysForConnection(connId)) {
    const client = getRunning(key)
    if (client) cancelClientQuery(client)
  }
}

/**
 * Close a tab session: an idle one is released right away (rollback). While an
 * operation is running the release would race the FETCH/query using the
 * client, so the operation is canceled first — and the closing is recorded by
 * operation generation, so a close landing during the very batch that would
 * first create the session makes that batch abandon instead of retaining a
 * transaction (or cursor) for a tab that no longer exists.
 */
export async function closeTabSession(connId: string, tabKey: string): Promise<void> {
  getPool(connId)
  const key = sessionKey(connId, tabKey)
  pagingQueries.delete(key)
  const running = getRunning(key)
  if (running) cancelClientQuery(running)
  closedGeneration.set(key, operationGeneration.get(key) ?? 0)
  await teardownSession(key, 'rollback')
}
