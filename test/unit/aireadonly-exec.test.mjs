import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runReadOnlyBatch, runAgentWriteBatch } from '../../server/dist/queryexec.js'
import { setPool, removePool } from '../../server/dist/pools.js'

// The agent's executor must not depend on the classifier's split: a statement
// the server treats as COMMIT ends the batch, every statement goes over the
// extended protocol, and the transaction is always rolled back.

/** A fake client that tracks the server's transaction status. `tags` maps a
 * statement to the command tag the "server" reports for it. */
function fakePool(tags = {}) {
  const executed = []
  const state = { releases: [], status: 'I' }
  const client = {
    connection: new EventEmitter(),
    on() {},
    removeListener() {},
    getTransactionStatus: () => state.status,
    query(query, values) {
      const text = typeof query === 'string' ? query : query.text
      executed.push({ text, extended: query?.queryMode === 'extended', values })
      if (text === 'SHOW standard_conforming_strings') {
        return { fields: [], rows: [{ standard_conforming_strings: 'on' }], command: 'SHOW' }
      }
      if (text === 'BEGIN READ ONLY' || text === 'BEGIN') state.status = 'T'
      if (text === 'ROLLBACK' || text === 'COMMIT') state.status = 'I'
      if (text === 'DISCARD ALL' && state.status !== 'I') throw new Error('DISCARD ALL cannot run inside a transaction block')
      if (text.startsWith('SELECT oid::text')) return { rows: [{ oid: '23', name: 'integer' }] }
      if (typeof query.emit === 'function') {
        const command = tags[text] ?? 'SELECT'
        if (command === 'ERROR') {
          state.status = 'E'
          queueMicrotask(() => query.emit('error', new Error('boom')))
          return { fields: [], rows: [], command: 'OK' }
        }
        if (command === 'COMMIT') state.status = 'I'
        const fields = command === 'SELECT' ? [{ name: 'n', tableID: 0, dataTypeID: 23, dataTypeModifier: -1 }] : []
        queueMicrotask(() => {
          if (fields.length) query.emit('row', [1])
          query.emit('end', { fields, rows: [], command, rowCount: fields.length ? 1 : 2 })
        })
      }
      return { fields: [], rows: [], command: 'OK' }
    },
    release(destroy) {
      state.releases.push(destroy)
    },
  }
  return { executed, state, pool: { async connect() { return client }, async end() {} } }
}

async function run(id, sql, tags, runner = runReadOnlyBatch) {
  const fake = fakePool(tags)
  setPool(id, fake.pool)
  try {
    return { outcome: await runner(id, 'ai', sql, 10), ...fake }
  } finally {
    removePool(id)
  }
}

test('reads run one statement per extended-protocol call in a rolled-back read-only transaction', async () => {
  const { outcome, executed, state } = await run('ro-ok', 'SELECT 1; SELECT 2')
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.results.length, 2)
  assert.deepEqual(outcome.results[0].columnTypes, ['integer'])
  const texts = executed.map((e) => e.text)
  assert.ok(texts.indexOf('BEGIN READ ONLY') < texts.indexOf('SELECT 1'))
  assert.deepEqual(texts.slice(-2), ['ROLLBACK', 'DISCARD ALL'])
  assert.ok(!texts.includes('COMMIT'))
  for (const e of executed.filter((e) => /^SELECT [12]$/.test(e.text))) assert.equal(e.extended, true)
  assert.deepEqual(state.releases, [false])
})

test('a statement the server reports as COMMIT stops the batch before the next one runs', async () => {
  // Simulates a classifier/server lexing disagreement: the gate saw a read,
  // the server ran a COMMIT.
  const { outcome, executed } = await run('ro-commit', 'SELECT 1; SELECT disguised; SELECT 3', { 'SELECT disguised': 'COMMIT' })
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.error.message, /not a read/)
  const texts = executed.map((e) => e.text)
  assert.ok(!texts.includes('SELECT 3'), 'nothing may run after the transaction ended')
  assert.deepEqual(texts.slice(-2), ['ROLLBACK', 'DISCARD ALL'])
})

test('a non-read command tag inside the transaction also stops the batch', async () => {
  const { outcome, executed } = await run('ro-tag', 'SELECT x; SELECT 2', { 'SELECT x': 'SET' })
  assert.equal(outcome.kind, 'error')
  assert.ok(!executed.some((e) => e.text === 'SELECT 2'))
})

test('statements are re-classified as executed, not only by the up-front gate', async () => {
  const { outcome, executed } = await run('ro-gate', 'SELECT 1; DELETE FROM t')
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.error.message, /read-only/)
  assert.ok(!executed.some((e) => e.text.startsWith('DELETE')))
})

// Write mode ("Allow AI writes"): one read-write transaction per call,
// committed only after every statement succeeded.

const WRITE_TAGS = { 'INSERT INTO t VALUES (1)': 'INSERT', 'UPDATE t SET a = 1': 'UPDATE' }

test('a write batch runs in one transaction and commits after the last statement', async () => {
  const { outcome, executed, state } = await run('rw-ok', 'INSERT INTO t VALUES (1); SELECT 1; UPDATE t SET a = 1', WRITE_TAGS, runAgentWriteBatch)
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
  assert.deepEqual(outcome.results.map((r) => r.kind === 'data' ? 'data' : `${r.command} ${r.rowCount}`),
    ['INSERT 2', 'data', 'UPDATE 2'])
  const texts = executed.map((e) => e.text)
  assert.equal(texts.indexOf('BEGIN READ ONLY'), -1)
  assert.ok(texts.indexOf('BEGIN') < texts.indexOf('INSERT INTO t VALUES (1)'))
  assert.ok(texts.indexOf('COMMIT') > texts.indexOf('UPDATE t SET a = 1'))
  assert.deepEqual(state.releases, [false])
})

test('a failing statement rolls the whole write batch back and nothing commits', async () => {
  const { outcome, executed } = await run('rw-fail', 'INSERT INTO t VALUES (1); UPDATE t SET a = 1; SELECT 3',
    { ...WRITE_TAGS, 'UPDATE t SET a = 1': 'ERROR' }, runAgentWriteBatch)
  assert.equal(outcome.kind, 'error')
  const texts = executed.map((e) => e.text)
  assert.ok(!texts.includes('COMMIT'))
  assert.ok(!texts.includes('SELECT 3'))
  assert.deepEqual(texts.slice(-2), ['ROLLBACK', 'DISCARD ALL'])
})

test('a write batch refuses transaction control before anything after it runs', async () => {
  const { outcome, executed } = await run('rw-commit', 'INSERT INTO t VALUES (1); COMMIT; UPDATE t SET a = 1', WRITE_TAGS, runAgentWriteBatch)
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.error.message, /not allowed for the agent/)
  const texts = executed.map((e) => e.text)
  assert.ok(!texts.includes('COMMIT'))
  assert.ok(!texts.includes('UPDATE t SET a = 1'))
})

test('a statement the server reports as ending the transaction stops a write batch uncommitted', async () => {
  const { outcome, executed } = await run('rw-disguised', 'INSERT INTO t VALUES (1); SELECT disguised; UPDATE t SET a = 1',
    { ...WRITE_TAGS, 'SELECT disguised': 'COMMIT' }, runAgentWriteBatch)
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.error.message, /ended the agent's transaction/)
  assert.ok(!executed.some((e) => e.text === 'UPDATE t SET a = 1'))
})
