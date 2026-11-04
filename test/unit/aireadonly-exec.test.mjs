import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runReadOnlyBatch } from '../../server/dist/queryexec.js'
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
      if (text === 'BEGIN READ ONLY') state.status = 'T'
      if (text === 'ROLLBACK') state.status = 'I'
      if (text === 'DISCARD ALL' && state.status !== 'I') throw new Error('DISCARD ALL cannot run inside a transaction block')
      if (text.startsWith('SELECT oid::text')) return { rows: [{ oid: '23', name: 'integer' }] }
      if (typeof query.emit === 'function') {
        const command = tags[text] ?? 'SELECT'
        if (command === 'COMMIT') state.status = 'I'
        const fields = command === 'SELECT' ? [{ name: 'n', tableID: 0, dataTypeID: 23, dataTypeModifier: -1 }] : []
        queueMicrotask(() => {
          if (fields.length) query.emit('row', [1])
          query.emit('end', { fields, rows: [], command })
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

async function run(id, sql, tags) {
  const fake = fakePool(tags)
  setPool(id, fake.pool)
  try {
    return { outcome: await runReadOnlyBatch(id, 'ai', sql, 10), ...fake }
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
