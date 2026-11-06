import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import { getPool } from '../pools.js'
import { fetchRowEditInfo } from '../catalog/rowedit.js'
import { planRowDelete, planRowInsert, planRowUpdate, type RowInsertError, type RowUpdateError } from '../rowupdate.js'
import { rawTextTypes } from '../pgtypes.js'
import { guardCheckedOutClient } from '../checkout.js'
import { pgErrorMessage } from '../pgerror.js'
import { sessionKey, getSession, beginSession, finishSession, parseTransactionId, assertTransaction, transactionState } from '../sessions.js'
import { normalizeCell, shiftPagingOffset } from '../queryexec.js'
import type { RowDeleteRequest, RowInsertRequest, RowUpdateRequest } from '../schema-types.js'

// Row-editor endpoints: one row, one UPDATE / INSERT / DELETE. Everything is
// re-validated against a fresh catalog read here — the browser's editable
// metadata is advisory. When the tab has an open manual transaction, the
// statement runs on that session's client so the user's COMMIT/ROLLBACK
// governs it; otherwise it is a single autocommit statement.

interface UpdateBody {
  tabKey?: unknown
  schema?: unknown
  table?: unknown
  key?: unknown
  set?: unknown
  transactionId?: unknown
}

type RunResult =
  | { kind: 'ok'; row: Record<string, unknown> }
  | { kind: 'not-found' }

function invalid(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseBody(body: unknown): RowUpdateRequest {
  if (!isRecord(body)) throw invalid('Invalid request body')
  const { tabKey, schema, table, key, set, transactionId } = body
  if (typeof schema !== 'string' || !schema || schema.length > 255) {
    throw invalid('schema is required')
  }
  if (typeof table !== 'string' || !table || table.length > 255) {
    throw invalid('table is required')
  }
  if (tabKey !== undefined && typeof tabKey !== 'string') throw invalid('Invalid tab key')
  if (!isRecord(key) || !isRecord(set)) throw invalid('key and set must be objects')
  for (const column of [...Object.keys(key), ...Object.keys(set)]) {
    if (column.length > 255) throw invalid('Invalid column name')
  }
  return { tabKey: tabKey ?? '', schema, table, key, set, transactionId: parseTransactionId(transactionId) }
}

function planError(error: RowUpdateError): Error {
  switch (error.kind) {
    case 'key-mismatch':
      return invalid(`The row key must be exactly the primary key (${error.expected.join(', ')})`)
    case 'no-key':
      return invalid(`Missing primary key value for "${error.column}"`)
    case 'no-values':
      return invalid('No values to update')
    case 'unknown-column':
      return invalid(`Unknown column "${error.column}"`)
    case 'locked-column':
      return invalid(`Column "${error.column}" cannot be updated`)
    case 'bad-value':
      return invalid(`Invalid value for "${error.column}"`)
  }
}

function storedRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) out[column] = normalizeCell(value)
  return out
}

async function runUpdate(client: PoolClient, request: RowUpdateRequest): Promise<RunResult> {
  const info = await fetchRowEditInfo(client, request)
  if (!info) throw invalid('Table not found or not row-editable')
  if (!info.pk.length) throw invalid('The table has no primary key')
  const planned = planRowUpdate(request, info)
  if (planned.kind === 'error') throw planError(planned.error)

  let res
  try {
    res = await client.query({
      text: planned.text,
      values: planned.values,
      types: rawTextTypes,
    })
  } catch (err) {
    throw Object.assign(new Error(pgErrorMessage(err, 'Update failed')), { statusCode: 400 })
  }
  const row = res.rows[0]
  if (!row) return { kind: 'not-found' }
  return { kind: 'ok', row: storedRow(row) }
}

/**
 * Run one row operation for a tab: on the tab's open transaction (so the
 * user's COMMIT/ROLLBACK governs it) or as a single autocommit statement on a
 * pooled client. `work` receives the client and whether a transaction session
 * is in use; its errors carry the tab's transaction state to the client.
 */
async function onTabClient<T>(
  reply: FastifyReply,
  id: string,
  tabKey: string,
  transactionId: string | null | undefined,
  work: (client: PoolClient, inTransaction: boolean) => Promise<T>,
): Promise<T | FastifyReply> {
  const pool = getPool(id)
  const runKey = sessionKey(id, tabKey)
  assertTransaction(runKey, transactionId)
  const active = getSession(runKey)
  const sess = active ? beginSession(runKey) : undefined
  if (active && !sess) {
    return reply.code(409).send({ error: 'A query is already running for this tab', ...transactionState(runKey) })
  }
  const client = sess?.client ?? await pool.connect()
  if (!sess) guardCheckedOutClient(client)
  try {
    // Recheck after a potentially queued checkout, before anything runs.
    if (!sess) assertTransaction(runKey, transactionId)
    return await work(client, !!sess)
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), transactionState(runKey))
  } finally {
    // Keep an open (possibly aborted) user transaction for COMMIT/ROLLBACK.
    if (sess) await finishSession(runKey, sess, 'keep')
    else client.release()
  }
}

/** A fresh, row-editable catalog read with a primary key, or a 400. */
async function editableInfo(client: PoolClient, target: { schema: string; table: string }) {
  const info = await fetchRowEditInfo(client, target)
  if (!info) throw invalid('Table not found or not row-editable')
  if (!info.pk.length) throw invalid('The table has no primary key')
  return info
}

async function runPlanned(client: PoolClient, text: string, values: unknown[], failure: string) {
  try {
    return await client.query({ text, values, types: rawTextTypes })
  } catch (err) {
    throw Object.assign(new Error(pgErrorMessage(err, failure)), { statusCode: 400 })
  }
}

function parseTarget(body: Record<string, unknown>) {
  const { tabKey, schema, table, transactionId } = body
  if (typeof schema !== 'string' || !schema || schema.length > 255) throw invalid('schema is required')
  if (typeof table !== 'string' || !table || table.length > 255) throw invalid('table is required')
  if (tabKey !== undefined && typeof tabKey !== 'string') throw invalid('Invalid tab key')
  return { tabKey: (tabKey as string | undefined) ?? '', schema, table, transactionId: parseTransactionId(transactionId) }
}

function parseColumns(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${what} must be an object`)
  for (const column of Object.keys(value)) if (column.length > 255) throw invalid('Invalid column name')
  return value
}

function parseInsert(body: unknown): RowInsertRequest {
  if (!isRecord(body)) throw invalid('Invalid request body')
  return { ...parseTarget(body), set: parseColumns(body.set, 'set') }
}

function parseDelete(body: unknown): RowDeleteRequest {
  if (!isRecord(body)) throw invalid('Invalid request body')
  if (body.paged !== undefined && typeof body.paged !== 'boolean') throw invalid('Invalid paged flag')
  return { ...parseTarget(body), key: parseColumns(body.key, 'key'), paged: body.paged === true }
}

function insertError(error: RowInsertError): Error {
  switch (error.kind) {
    case 'unknown-column':
      return invalid(`Unknown column "${error.column}"`)
    case 'locked-column':
      return invalid(`Column "${error.column}" cannot be written`)
    case 'bad-value':
      return invalid(`Invalid value for "${error.column}"`)
  }
}

export async function rowUpdateRoutes(app: FastifyInstance) {
  app.post('/api/connections/:id/row-update', async (req, reply) => {
    const { id } = req.params as { id: string }
    const request = parseBody(req.body)
    const runKey = sessionKey(id, request.tabKey)
    return onTabClient(reply, id, request.tabKey, request.transactionId, async (client) => {
      const result = await runUpdate(client, request)
      if (result.kind === 'not-found') {
        return reply.code(404).send({ error: 'Row not found — it may have been deleted; re-run the query.', ...transactionState(runKey) })
      }
      return { row: result.row, ...transactionState(runKey) }
    })
  })

  app.post('/api/connections/:id/row-insert', async (req, reply) => {
    const { id } = req.params as { id: string }
    const request = parseInsert(req.body)
    const runKey = sessionKey(id, request.tabKey)
    return onTabClient(reply, id, request.tabKey, request.transactionId, async (client) => {
      const planned = planRowInsert(request.set, await editableInfo(client, request))
      if (planned.kind === 'error') throw insertError(planned.error)
      const res = await runPlanned(client, planned.text, planned.values, 'Insert failed')
      return { row: storedRow(res.rows[0] ?? {}), ...transactionState(runKey) }
    })
  })

  app.post('/api/connections/:id/row-delete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const request = parseDelete(req.body)
    const runKey = sessionKey(id, request.tabKey)
    return onTabClient(reply, id, request.tabKey, request.transactionId, async (client, inTransaction) => {
      const planned = planRowDelete(request.key, await editableInfo(client, request))
      if (planned.kind === 'error') throw planError(planned.error)
      const res = await runPlanned(client, planned.text, planned.values, 'Delete failed')
      const row = res.rows[0]
      if (!row) {
        return reply.code(404).send({ error: 'Row not found — it may already be deleted; re-run the query.', ...transactionState(runKey) })
      }
      // Only a committed delete changes what the next page's replay sees.
      if (request.paged && !inTransaction) shiftPagingOffset(id, request.tabKey, -1)
      return { row: storedRow(row), ...transactionState(runKey) }
    })
  })
}
