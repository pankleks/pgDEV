import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueryWorkspace, createQueryController, tabNeedsConfirmation } from '../desktop/src/lib/queryWorkspace.ts'
import { QueryModels } from '../desktop/src/lib/queryModels.ts'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const notices = { notices: [], noticesTruncated: false }
const response = (value, transactionId = null) => ({ results: [{ kind: 'command', command: value, rowCount: 0 }], transactionId, transactionOpen: transactionId !== null, durationMs: 10, ...notices })
const grid = () => ({ kind: 'data', columns: ['id', 'note'], columnTypes: ['integer', 'text'], columnTypeOids: [23, 25], columnTypeLengths: [null, null], rows: [[1, 'old']], rowCount: 1, truncated: true, limited: false, totalRowCount: null, editable: { schema: 'public', table: 'sample', pk: ['id'], columns: [] } })

function fixture(overrides = {}) {
  let key = 0, connection = { id: 'connection1', pgVersion: '14' }, disabled = false
  const takeKey = () => `tab${++key}`
  const workspace = createQueryWorkspace(takeKey), calls = []
  const api = {
    query: async request => { calls.push(['query', request]); return response('SELECT') },
    fetchMore: async (...args) => { calls.push(['fetch', ...args]); return { rows: [[2, 'next']], rowCount: 1, truncated: false, ...notices } },
    cancel: async (...args) => { calls.push(['cancel', ...args]) },
    closeSession: async (...args) => { calls.push(['close', ...args]) },
    rowUpdate: async request => { calls.push(['update', request]); return { row: { id: 1, note: 'stored' }, transactionOpen: true, transactionId: 'transaction1', ...notices } },
    ...overrides,
  }
  const queries = createQueryController(workspace, api, () => connection, () => disabled, takeKey)
  return { workspace, queries, calls, connect: value => { connection = value }, disable: value => { disabled = value } }
}

test('tabs retain independent SQL and queries never follow the active selection', async () => {
  const pending = new Map()
  const f = fixture({ query: request => { const wait = deferred(); pending.set(request.tabKey, { wait, request }); return wait.promise } })
  const first = f.workspace.tabs[0], second = f.queries.addTab()
  f.queries.setSql(first.key, 'SELECT first'); f.queries.setSql(second.key, 'SELECT second')
  const a = f.queries.run(first.key, first.sql), b = f.queries.run(second.key, second.sql)
  assert.ok(first.running && second.running)
  f.queries.activateTab(first.key)
  pending.get(second.key).wait.resolve(response('second', 'transaction2')); await b
  assert.equal(second.results[0].command, 'second'); assert.equal(second.transactionId, 'transaction2')
  assert.equal(first.results.length, 0); assert.equal(f.workspace.activeKey, first.key)
  pending.get(first.key).wait.resolve(response('first')); await a
  assert.equal(first.results[0].command, 'first'); assert.equal(first.sql, 'SELECT first')
  assert.equal(pending.get(second.key).request.transactionId, null)
})

test('transaction identity and error notices stay on their original tab', async () => {
  const wait = deferred(), f = fixture({ query: () => wait.promise })
  const first = f.workspace.tabs[0], second = f.queries.addTab()
  first.transactionId = 'transaction1'
  const run = f.queries.run(first.key, 'broken')
  wait.reject({ message: 'failed', transactionOpen: true, transactionId: 'transaction1', notices: [{ severity: 'NOTICE', code: '00000', message: 'before failure', detail: null, hint: null, context: null }] })
  assert.equal(await run, false)
  assert.equal(first.message, 'failed'); assert.equal(first.transactionId, 'transaction1')
  assert.equal(first.notices.notices[0].message, 'before failure')
  assert.equal(second.message, ''); assert.equal(second.notices.notices.length, 0)
})

test('paging, row updates and cancellation use the captured tab key', async () => {
  const wait = deferred(), f = fixture({ fetchMore: () => wait.promise })
  const first = f.workspace.tabs[0], second = f.queries.addTab()
  first.results = [grid()]
  const page = f.queries.more(first.key, 0)
  await f.queries.cancel(first.key)
  assert.deepEqual(f.calls[0], ['cancel', 'connection1', first.key])
  wait.resolve({ rows: [[2, 'next']], rowCount: 1, truncated: false, ...notices }); await page
  assert.equal(first.results[0].rows.length, 2); assert.equal(second.results.length, 0)
  first.transactionId = 'transaction1'
  assert.equal(await f.queries.rowUpdate(first.key, 0, 0, { note: 'typed' }), true)
  const update = f.calls.find(call => call[0] === 'update')[1]
  assert.equal(update.tabKey, first.key); assert.equal(update.transactionId, 'transaction1')
  assert.deepEqual(update.key, { id: 1 }); assert.equal(first.results[0].rows[0][1], 'stored')
})

test('a tab refuses overlapping work but other tabs remain usable', async () => {
  const wait = deferred(), f = fixture({ query: () => wait.promise })
  const first = f.workspace.tabs[0]
  const run = f.queries.run(first.key, 'SELECT 1')
  assert.equal(await f.queries.run(first.key, 'SELECT 2'), false)
  assert.equal(await f.queries.rowUpdate(first.key, 0, 0, { note: 'x' }), false)
  f.disable(true)
  assert.equal(await f.queries.run(f.queries.addTab().key, 'SELECT 3'), false)
  wait.resolve(response('done')); await run
  assert.equal(first.running, false)
})

test('disconnect resets server state, preserves SQL and rejects late replies after reconnect', async () => {
  const wait = deferred(), f = fixture({ query: () => wait.promise })
  const tab = f.workspace.tabs[0]
  tab.sql = 'keep my SQL'; tab.transactionId = 'old transaction'
  const run = f.queries.run(tab.key, tab.sql)
  f.connect(null); f.queries.resetConnection(); f.connect({ id: 'connection2', pgVersion: '14' })
  wait.resolve(response('obsolete', 'obsolete transaction')); await run
  assert.equal(tab.sql, 'keep my SQL'); assert.equal(tab.transactionId, null)
  assert.equal(tab.results.length, 0); assert.equal(tab.running, false)
})

test('closing a running tab closes its session and discards late results, not other tabs', async () => {
  const wait = deferred(), f = fixture({ query: () => wait.promise })
  const first = f.workspace.tabs[0], second = f.queries.addTab()
  f.queries.activateTab(first.key)
  const run = f.queries.run(first.key, 'slow query')
  assert.ok(tabNeedsConfirmation(first))
  assert.equal(await f.queries.closeTab(first.key), true)
  assert.deepEqual(f.calls[0], ['close', 'connection1', first.key])
  assert.equal(f.workspace.activeKey, second.key)
  wait.resolve(response('too late')); await run
  assert.equal(second.results.length, 0); assert.equal(f.workspace.tabs.length, 1)
})

test('failed closes keep the SQL and transaction; an in-flight row write cannot be closed', async () => {
  const f = fixture({ closeSession: async () => { throw new Error('close failed') } })
  const tab = f.workspace.tabs[0]
  tab.transactionId = 'transaction1'
  assert.equal(await f.queries.closeTab(tab.key), false)
  assert.equal(tab.message, 'close failed'); assert.equal(tab.closing, false)
  assert.equal(tab.transactionId, 'transaction1'); assert.equal(f.workspace.tabs.length, 1)
  tab.saving = true
  assert.equal(await f.queries.closeTab(tab.key), false)
})

test('closing the last tab creates an empty replacement, without opening a database session', async () => {
  const f = fixture(), original = f.workspace.tabs[0]
  assert.equal(await f.queries.closeTab(original.key), true)
  assert.equal(f.workspace.tabs.length, 1); assert.notEqual(f.workspace.activeKey, original.key)
  assert.equal(f.workspace.tabs[0].sql, ''); assert.equal(tabNeedsConfirmation(f.workspace.tabs[0]), false)
  assert.ok(f.calls.every(call => call[0] === 'close'))
})

test('a delayed cancellation cannot target a new query on the same tab', async () => {
  const query = deferred(), cancel = deferred()
  const f = fixture({ query: () => query.promise, cancel: () => cancel.promise })
  const tab = f.workspace.tabs[0]
  const run = f.queries.run(tab.key, 'slow')
  const cancellation = f.queries.cancel(tab.key)
  query.resolve(response('completed')); await run
  assert.equal(tab.running, false); assert.equal(tab.cancelling, true)
  assert.equal(await f.queries.run(tab.key, 'new query'), false)
  assert.equal(await f.queries.closeTab(tab.key), false)
  cancel.resolve(); await cancellation
  assert.equal(tab.cancelling, false)
  assert.equal(await f.queries.run(tab.key, 'new query'), true)
})

test('late close acknowledgements after disconnect do not discard SQL or newer state', async () => {
  const close = deferred(), f = fixture({ closeSession: () => close.promise })
  const tab = f.workspace.tabs[0]
  tab.sql = 'preserve this text'
  const closing = f.queries.closeTab(tab.key)
  f.connect(null); f.queries.resetConnection(); f.connect({ id: 'new connection', pgVersion: '14' })
  assert.equal(await f.queries.run(tab.key, 'SELECT 1'), true)
  close.resolve()
  assert.equal(await closing, false)
  assert.equal(f.workspace.tabs[0], tab); assert.equal(tab.sql, 'preserve this text')
  assert.equal(tab.results[0].command, 'SELECT'); assert.equal(tab.closing, false)
})

test('SQL diagnostics stay on the submitted tab and clear on edits, rerun and disconnect', async () => {
  const f = fixture({ query: async () => { throw { message: 'missing column', position: 8 } } })
  const first = f.workspace.tabs[0], second = f.queries.addTab()
  f.queries.setSql(first.key, 'SELECT missing')
  await f.queries.run(first.key, first.sql)
  assert.equal(first.sqlError.position, 8); assert.equal(second.sqlError, null)
  f.queries.setSql(first.key, 'SELECT other'); assert.equal(first.sqlError, null)
  await f.queries.run(first.key, first.sql); assert.ok(first.sqlError)
  await f.queries.run(first.key, 'COMMIT'); assert.equal(first.sqlError, null)
  await f.queries.run(first.key, first.sql)
  f.queries.resetConnection(); assert.equal(first.sqlError, null)
})

test('editing while a query runs suppresses its late error marker', async () => {
  const wait = deferred(), f = fixture({ query: () => wait.promise })
  const tab = f.workspace.tabs[0]
  f.queries.setSql(tab.key, 'SELECT missing')
  const run = f.queries.run(tab.key, tab.sql)
  f.queries.setSql(tab.key, 'SELECT edited')
  wait.reject({ message: 'old SQL failed', position: 8 }); await run
  assert.equal(tab.sqlError, null); assert.equal(tab.message, 'old SQL failed')
})

function editorFixture() {
  const models = [], registrations = []
  const register = () => { const item = { disposed: false }; registrations.push(item); return { dispose: () => { item.disposed = true } } }
  const monaco = {
    MarkerSeverity: { Error: 8 },
    Uri: { parse: uri => uri },
    editor: { setModelMarkers(model, _owner, markers) { model.markers = markers }, createModel(sql, _language, uri) {
      const model = { uri, text: sql, setCalls: 0, disposed: false, getValue() { return this.text }, setValue(text) { this.setCalls++; this.text = text }, getValueInRange(range) { return this.text.slice(range.start, range.end) }, getOffsetAt(position) { return this.text.split('\n').slice(0, position.lineNumber - 1).reduce((offset, line) => offset + line.length + 1, 0) + position.column - 1 }, getPositionAt(offset) { const lines = this.text.slice(0, offset).split('\n'); return { lineNumber: lines.length, column: lines.at(-1).length + 1 } }, getWordAtPosition() { return null }, dispose() { this.disposed = true } }
      models.push(model); return model
    } },
    languages: { registerCompletionItemProvider: register, registerHoverProvider: register, registerSignatureHelpProvider: register },
  }
  const editor = {
    model: null, view: { cursor: 0 }, selection: { isEmpty: () => true },
    getModel() { return this.model }, setModel(model) { this.model = model; this.view = { cursor: 0 } },
    saveViewState() { return { ...this.view } }, restoreViewState(view) { this.view = { ...view } }, getSelection() { return this.selection },
  }
  const manager = new QueryModels(monaco, editor, () => null)
  return { models, registrations, editor, manager }
}

test('editor models retain text, view state and undo history across switches', () => {
  const f = editorFixture(), tabs = [{ key: 'a/b', sql: 'SELECT first' }, { key: 'a?b', sql: 'SELECT second' }]
  f.manager.sync(tabs, tabs[0].key)
  const first = f.editor.model
  f.editor.view = { cursor: 7, scroll: 20 }
  f.manager.sync(tabs, tabs[1].key)
  const second = f.editor.model
  f.editor.view = { cursor: 3, scroll: 4 }
  f.manager.sync(tabs, tabs[0].key)
  assert.equal(f.editor.model, first); assert.deepEqual(f.editor.view, { cursor: 7, scroll: 20 })
  assert.equal(first.setCalls, 0); assert.equal(second.setCalls, 0)
  assert.notEqual(first.uri, second.uri); assert.equal(f.manager.keyFor(first), tabs[0].key)
  f.editor.selection = { start: 0, end: 6, isEmpty: () => false }
  assert.equal(f.manager.getSql(), 'SELECT')
  f.manager.dispose()
  assert.ok(f.models.every(model => model.disposed)); assert.ok(f.registrations.every(item => item.disposed))
})

test('removed models dispose their providers while retained models remain intact', () => {
  const f = editorFixture(), tabs = [{ key: 'one', sql: 'one' }, { key: 'two', sql: 'two' }]
  f.manager.sync(tabs, 'one')
  f.manager.sync([tabs[1]], 'two')
  assert.equal(f.models[0].disposed, true); assert.equal(f.models[1].disposed, false)
  assert.equal(f.registrations.filter(item => item.disposed).length, 3)
  assert.equal(f.editor.model, f.models[1])
  f.manager.dispose()
})

test('markers belong to their model and clear when the diagnostic disappears', () => {
  const f = editorFixture(), sql = "SELECT '😀';\nSELECT missing"
  const tabs = [{ key: 'first', sql, sqlError: { submission: { sql, documentSql: sql, startOffset: 0 }, position: [...sql.slice(0, sql.indexOf('missing'))].length + 1, message: 'missing' } }, { key: 'other', sql: 'SELECT 1' }]
  f.manager.sync(tabs, 'other')
  assert.equal(f.models[0].markers[0].startLineNumber, 2)
  assert.equal(f.models[0].markers[0].startColumn, 8)
  assert.deepEqual(f.models[1].markers, [])
  tabs[0].sqlError = null
  f.manager.sync(tabs, 'first')
  assert.deepEqual(f.models[0].markers, [])
  f.manager.dispose()
})

test('submission captures the exact selection and its UTF-16 origin', () => {
  const f = editorFixture(), sql = "SELECT '😀';\nSELECT missing"
  f.manager.sync([{ key: 'tab', sql }], 'tab')
  assert.deepEqual(f.manager.getSubmission(), { sql, documentSql: sql, startOffset: 0 })
  const start = sql.indexOf('SELECT missing')
  f.editor.selection = { start, end: sql.length, isEmpty: () => false, getStartPosition: () => ({ lineNumber: 2, column: 1 }) }
  assert.deepEqual(f.manager.getSubmission(), { sql: 'SELECT missing', documentSql: sql, startOffset: start })
  f.manager.dispose()
})
