import assert from 'node:assert/strict'
import test from 'node:test'
import { formatEditor } from '../desktop/src/lib/sqlEditing.ts'
import { sqlDiagnostic, diagnosticOffset } from '../desktop/src/lib/sqlDiagnostics.ts'

function editorFixture(text, start = 0, end = 0) {
  const history = [], edits = []
  const model = {
    getValue: () => text,
    getValueInRange: range => text.slice(range.start, range.end),
    getFullModelRange: () => ({ start: 0, end: text.length }),
  }
  const editor = {
    readOnly: false, stops: 0,
    getModel: () => model,
    getRawOptions() { return { readOnly: this.readOnly } },
    getSelection: () => ({ start, end, isEmpty: () => start === end }),
    pushUndoStop() { this.stops++ },
    executeEdits(source, changes) {
      history.push(text); edits.push({ source, changes })
      for (const change of changes) text = text.slice(0, change.range.start) + change.text + text.slice(change.range.end)
      return true
    },
    undo() { if (history.length) text = history.pop() },
  }
  return { editor, edits, get text() { return text } }
}

test('whole-document formatting uses the original PostgreSQL rules and is undoable', () => {
  const original = "select app.my_fn(id), payload ->> 'key' from people where id in (1,2);"
  const f = editorFixture(original)
  assert.equal(formatEditor(f.editor), true)
  assert.ok(f.text.includes('SELECT')); assert.ok(f.text.includes('app.my_fn(id)'))
  assert.ok(f.text.includes("payload->>'key'")); assert.ok(f.text.includes('IN(1, 2)'))
  assert.ok(f.text.endsWith('\n')); assert.equal(f.editor.stops, 2)
  assert.equal(f.edits[0].source, 'pgdev-format')
  assert.equal(formatEditor(f.editor), false)
  assert.equal(f.edits.length, 1)
  f.editor.undo(); assert.equal(f.text, original)
})

test('selection formatting leaves surrounding SQL unchanged and trims its trailing whitespace', () => {
  const selected = 'select a,b from sample', prefix = '-- keep prefix\n', suffix = '\n-- keep suffix'
  const f = editorFixture(prefix + selected + suffix, prefix.length, prefix.length + selected.length)
  assert.equal(formatEditor(f.editor), true)
  assert.ok(f.text.startsWith(prefix)); assert.ok(f.text.endsWith(suffix))
  assert.ok(f.text.includes('SELECT')); assert.ok(!f.edits[0].changes[0].text.endsWith('\n'))
  f.editor.undo(); assert.equal(f.text, prefix + selected + suffix)
})

test('empty/read-only editors and formatter failures never change text or undo state', () => {
  const empty = editorFixture(' \n\t')
  assert.equal(formatEditor(empty.editor), false); assert.equal(empty.editor.stops, 0)
  const locked = editorFixture('select 1'); locked.editor.readOnly = true
  assert.equal(formatEditor(locked.editor), false); assert.equal(locked.editor.stops, 0)
  const invalid = editorFixture('select 1')
  assert.throws(() => formatEditor(invalid.editor, () => { throw new Error('bad SQL') }), /bad SQL/)
  assert.equal(invalid.text, 'select 1'); assert.equal(invalid.edits.length, 0); assert.equal(invalid.editor.stops, 0)
})

test('PostgreSQL Unicode character positions map to Monaco UTF-16 offsets', () => {
  const sql = "SELECT 'ą😀';\nSELECT broken"
  const position = [...sql.slice(0, sql.indexOf('broken'))].length + 1
  const diagnostic = sqlDiagnostic({ message: 'bad column', position }, { sql, documentSql: sql, startOffset: 0 }, sql)
  assert.equal(diagnosticOffset(diagnostic, sql), sql.indexOf('broken'))
})

test('selection positions include the captured selection origin, not its first occurrence', () => {
  const prefix = 'SELECT broken;\n-- 😀\n', sql = 'SELECT broken'
  const documentSql = prefix + sql
  const diagnostic = sqlDiagnostic({ message: 'missing column', position: 8 }, { sql, documentSql, startOffset: prefix.length }, documentSql)
  assert.equal(diagnosticOffset(diagnostic, documentSql), documentSql.lastIndexOf('broken'))
})

test('edited SQL, unrelated utility commands and invalid offsets produce no diagnostic', () => {
  const sql = 'SELECT missing', submission = { sql, documentSql: sql, startOffset: 0 }
  const error = { position: 8, message: 'missing column' }
  assert.equal(sqlDiagnostic(error, submission, 'SELECT changed'), null)
  assert.equal(sqlDiagnostic(error, { ...submission, sql: 'COMMIT' }, sql), null)
  assert.equal(sqlDiagnostic(error, { ...submission, startOffset: -1 }, sql), null)
  for (const position of [null, undefined, 0, -1, 2.5, NaN, Infinity, '8', 999]) {
    assert.equal(sqlDiagnostic({ position }, submission, sql), null)
  }
  const diagnostic = sqlDiagnostic(error, submission, sql)
  assert.equal(diagnosticOffset(diagnostic, `${sql};`), null)
  assert.equal(sqlDiagnostic({ position: [...sql].length + 1 }, submission, sql).position, sql.length + 1)
})
