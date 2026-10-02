import assert from 'node:assert/strict'
import test from 'node:test'
import { gridClipboardText, createClipboardController, CLIPBOARD_BYTES } from '../desktop/src/lib/queryClipboard.ts'
import { createQueryWorkspace, createQueryController } from '../desktop/src/lib/queryWorkspace.ts'
import { toDelimited } from '../web/src/lib/gridio.ts'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(writeClipboardText = async () => {}) {
  let key = 0
  const workspace = createQueryWorkspace(() => `tab${++key}`)
  const tab = workspace.tabs[0]
  tab.results = [{ kind: 'data', columns: ['n'], rows: [['9223372036854775807']], rowCount: 1, truncated: true, limited: false }]
  const queries = createQueryController(workspace, {}, () => null, () => false, () => `tab${++key}`)
  const clipboard = createClipboardController(workspace, { writeClipboardText })
  return { workspace, tab, queries, clipboard }
}

test('clipboard TSV matches the original rules and preserves lossless textual carriers', () => {
  const columns = ['=header', 'normal', 'last'], rows = [
    ['9223372036854775807', '12345678901234567890.123456789', null],
    ['@formula', 'tab\tnew\nline', { key: 'value' }],
    ['😀ą', false, 7],
  ]
  const text = gridClipboardText(columns, rows)
  assert.equal(text, toDelimited(columns, rows, '\t'))
  assert.ok(text.includes('9223372036854775807')); assert.ok(text.includes('12345678901234567890.123456789'))
  assert.ok(text.startsWith("'=header\t")); assert.ok(text.includes("'@formula"))
  assert.ok(text.includes('tab new line')); assert.ok(!text.startsWith('\uFEFF'))
})

test('clipboard limits count UTF-8 bytes and reject oversized output before calling the OS', async () => {
  assert.equal(gridClipboardText(['header'], []), 'header')
  assert.equal(new TextEncoder().encode(gridClipboardText(['x'.repeat(CLIPBOARD_BYTES)], [])).length, CLIPBOARD_BYTES)
  assert.throws(() => gridClipboardText(['header'], [['😀'.repeat(CLIPBOARD_BYTES / 4)]]), /8 MiB/)
  let calls = 0
  const f = fixture(async () => { calls++ })
  f.tab.results[0].rows = [['x'.repeat(CLIPBOARD_BYTES)]]
  assert.equal(await f.clipboard.copy(f.tab.key, 0), false)
  assert.equal(calls, 0); assert.ok(f.tab.clipboardError.includes('CSV export'))
})

test('copying loaded rows never fetches a cursor or changes results and transactions', async () => {
  const payloads = [], f = fixture(async text => { payloads.push(text) })
  f.tab.transactionId = 'transaction1'
  const source = f.tab.results[0]
  assert.equal(await f.clipboard.copy(f.tab.key, 0), true)
  assert.deepEqual(payloads, ['n\n9223372036854775807'])
  assert.equal(f.tab.results[0], source); assert.equal(source.truncated, true)
  assert.equal(f.tab.transactionId, 'transaction1')
  assert.ok(f.tab.clipboardMessage.includes('1 loaded row')); assert.ok(f.tab.clipboardMessage.includes('not retained'))
})

test('switching tabs during a copy keeps status on its captured tab and blocks overlapping copies', async () => {
  const pending = deferred(), f = fixture(() => pending.promise)
  const copying = f.clipboard.copy(f.tab.key, 0)
  const other = f.queries.addTab(); other.results = [{ ...f.tab.results[0], rows: [['other']] }]
  assert.equal(await f.clipboard.copy(other.key, 0), false)
  pending.resolve(); await copying
  assert.ok(f.tab.clipboardMessage); assert.equal(other.clipboardMessage, '')
  assert.equal(f.workspace.activeKey, other.key)
})

test('stale success and error responses do not annotate a newer query result', async () => {
  const pending = deferred(), f = fixture(() => pending.promise)
  const copying = f.clipboard.copy(f.tab.key, 0)
  ++f.tab.operation; f.tab.results = []
  pending.resolve(); await copying
  assert.equal(f.tab.clipboardMessage, '')
  const failed = fixture(async () => { throw new Error('clipboard unavailable') })
  assert.equal(await failed.clipboard.copy(failed.tab.key, 0), false)
  assert.equal(failed.tab.clipboardError, 'clipboard unavailable')
  assert.equal(failed.tab.results[0].truncated, true)
})

test('consumed/limited grids are explicitly labelled as loaded-only copies', async () => {
  const f = fixture()
  f.tab.results[0].truncated = false
  f.tab.exports[0] = { rows: 100, incomplete: false }
  await f.clipboard.copy(f.tab.key, 0)
  assert.ok(f.tab.clipboardMessage.includes('not retained'))
  assert.equal(await f.clipboard.copy(f.tab.key, 99), false)
  f.queries.resetConnection()
  assert.equal(f.tab.clipboardMessage, ''); assert.equal(f.tab.clipboardError, '')
})
