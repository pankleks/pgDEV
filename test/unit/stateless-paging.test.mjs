import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setPool, removePool } from '../../server/dist/pools.js'
import { runBatch, fetchNextPage, closeTabSession, cancelConnection } from '../../server/dist/queryexec.js'
import { getSession, sessionKey } from '../../server/dist/sessions.js'

test('paging reruns only the final SELECT and releases every transaction/client', async () => {
  const id = 'stateless-paging'
  const statements = []
  const fields = [{ name: 'n', tableID: 0, dataTypeID: 23, dataTypeModifier: -1 }]
  let rows = [[1], [2], [3], [4], [5]]
  let offset = 0
  let releases = 0
  let inTransaction = false
  let readOnly = false
  let failFetch = false
  let changedShape = false
  const client = {
    connection: new EventEmitter(), on() {}, removeListener() {},
    async query(query, params) {
      const text = typeof query === 'string' ? query : query.text
      statements.push(text)
      if (typeof query.emit === 'function') {
        queueMicrotask(() => query.emit('end', { fields: [], rows: [], command: 'SET', rowCount: 0 }))
      }
      if (text === 'SHOW standard_conforming_strings') return { rows: [{ standard_conforming_strings: 'on' }] }
      if (text.startsWith('SELECT current_setting')) return { rows: [{ search_path: 'public', string_mode: 'on', role: 'restricted_reader' }] }
      if (text.startsWith('SELECT set_config')) assert.deepEqual(params, ['public', 'on', 'restricted_reader'])
      if (text.startsWith('BEGIN')) { inTransaction = true; readOnly = text === 'BEGIN READ ONLY' }
      if (text === 'COMMIT' || text === 'ROLLBACK') inTransaction = false
      if (text.startsWith('DECLARE')) offset = 0
      if (text.startsWith('MOVE')) offset = Number(text.match(/MOVE FORWARD (\d+)/)[1])
      if (text.startsWith('FETCH')) {
        assert.equal(inTransaction, true)
        if (failFetch) throw new Error('page fetch failed')
        const count = Number(text.match(/FETCH FORWARD (\d+)/)[1])
        return { rows: rows.slice(offset, offset + count), fields: changedShape ? [{ ...fields[0], name: 'renamed' }] : fields }
      }
      if (text.includes('FROM pg_type')) return { rows: [{ oid: '23', name: 'integer' }] }
      return { rows: [], fields: [] }
    },
    release() { assert.equal(inTransaction, false, 'no idle transaction returns to the pool'); releases++ },
  }
  setPool(id, { connect: async () => client, end: async () => {} })
  try {
    const first = await runBatch(id, 'page', 'SET search_path = public; SELECT n FROM numbers ORDER BY n', 2)
    assert.equal(first.kind, 'ok', JSON.stringify(first))
    assert.deepEqual(first.results.at(-1).rows, [[1], [2]])
    assert.equal(first.results.at(-1).truncated, true)
    assert.equal(first.transactionOpen, false)
    assert.equal(getSession(sessionKey(id, 'page')), undefined)
    assert.equal(releases, 1)
    const settingsCount = statements.filter((sql) => sql === 'SET search_path = public').length
    rows[2] = [30]
    const second = await fetchNextPage(id, 'page', 2)
    assert.deepEqual(second, { kind: 'ok', rows: [[30], [4]], rowCount: 2, truncated: true })
    assert.equal(readOnly, true, 'replayed SELECTs cannot repeat database writes')
    assert.ok(statements.includes('MOVE FORWARD 2 FROM "pgdev_page"'))
    assert.equal(statements.filter((sql) => sql === 'SET search_path = public').length, settingsCount)
    assert.equal(releases, 2)
    assert.equal(getSession(sessionKey(id, 'page')), undefined)
    assert.deepEqual(await fetchNextPage(id, 'page', 2), { kind: 'ok', rows: [[5]], rowCount: 1, truncated: false })
    assert.equal((await fetchNextPage(id, 'page', 2)).error.kind, 'no-more')

    await runBatch(id, 'shape', 'SELECT n FROM numbers', 2)
    changedShape = true
    assert.match((await fetchNextPage(id, 'shape', 2)).error.message, /columns changed/)
    changedShape = false
    assert.equal((await fetchNextPage(id, 'shape', 2)).error.kind, 'no-more')

    await runBatch(id, 'error', 'SELECT n FROM numbers', 2)
    failFetch = true
    assert.match((await fetchNextPage(id, 'error', 2)).error.message, /page fetch failed/)
    failFetch = false
    assert.equal((await fetchNextPage(id, 'error', 2)).error.kind, 'no-more')

    await runBatch(id, 'close', 'SELECT n FROM numbers', 2)
    await closeTabSession(id, 'close')
    assert.equal((await fetchNextPage(id, 'close', 2)).error.kind, 'no-more')
    await runBatch(id, 'disconnect', 'SELECT n FROM numbers', 2)
    cancelConnection(id)
    assert.equal((await fetchNextPage(id, 'disconnect', 2)).error.kind, 'no-more')
    assert.equal(inTransaction, false)
  } finally {
    cancelConnection(id)
    await removePool(id)
  }
})
