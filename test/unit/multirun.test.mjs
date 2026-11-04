import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { createResults } = await load('web/composables/results.ts')
const { createMultiResults } = await load('web/composables/multirun.ts')
const profiles = ['First', 'Second', 'Offline'].map((name, index) => ({ id: `p${index}`, name, label: 'same', connectionString: 'postgres://localhost/db' }))

test('identical connection strings have isolated sessions/results; failure does not stop siblings', async () => {
  const connected = [], queried = [], disconnected = [], paged = [], cancelled = []
  const api = {
    connect: async config => {
      connected.push(config)
      if (connected.length === 3) throw new Error('Offline')
      return { id: `session${connected.length}` }
    },
    query: async (id, sql, key) => {
      queried.push({ id, sql, key })
      return { durationMs: 1, results: [{ kind: 'data', columns: ['id'], columnTypes: ['text'], rows: [[id]], rowCount: 1, truncated: true }] }
    },
    fetchMore: async (id, key) => { paged.push({ id, key }); return { rows: [['next']], truncated: false } },
    cancel: async (id, key) => { cancelled.push({ id, key }); return { ok: true } },
    disconnect: async id => { disconnected.push(id) },
  }
  const results = createResults(api)
  const multi = createMultiResults(results, api, assert.fail)
  await multi.run('tab', 'SELECT 42', profiles, 30)
  const entries = multi.state.byTab.tab.entries
  assert.equal(new Set(entries.map(e => e.key)).size, 3)
  assert.equal(queried.length, 2)
  assert.ok(queried.every(q => q.sql === 'SELECT 42'))
  assert.ok(connected.every(c => !('name' in c) && !('id' in c) && c.statementTimeout === 30))
  assert.deepEqual(results.state.byTab[entries[0].key].grid.rows, [['session1']])
  assert.equal(results.state.byTab[entries[2].key].messages[0].text, 'Offline')
  await results.loadMore(entries[1].key, entries[1].connectionId)
  assert.deepEqual(paged, [{ id: 'session2', key: entries[1].key }])
  results.state.byTab[entries[0].key].running = true
  await multi.cancel(entries[0])
  assert.deepEqual(cancelled, [{ id: 'session1', key: entries[0].key }])
  multi.release('tab')
  assert.deepEqual(disconnected.sort(), ['session1', 'session2'])
  assert.equal(multi.state.byTab.tab, undefined)
  assert.ok(entries.every(e => !results.state.byTab[e.key]))
})

test('closing or cancelling while connecting never executes SQL and closes late sessions', async () => {
  for (const cancel of [false, true]) {
    let finish
    const disconnected = []
    const api = {
      connect: () => new Promise(resolve => { finish = resolve }),
      query: assert.fail,
      disconnect: async id => { disconnected.push(id) },
    }
    const results = createResults(api)
    const multi = createMultiResults(results, api, assert.fail)
    const pending = multi.run('tab', 'DELETE FROM important', profiles.slice(0, 1), 30)
    const key = multi.keys('tab')[0]
    if (cancel) await multi.cancel(multi.state.byTab.tab.entries[0])
    else multi.release('tab')
    finish({ id: 'late' })
    await pending
    assert.deepEqual(disconnected, ['late'])
    if (!cancel) assert.equal(results.state.byTab[key], undefined)
  }
})
