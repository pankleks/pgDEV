import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueryWorkspace, createQueryController } from '../desktop/src/lib/queryWorkspace.ts'
import { snapshotSession, parseSession, restoreQuerySession, createSessionWriter } from '../desktop/src/lib/querySession.ts'
import { createQuerySessionStorage } from '../desktop/src/lib/sessionStorage.ts'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const session = sql => ({ version: 1, tabs: [{ title: 'Query 1', sql }], activeIndex: 0, nextTitle: 2 })

test('session keeps text, order and active tab, but no database state', () => {
  let key = 0
  const workspace = createQueryWorkspace(() => `old-${++key}`)
  const queries = createQueryController(workspace, {}, () => null, () => false, () => `old-${++key}`)
  const first = workspace.tabs[0], second = queries.addTab()
  first.sql = 'SELECT \'ź😀\';\r\n-- preserve whitespace\t'
  second.sql = ''
  first.results = [{ kind: 'command', command: 'secret result', rowCount: 1 }]
  first.transactionId = 'old transaction'; first.running = true; first.saving = true; first.closing = true
  first.notices.notices = [{ message: 'secret notice' }]
  const stored = snapshotSession(workspace)
  assert.deepEqual(Object.keys(stored.tabs[0]), ['title', 'sql'])
  assert.ok(!JSON.stringify(stored).includes('old transaction'))
  assert.ok(!JSON.stringify(stored).includes('secret'))
  let restoredKey = 0
  const restored = restoreQuerySession(parseSession(stored), () => `new-${++restoredKey}`)
  assert.equal(restored.activeKey, 'new-2'); assert.equal(restored.tabs[0].sql, first.sql)
  assert.equal(restored.tabs[1].sql, '')
  for (const tab of restored.tabs) {
    assert.equal(tab.transactionId, null); assert.deepEqual(tab.results, [])
    assert.equal(tab.running, false); assert.equal(tab.saving, false); assert.equal(tab.closing, false)
    assert.equal(tab.cancelling, false); assert.deepEqual(tab.notices.notices, [])
  }
})

test('defensive parsing preserves all text and clamps active indexes without accepting corrupt sessions', () => {
  const stored = session('SELECT 1')
  assert.equal(parseSession({ ...stored, activeIndex: 99 }).activeIndex, 0)
  assert.equal(parseSession({ ...stored, activeIndex: -1 }).activeIndex, 0)
  assert.equal(parseSession({ ...stored, activeIndex: 0.5 }).activeIndex, 0)
  for (const value of [null, {}, { ...stored, version: 2 }, { ...stored, tabs: [] }, { ...stored, tabs: [null] }, { ...stored, tabs: [{ title: 'query', sql: 123 }] }]) {
    assert.throws(() => parseSession(value))
  }
})

test('restored query numbering never reuses an existing title', () => {
  const stored = parseSession({ ...session(''), tabs: [{ title: 'Query 41', sql: '' }, { title: 'Custom title', sql: '' }], nextTitle: 2 })
  assert.equal(stored.nextTitle, 42)
  const workspace = restoreQuerySession(stored)
  const queries = createQueryController(workspace, {}, () => null)
  assert.equal(queries.addTab().title, 'Query 42')
})

test('writes are serialized and snapshots cannot change while waiting', async () => {
  const first = deferred(), calls = []
  const writer = createSessionWriter(async value => { calls.push(value); if (calls.length === 1) await first.promise })
  const a = writer.save(session('one'))
  const second = session('two'), b = writer.save(second)
  second.tabs[0].sql = 'mutated after queue'
  await Promise.resolve()
  assert.deepEqual(calls.map(value => value.tabs[0].sql), ['one'])
  first.resolve(); await Promise.all([a, b])
  assert.deepEqual(calls.map(value => value.tabs[0].sql), ['one', 'two'])
  await writer.save(session('two'))
  assert.equal(calls.length, 2)
})

test('failed persistence remains retryable and does not poison later writes', async () => {
  let calls = 0
  const writer = createSessionWriter(async () => { if (++calls === 1) throw new Error('quota') })
  await assert.rejects(writer.save(session('one')), /quota/)
  await writer.save(session('one'))
  assert.equal(calls, 2)
  await writer.save(session('two'))
  assert.equal(calls, 3)
})

test('loaded snapshots skip unnecessary writes, but closed tabs are removed from storage', async () => {
  const calls = [], writer = createSessionWriter(async value => { calls.push(value) })
  const initial = { ...session(''), tabs: [{ title: 'Query 1', sql: 'one' }, { title: 'Query 2', sql: 'two' }], activeIndex: 1, nextTitle: 3 }
  writer.markLoaded(initial)
  await writer.save(initial); assert.equal(calls.length, 0)
  const workspace = restoreQuerySession(initial)
  const queries = createQueryController(workspace, {}, () => null)
  await queries.closeTab(workspace.tabs[1].key)
  await writer.save(snapshotSession(workspace))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].tabs, [{ title: 'Query 1', sql: 'one' }])
})

function storageFixture(initial) {
  let stored = initial, next = deferred()
  const db = {
    close() {},
    transaction(_store, mode) {
      let staged
      const transaction = {
        objectStore: () => ({ get: () => ({ result: stored }), put: value => { staged = structuredClone(value) } }),
        complete() { if (mode === 'readwrite') stored = staged; this.oncomplete() },
        abort() { this.onabort() },
      }
      next.resolve(transaction)
      return transaction
    },
  }
  const factory = { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request } }
  const storage = createQuerySessionStorage(() => factory)
  return { storage, db, get stored() { return stored }, async transaction() { const tx = await next.promise; next = deferred(); return tx } }
}

test('IndexedDB save awaits transaction commit and aborted writes preserve the previous session', async () => {
  const f = storageFixture(session('previous'))
  let done = false
  const save = f.storage.saveQuerySession(session('new')).then(() => { done = true })
  const tx = await f.transaction()
  assert.equal(done, false); assert.equal(f.stored.tabs[0].sql, 'previous')
  tx.complete(); await save
  assert.equal(done, true); assert.equal(f.stored.tabs[0].sql, 'new')
  const failed = f.storage.saveQuerySession(session('lost'))
  const failure = assert.rejects(failed, /Could not save/)
  const aborted = await f.transaction(); aborted.abort(); await failure
  assert.equal(f.stored.tabs[0].sql, 'new')
})

test('IndexedDB loads distinguish missing data from corrupt or unreadable data', async () => {
  const f = storageFixture(undefined)
  const missing = f.storage.loadQuerySession()
  const tx = await f.transaction(); tx.complete()
  assert.equal(await missing, null)
  const corrupt = storageFixture({ version: 2, tabs: [] })
  const read = corrupt.storage.loadQuerySession()
  const rejected = assert.rejects(read, /Unsupported/)
  const corruptTx = await corrupt.transaction(); corruptTx.complete(); await rejected
  const failed = f.storage.loadQuerySession()
  const failure = assert.rejects(failed, /Could not read/)
  const aborted = await f.transaction(); aborted.abort(); await failure
  const unavailable = createQuerySessionStorage(() => undefined)
  await assert.rejects(unavailable.loadQuerySession(), /unavailable/)
})

test('blocked IndexedDB opens close late connections rather than leaking them', async () => {
  const requests = []
  let closed = 0
  const storage = createQuerySessionStorage(() => ({ open() { const request = { result: { close: () => { closed++ } } }; requests.push(request); return request } }))
  const opening = storage.loadQuerySession()
  const rejected = assert.rejects(opening, /blocked/)
  requests[0].onblocked(); await rejected
  requests[0].onsuccess()
  assert.equal(closed, 1)
  const retry = storage.loadQuerySession()
  const retryRejected = assert.rejects(retry, /blocked/)
  assert.equal(requests.length, 2)
  requests[1].onblocked(); await retryRejected
})
