import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { csvEscape, csvHeader, csvRows, cellToText, formatCellForDisplay, formatCellPreview, CELL_PREVIEW_CHARS, toDelimited } = await load('web/lib/gridio.ts')

test('csvEscape neutralises spreadsheet formula starters', () => {
  // A database value must not execute when the export is opened.
  assert.equal(csvEscape('=cmd|calc'), "'=cmd|calc")
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)")
  // Starts like a number but is not one: still a possible formula.
  assert.equal(csvEscape('-1+cmd|calc'), "'-1+cmd|calc")
  assert.equal(csvEscape('+48 123 456'), "'+48 123 456")
  assert.equal(csvEscape('-2-3'), "'-2-3")
  assert.equal(csvEscape('-'), "'-")
  assert.equal(csvEscape('-Infinity'), "'-Infinity")
  assert.equal(csvEscape(' -1'), "' -1")
  assert.equal(csvEscape('\t=x'), "'\t=x")
  assert.equal(csvEscape(' =x'), "' =x")
})

test('csvEscape leaves plain numbers intact', () => {
  // Negative and signed numbers cannot execute; prefixing them would turn
  // every negative value into text in the spreadsheet.
  for (const n of ['-1', '+1', '-12.5', '-0.001', '-.5', '+3.', '-1e5', '-1.5E-10', '-12345678901234567890.123']) {
    assert.equal(csvEscape(n), n, n)
  }
  assert.equal(csvRows([[-3, '-12.50']]), '-3,-12.50\n')
})

test('csvEscape leaves ordinary values alone', () => {
  assert.equal(csvEscape('hello'), 'hello')
  assert.equal(csvEscape(''), '')
  assert.equal(csvEscape('a b c'), 'a b c')
})

test('csvEscape quotes values containing delimiters, quotes or newlines', () => {
  assert.equal(csvEscape('a"b'), '"a""b"')
  assert.equal(csvEscape('a,b'), '"a,b"')
  assert.equal(csvEscape('a\nb'), '"a\nb"')
  assert.equal(csvEscape('a\r\nb'), '"a\r\nb"')
})

test('cellToText renders carriers readably', () => {
  assert.equal(cellToText(null), '')
  assert.equal(cellToText(undefined), '')
  assert.equal(cellToText(0), '0')
  assert.equal(cellToText(false), 'false')
  assert.equal(cellToText({ a: 1 }), '{"a":1}')
  assert.equal(cellToText(new Date('2020-01-02T03:04:05Z')), '2020-01-02T03:04:05.000Z')
})

test('formatCellForDisplay distinguishes NULL from the empty string', () => {
  assert.equal(formatCellForDisplay(null), 'NULL')
  assert.equal(formatCellForDisplay(undefined), 'NULL')
  assert.equal(formatCellForDisplay(''), '')
})

test('toDelimited writes a header row and keeps TSV free of tabs and newlines', () => {
  assert.equal(toDelimited(['a', 'b'], [[1, 2]], ','), 'a,b\n1,2')
  assert.equal(toDelimited(['a'], [[null]], ','), 'a\n')
  // A tab in a value would otherwise shift every later column.
  assert.equal(toDelimited(['a'], [['x\ty']], '\t'), 'a\nx y')
  assert.equal(toDelimited(['a'], [['x\ny']], '\t'), 'a\nx y')
})

test('toDelimited escapes header names too', () => {
  assert.equal(toDelimited(['a,b'], [[1]], ','), '"a,b"\n1')
})

test('csvHeader and csvRows write BOM, header and newline-terminated pages', () => {
  assert.equal(csvHeader(['a', 'b,b']), '\uFEFFa,"b,b"\n')
  assert.equal(csvRows([[1, '=cmd']], ), '1,\'=cmd\n')
  // The streamed path needs the same formula guard as the single-string one.
  assert.equal(csvRows([['x\ty']], ), 'x\ty\n')
})

test('TSV copy neutralises spreadsheet formula starters like the CSV path', () => {
  // The clipboard path feeds Excel/Sheets just as a .csv download does, so
  // the formula guard must apply before TSV flattening.
  assert.equal(toDelimited(['v'], [['=cmd|calc']], '\t'), 'v\n\'=cmd|calc')
  assert.equal(toDelimited(['v'], [['+1']], '\t'), 'v\n+1')
  assert.equal(toDelimited(['v'], [['-2']], '\t'), 'v\n-2')
  assert.equal(toDelimited(['v'], [['-2+cmd']], '\t'), 'v\n\'-2+cmd')
  assert.equal(toDelimited(['v'], [['@SUM(A1)']], '\t'), 'v\n\'@SUM(A1)')
  assert.equal(toDelimited(['v'], [['\t=x']], '\t'), 'v\n\' =x')
  assert.equal(toDelimited(['v'], [['hello']], '\t'), 'v\nhello')
})

test('grid cells render a bounded preview of long values', () => {
  assert.equal(formatCellPreview('short'), 'short')
  assert.equal(formatCellPreview(null), 'NULL')
  const long = 'x'.repeat(5_000_000)
  const preview = formatCellPreview(long)
  assert.equal(preview.length, CELL_PREVIEW_CHARS + 1)
  assert.ok(preview.endsWith('…'))
  // Never splits an emoji (a surrogate pair) at the cut.
  const emoji = `${'a'.repeat(CELL_PREVIEW_CHARS - 1)}😀tail`
  assert.equal(formatCellPreview(emoji), `${'a'.repeat(CELL_PREVIEW_CHARS - 1)}…`)
  // Copy paths keep the full value.
  assert.equal(formatCellForDisplay(long).length, long.length)
})
