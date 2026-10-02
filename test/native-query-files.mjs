import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueryWorkspace, createQueryController, tabIsDirty, tabNeedsConfirmation } from '../desktop/src/lib/queryWorkspace.ts'
import { createFileController } from '../desktop/src/lib/queryFiles.ts'
import { snapshotSession, restoreQuerySession } from '../desktop/src/lib/querySession.ts'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const file = (token = 'file1') => ({ token, fileName: 'sample.sql', displayPath: 'chosen/sample.sql' })
function fixture(overrides = {}) {
  let index = 0
  const workspace = createQueryWorkspace(() => `tab${++index}`), calls = []
  const queries = createQueryController(workspace, {}, () => null, () => false, () => `tab${++index}`)
  const transport = {
    openSqlFile: async () => ({ file: file(), content: 'SELECT 7' }),
    saveSqlFile: async (content, token) => { calls.push(['save', content, token]); return file(token ?? 'newFile') },
    releaseSqlFile: async token => { calls.push(['release', token]) },
    ...overrides,
  }
  const files = createFileController(workspace, queries, transport)
  return { workspace, queries, files, calls }
}

test('opening SQL creates a clean file tab without touching queries, results or transactions', async () => {
  const f = fixture(), original = f.workspace.tabs[0]
  original.transactionId = 'transaction1'; original.results = [{ command: 'retained' }]
  await f.files.open()
  const opened = f.workspace.tabs.at(-1)
  assert.equal(opened.title, 'sample.sql'); assert.equal(opened.sql, 'SELECT 7')
  assert.equal(tabIsDirty(opened), false); assert.equal(tabNeedsConfirmation(opened), false)
  assert.equal(original.transactionId, 'transaction1'); assert.deepEqual(original.results, [{ command: 'retained' }])
  assert.deepEqual(f.calls, [])
})

test('reopening a clean file reuses its tab; a dirty version is preserved in its own tab', async () => {
  let token = 0
  const f = fixture({ openSqlFile: async () => ({ file: file(`file${++token}`), content: 'SELECT 7' }) })
  await f.files.open()
  const opened = f.workspace.tabs.at(-1)
  await f.files.open()
  assert.equal(f.workspace.tabs.length, 2); assert.equal(f.workspace.activeKey, opened.key)
  assert.deepEqual(f.calls, [['release', 'file1']])
  f.queries.setSql(opened.key, 'SELECT edited')
  await f.files.open()
  assert.equal(f.workspace.tabs.length, 3); assert.equal(opened.sql, 'SELECT edited')
  assert.ok(tabIsDirty(opened))
})

test('save captures its original tab and text while later edits remain dirty', async () => {
  const pending = deferred(), f = fixture({ saveSqlFile: () => pending.promise })
  await f.files.open()
  const tab = f.workspace.tabs.at(-1)
  f.queries.setSql(tab.key, 'SELECT saved')
  const saving = f.files.save(tab.key)
  assert.equal(tab.fileSaving, true)
  assert.equal(await f.queries.closeTab(tab.key), false)
  f.queries.setSql(tab.key, 'SELECT edited during save')
  f.queries.activateTab(f.workspace.tabs[0].key)
  pending.resolve(file()); await saving
  assert.equal(tab.savedSql, 'SELECT saved'); assert.equal(tab.sql, 'SELECT edited during save')
  assert.ok(tabIsDirty(tab)); assert.equal(tab.fileSaving, false)
  assert.equal(f.workspace.tabs[0].savedSql, null)
})

test('Save As swaps the file token only after success; failure and cancellation preserve the baseline', async () => {
  const f = fixture()
  await f.files.open()
  const tab = f.workspace.tabs.at(-1)
  f.queries.setSql(tab.key, 'SELECT changed')
  await f.files.save(tab.key, true)
  assert.deepEqual(f.calls, [['save', 'SELECT changed', null], ['release', 'file1']])
  assert.equal(tab.file.token, 'newFile'); assert.equal(tabIsDirty(tab), false)
  const failed = fixture({ saveSqlFile: async () => { throw new Error('changed on disk') } })
  await failed.files.open()
  const old = failed.workspace.tabs.at(-1)
  failed.queries.setSql(old.key, 'new SQL')
  assert.equal(await failed.files.save(old.key), false)
  assert.equal(old.savedSql, 'SELECT 7'); assert.equal(old.file.token, 'file1')
  assert.equal(old.editorError, 'changed on disk'); assert.ok(tabIsDirty(old))
  const cancelled = fixture({ openSqlFile: async () => null, saveSqlFile: async () => null })
  assert.equal(await cancelled.files.open(), false); assert.equal(cancelled.workspace.tabs.length, 1)
  assert.equal(await cancelled.files.save(cancelled.workspace.tabs[0].key), false)
  assert.equal(cancelled.workspace.tabs[0].file, null)
})

test('session snapshots preserve file SQL but never revive paths or native access tokens', async () => {
  const f = fixture(); await f.files.open()
  const snapshot = snapshotSession(f.workspace)
  assert.ok(!JSON.stringify(snapshot).includes('chosen/')); assert.ok(!JSON.stringify(snapshot).includes('file1'))
  const restored = restoreQuerySession(snapshot)
  const tab = restored.tabs.at(-1)
  assert.equal(tab.sql, 'SELECT 7'); assert.equal(tab.file, null); assert.equal(tab.savedSql, null)
  assert.ok(tabIsDirty(tab))
})

test('dirty checks ignore line-ending differences and disconnect preserves file associations', async () => {
  const f = fixture(); await f.files.open()
  const tab = f.workspace.tabs.at(-1)
  tab.savedSql = 'SELECT 7\r\n'; tab.sql = 'SELECT 7\n'
  assert.equal(tabIsDirty(tab), false)
  f.queries.resetConnection()
  assert.equal(tab.file.token, 'file1'); assert.equal(tab.savedSql, 'SELECT 7\r\n')
})
