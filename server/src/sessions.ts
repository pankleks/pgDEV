import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { cancelClientQuery } from './pgcancel.js'
import { releaseClean } from './pools.js'
import type { TransactionState } from './schema-types.js'

// Per-tab sessions: a user-opened transaction (BEGIN without COMMIT) pins its
// pooled client to the tab until the user ends it, the tab closes, the
// connection drops or the idle reaper rolls it back (plus an
// idle_in_transaction_session_timeout backstop in PG). Paging never holds a
// session: it replays the query (see fetchNextPage in queryexec.ts).

export const SESSION_IDLE_MS = 5 * 60 * 1000

interface Session {
  connId: string
  client: PoolClient
  transactionId: string
  timer: NodeJS.Timeout | null
  busy: boolean
  closeRequested: boolean
}

const sessions = new Map<string, Session>()

export function sessionKey(connId: string, tabKey: string): string {
  return `${connId}|${tabKey ?? ''}`
}

export function getSession(key: string): Session | undefined {
  return sessions.get(key)
}

export function transactionState(key: string): TransactionState {
  const s = sessions.get(key)
  const transactionId = s && !s.closeRequested ? s.transactionId : null
  return { transactionId, transactionOpen: transactionId !== null }
}

export function parseTransactionId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value
  throw Object.assign(new Error('Invalid transaction id'), { statusCode: 400 })
}

/** Omitted by legacy/internal callers; the browser always sends its expectation. */
export function assertTransaction(key: string, expected: string | null | undefined): void {
  if (expected === undefined) return
  const current = transactionState(key)
  if (current.transactionId !== expected) {
    throw Object.assign(new Error('The tab transaction ended or changed. Nothing was executed; review the transaction state before retrying.'), {
      statusCode: 409, code: 'TRANSACTION_CHANGED', ...current,
    })
  }
}

function armReaper(key: string, s: Session): void {
  if (s.timer) clearTimeout(s.timer)
  const t = setTimeout(() => {
    void teardownSession(key, 'rollback')
  }, SESSION_IDLE_MS)
  if (typeof t.unref === 'function') t.unref()
  s.timer = t
}

/** Pin `client` to the tab as its open user transaction and arm the reaper. */
export function setSession(key: string, connId: string, client: PoolClient): void {
  const prev = sessions.get(key)
  if (prev?.timer) clearTimeout(prev.timer)
  const s: Session = { connId, client, transactionId: randomUUID(), timer: null, busy: false, closeRequested: false }
  sessions.set(key, s)
  armReaper(key, s)
}

export function beginSession(key: string): Session | undefined {
  const s = sessions.get(key)
  if (!s || s.busy) return undefined
  s.busy = true
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  return s
}

async function releaseSession(key: string, s: Session, mode: 'commit' | 'rollback' | 'none'): Promise<void> {
  if (sessions.get(key) !== s) return
  sessions.delete(key)
  if (s.timer) clearTimeout(s.timer)
  let commitError: unknown
  if (mode !== 'none') {
    try {
      await s.client.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK')
    } catch (err) {
      if (mode === 'commit') {
        commitError = err
        try {
          await s.client.query('ROLLBACK')
        } catch {
          // The connection may already be gone; report the commit failure.
        }
      }
      // Rollback may already be gone (cancel, error, or reaper race).
    }
  }
  // The user's transaction may have changed role, settings or temp tables.
  await releaseClean(s.client)
  if (commitError) throw commitError
}

export async function finishSession(
  key: string,
  s: Session,
  mode: 'keep' | 'commit' | 'rollback' | 'none',
): Promise<void> {
  if (sessions.get(key) !== s) return
  if (mode === 'keep' && !s.closeRequested) {
    s.busy = false
    armReaper(key, s)
    return
  }
  await releaseSession(key, s, s.closeRequested || mode === 'keep' ? 'rollback' : mode)
}

/** Idempotent: safe to call twice or on an already-released client. */
export async function teardownSession(
  key: string,
  mode: 'commit' | 'rollback',
): Promise<void> {
  const s = sessions.get(key)
  if (!s) return
  if (s.busy) {
    s.closeRequested = true
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    return
  }
  await releaseSession(key, s, mode)
}

/** Tabs of a connection currently holding an open transaction (each pins a client). */
export function openTransactionCount(connId: string): number {
  let count = 0
  for (const s of sessions.values()) if (s.connId === connId) count++
  return count
}

export async function closeSessionsForConnection(connId: string): Promise<void> {
  const keys = [...sessions.keys()].filter((k) => sessions.get(k)?.connId === connId)
  await Promise.all(
    keys.map(async (key) => {
      const s = sessions.get(key)
      if (s?.busy) cancelClientQuery(s.client)
      await teardownSession(key, 'rollback')
    }),
  )
}

/** Drop sessions pinned to a dead pool client (see pool 'error' handler). */
export async function closeSessionsForClient(client: PoolClient): Promise<void> {
  const keys = [...sessions.keys()].filter((k) => sessions.get(k)?.client === client)
  await Promise.all(keys.map((k) => teardownSession(k, 'rollback')))
}
