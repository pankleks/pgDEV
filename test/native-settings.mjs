import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeSettings, settingsRecord, parseSettingsRecord } from '../desktop/src/lib/settings.ts'
import { createSnapshotWriter } from '../desktop/src/lib/snapshotWriter.ts'
import { createQueryWorkspace, createQueryController } from '../desktop/src/lib/queryWorkspace.ts'

test('desktop defaults match the original font/timeout and native paging defaults', () => {
  assert.deepEqual(sanitizeSettings(null), { editorFontSize: 14, statementTimeout: 30, maxRows: 500 })
  assert.deepEqual(sanitizeSettings({ editorFontSize: '20', statementTimeout: NaN, maxRows: Infinity }), sanitizeSettings(null))
})

test('settings clamp and round within the same supported ranges', () => {
  assert.deepEqual(sanitizeSettings({ editorFontSize: 2, statementTimeout: -1, maxRows: 0 }), { editorFontSize: 8, statementTimeout: 1, maxRows: 1 })
  assert.deepEqual(sanitizeSettings({ editorFontSize: 100, statementTimeout: 1000, maxRows: 10001 }), { editorFontSize: 32, statementTimeout: 600, maxRows: 10000 })
  assert.deepEqual(sanitizeSettings({ editorFontSize: 15.6, statementTimeout: 25.4, maxRows: 99.6 }), { editorFontSize: 16, statementTimeout: 25, maxRows: 100 })
})

test('saved settings normalize fields but reject invalid or unsupported envelopes', () => {
  const value = parseSettingsRecord({ version: 1, settings: { editorFontSize: 18, extra: 'not stored', statementTimeout: null } })
  assert.deepEqual(value, { version: 1, settings: { editorFontSize: 18, statementTimeout: 30, maxRows: 500 } })
  for (const corrupt of [null, {}, { version: 2, settings: {} }, { version: 1, settings: null }]) assert.throws(() => parseSettingsRecord(corrupt))
})

test('settings saves snapshot reactive-compatible objects and retry failures', async () => {
  const records = [], settings = sanitizeSettings(null)
  let fail = true
  const writer = createSnapshotWriter(async record => { if (fail) throw new Error('quota'); records.push(record) })
  await assert.rejects(writer.save(settingsRecord(settings)), /quota/)
  fail = false
  const saving = writer.save(settingsRecord(settings))
  settings.editorFontSize = 20
  await saving
  assert.equal(records[0].settings.editorFontSize, 14)
  await writer.save(settingsRecord(settings))
  assert.equal(records[1].settings.editorFontSize, 20)
})

test('queries and page fetches capture the row limit without changing existing results', async () => {
  const workspace = createQueryWorkspace(() => 'tab')
  let settings = sanitizeSettings({ maxRows: 17 })
  const calls = []
  const transport = {
    async query(request) {
      calls.push(['query', request])
      return { results: [{ kind: 'data', columns: ['n'], rows: [[1]], rowCount: 1, truncated: true }], transactionId: null, durationMs: 1, notices: [], noticesTruncated: false }
    },
    async fetchMore(...args) { calls.push(['fetch', ...args]); return { rows: [[2]], rowCount: 1, truncated: false, notices: [], noticesTruncated: false } },
  }
  const controller = createQueryController(workspace, transport, () => ({ id: 'connection' }), () => false, undefined, () => settings.maxRows)
  await controller.run('tab', 'SELECT n')
  assert.equal(calls[0][1].maxRows, 17)
  settings = sanitizeSettings({ maxRows: 3 })
  assert.deepEqual(workspace.tabs[0].results[0].rows, [[1]])
  await controller.more('tab', 0)
  assert.deepEqual(calls[1], ['fetch', 'connection', 'tab', 3])
  assert.deepEqual(workspace.tabs[0].results[0].rows, [[1], [2]])
  settings.maxRows = NaN
  await controller.run('tab', 'SELECT n')
  assert.equal(calls[2][1].maxRows, 500)
})
