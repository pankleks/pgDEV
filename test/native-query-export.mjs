import assert from 'node:assert/strict'
import test from 'node:test'
import { createQueryWorkspace, createQueryController } from '../desktop/src/lib/queryWorkspace.ts'
import { createExportController, csvChunks } from '../desktop/src/lib/queryExport.ts'
import { csvHeader, csvRows } from '../web/src/lib/gridio.ts'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const output = { notices: [], noticesTruncated: false }
const grid = (truncated = true) => ({ kind: 'data', columns: ['value'], rows: [['first']], rowCount: 1, truncated, limited: false })
function fixture(overrides = {}) {
  let number = 0
  const workspace = createQueryWorkspace(() => `tab${++number}`), calls = [], chunks = []
  const tab = workspace.tabs[0]; tab.results = [grid()]
  const transport = {
    query: async () => ({ results: [], transactionId: null, durationMs: 1, ...output }),
    startCsvExport: async () => { calls.push(['start']); return 'export-token' },
    appendCsvExport: async (token, text) => { calls.push(['append', token]); chunks.push(text) },
    finishCsvExport: async token => { calls.push(['finish', token]); return 'result.csv' },
    abortCsvExport: async token => { calls.push(['abort', token]) },
    fetchMore: async (...args) => { calls.push(['fetch', ...args]); return { rows: [['last']], rowCount: 1, truncated: false, ...output } },
    cancel: async (...args) => { calls.push(['cancel', ...args]) },
    ...overrides,
  }
  const connection = () => ({ id: 'connection' })
  const queries = createQueryController(workspace, transport, connection, () => false, () => `tab${++number}`)
  const exports = createExportController(workspace, transport, connection, () => 2)
  return { workspace, tab, queries, exports, calls, chunks }
}

test('CSV chunks match existing escaping rules, preserve Unicode and bound UTF-8 IPC payloads', () => {
  const columns = ['=header', 'normal'], rows = [[null, 'a,"b"\n'], ['9223372036854775807', '@formula'], ['x'.repeat(65534) + '😀' + 'ą'.repeat(100000), '-value']]
  const chunks = [...csvChunks(columns, rows)]
  assert.equal(chunks.join(''), csvHeader(columns) + csvRows(rows))
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 1024 * 1024))
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)))
  assert.ok(chunks.join('').includes("'@formula"))
})

test('streaming drains the captured cursor once without retaining pages in the grid', async () => {
  const f = fixture()
  assert.equal(await f.exports.exportCsv(f.tab.key, 0), true)
  assert.deepEqual(f.tab.results[0].rows, [['first']]); assert.equal(f.tab.results[0].rowCount, 1)
  assert.equal(f.tab.results[0].truncated, false)
  assert.deepEqual(f.tab.exports[0], { rows: 2, incomplete: false, path: 'result.csv' })
  assert.equal(f.chunks.join(''), csvHeader(['value']) + csvRows([['first'], ['last']]))
  assert.deepEqual(f.calls.find(call => call[0] === 'fetch'), ['fetch', 'connection', f.tab.key, 2])
  assert.equal(await f.exports.exportCsv(f.tab.key, 0), false)
  assert.ok(!f.calls.some(call => call[0] === 'abort'))
})

test('switching tabs while the picker is open never redirects the export or its status', async () => {
  const picker = deferred(), f = fixture({ startCsvExport: () => picker.promise })
  const exporting = f.exports.exportCsv(f.tab.key, 0)
  const other = f.queries.addTab()
  assert.equal(await f.queries.closeTab(f.tab.key), false)
  assert.equal(await f.queries.run(f.tab.key, 'SELECT 1'), false)
  picker.resolve('export-token'); await exporting
  assert.equal(f.tab.exports[0].rows, 2); assert.deepEqual(other.exports, {})
  assert.equal(other.exportMessage, ''); assert.equal(f.workspace.activeKey, other.key)
})

test('picker cancellation and a first-page write failure leave paging retryable', async () => {
  const cancelled = fixture({ startCsvExport: async () => null })
  assert.equal(await cancelled.exports.exportCsv(cancelled.tab.key, 0), false)
  assert.equal(cancelled.tab.results[0].truncated, true); assert.deepEqual(cancelled.tab.exports, {})
  const failed = fixture({ appendCsvExport: async () => { throw new Error('disk full') } })
  assert.equal(await failed.exports.exportCsv(failed.tab.key, 0), false)
  assert.equal(failed.tab.results[0].truncated, true); assert.deepEqual(failed.tab.exports, {})
  assert.ok(failed.calls.some(call => call[0] === 'abort'))
  assert.ok(!failed.calls.some(call => call[0] === 'fetch'))
})

test('lost fetch replies and post-fetch file failures retire paging and prevent partial retry exports', async () => {
  const lost = fixture({ fetchMore: async () => { throw new Error('reply lost') } })
  assert.equal(await lost.exports.exportCsv(lost.tab.key, 0), false)
  assert.equal(lost.tab.results[0].truncated, false); assert.equal(lost.tab.exports[0].incomplete, true)
  assert.equal(await lost.exports.exportCsv(lost.tab.key, 0), false)
  assert.ok(lost.tab.message.includes('Re-run'))
  let writes = 0
  const failed = fixture({ appendCsvExport: async () => { if (++writes === 2) throw new Error('disk full after fetch') } })
  assert.equal(await failed.exports.exportCsv(failed.tab.key, 0), false)
  assert.equal(failed.tab.exports[0].incomplete, true)
  assert.ok(!failed.calls.some(call => call[0] === 'finish'))
})

test('delayed cancellation cannot reach a new query after a cancelled fetch', async () => {
  const page = deferred(), started = deferred(), cancellation = deferred(), aborted = deferred()
  const f = fixture({ fetchMore: () => { started.resolve(); return page.promise }, cancel: () => cancellation.promise, abortCsvExport: async () => { aborted.resolve() } })
  const exporting = f.exports.exportCsv(f.tab.key, 0)
  await started.promise
  const cancelling = f.exports.cancel(f.tab.key)
  page.resolve({ rows: [['discarded']], rowCount: 1, truncated: true, ...output })
  await aborted.promise
  assert.equal(f.tab.exporting, true)
  assert.equal(await f.queries.run(f.tab.key, 'new SQL'), false)
  cancellation.resolve(); await cancelling; await exporting
  assert.equal(f.tab.exporting, false); assert.equal(f.tab.exports[0].incomplete, true)
  assert.ok(!f.chunks.join('').includes('discarded'))
})

test('bounded non-pageable results can be exported again and are labelled as limited', async () => {
  const f = fixture(); f.tab.results[0] = { ...grid(false), limited: true }
  assert.equal(await f.exports.exportCsv(f.tab.key, 0), true)
  assert.ok(f.tab.exportMessage.includes('limited'))
  assert.equal(await f.exports.exportCsv(f.tab.key, 0), true)
  assert.ok(!f.calls.some(call => call[0] === 'fetch'))
})

test('finish failures after cursor consumption require a rerun, not a silent first-page export', async () => {
  const f = fixture({ finishCsvExport: async () => { throw new Error('destination changed') } })
  assert.equal(await f.exports.exportCsv(f.tab.key, 0), false)
  assert.equal(f.tab.exports[0].incomplete, true)
  assert.ok(f.calls.some(call => call[0] === 'abort'))
  assert.equal(f.tab.exporting, false)
})

test('cancelling while the native picker is open does not consume the cursor', async () => {
  const picker = deferred(), f = fixture({ startCsvExport: () => picker.promise })
  const exporting = f.exports.exportCsv(f.tab.key, 0)
  await f.exports.cancel(f.tab.key)
  picker.resolve('export-token')
  assert.equal(await exporting, false)
  assert.equal(f.tab.results[0].truncated, true); assert.deepEqual(f.tab.exports, {})
  assert.ok(f.calls.some(call => call[0] === 'abort'))
  assert.ok(!f.calls.some(call => call[0] === 'fetch'))
})

test('empty results export their header and stale operations do not modify a newer grid', async () => {
  const empty = fixture(); empty.tab.results[0] = { ...grid(false), rows: [], rowCount: 0 }
  assert.equal(await empty.exports.exportCsv(empty.tab.key, 0), true)
  assert.equal(empty.chunks.join(''), csvHeader(['value']))
  const page = deferred(), fetching = deferred()
  const f = fixture({ fetchMore: () => { fetching.resolve(); return page.promise } })
  const exporting = f.exports.exportCsv(f.tab.key, 0)
  await fetching.promise
  const newer = grid(false)
  ++f.tab.operation; f.tab.results = [newer]
  page.resolve({ rows: [['stale']], rowCount: 1, truncated: false, ...output })
  assert.equal(await exporting, false)
  assert.deepEqual(f.tab.results[0], newer); assert.deepEqual(f.tab.exports, {})
  assert.ok(f.calls.some(call => call[0] === 'abort'))
})
