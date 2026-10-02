import assert from 'node:assert/strict'
import test from 'node:test'
import { parameterScript, applyParameterScript } from '../desktop/src/lib/parameterMapping.ts'
import { mapParams } from '../web/src/lib/preparemap.ts'

test('native previews match the original PREPARE templates, including gaps and repeated parameters', () => {
  const sql = 'SELECT $3::text, $1::integer, $3::text'
  assert.equal(parameterScript(sql), mapParams(sql))
  assert.equal(parameterScript(sql, '[7, null, "hello"]'), mapParams(sql, [7, null, 'hello']))
  assert.ok(parameterScript(sql).includes('NULL -- $3'))
})

test('literals, identifiers, comments and routine bodies do not introduce parameters', () => {
  const sql = `SELECT '$1', "column$2", a$3, $$ $4 $$, $5::text /* $6 /* $7 */ */ -- $8\n`
  const script = parameterScript(sql, '[null, null, null, null, "text"]')
  assert.equal(script, mapParams(sql, [null, null, null, null, 'text']))
  assert.ok(script.includes("'text' -- $5")); assert.ok(!script.includes('-- $6\n'))
  assert.throws(() => parameterScript(`DO $$ BEGIN RAISE NOTICE '$1'; END $$`), /No query parameters/)
})

test('optional JSON/comment payloads reuse literal escaping and missing-value rules', () => {
  const sql = 'SELECT $1::text, $2::boolean, $3::integer[], $4::jsonb, $5::text'
  const values = ["O'Reilly", true, [1, 2], { key: "a'b" }]
  const script = parameterScript(sql, '-- ' + JSON.stringify(values))
  assert.equal(script, mapParams(sql, values))
  assert.ok(script.includes("'O''Reilly'")); assert.ok(script.includes('ARRAY[1, 2]'))
  assert.ok(script.includes('NULL -- $5'))
  assert.equal(parameterScript('SELECT $1::integer', '42'), mapParams('SELECT $1::integer', [42]))
  assert.throws(() => parameterScript(sql, '[invalid]'), /Could not parse/)
})

test('unsafe integers, excessive nesting and unbounded parameter indices fail before generation', () => {
  assert.throws(() => parameterScript('SELECT $1', '[9007199254740993]'), /JSON strings/)
  assert.throws(() => parameterScript('SELECT $1', '[1e400]'), /JSON strings/)
  assert.throws(() => parameterScript('SELECT $1', JSON.stringify([[[{ huge: 9007199254740992 }]]])), /JSON strings/)
  assert.ok(parameterScript('SELECT $1::bigint', '["9223372036854775807"]').includes("'9223372036854775807'"))
  assert.throws(() => parameterScript('SELECT $65536'), /65535/)
  assert.throws(() => parameterScript('SELECT $99999999999999999999999999'), /65535/)
  assert.throws(() => parameterScript('SELECT $1', '['.repeat(35) + '0' + ']'.repeat(35)), /nested too deeply/)
  assert.throws(() => parameterScript('SELECT $1 -- ' + '😀'.repeat(300_000)), /1 MiB/)
})

function editorFixture(text) {
  const history = [], edits = []
  function positionAt(offset) {
    const lines = text.slice(0, offset).split('\n')
    return { lineNumber: lines.length, column: lines.at(-1).length + 1 }
  }
  function offsetAt(position) {
    return text.split('\n').slice(0, position.lineNumber - 1).reduce((offset, line) => offset + line.length + 1, 0) + position.column - 1
  }
  const model = { getValue: () => text, getPositionAt: positionAt }
  const editor = {
    readOnly: false, stops: 0,
    getModel: () => model,
    getRawOptions() { return { readOnly: this.readOnly } },
    pushUndoStop() { this.stops++ },
    executeEdits(source, changes) {
      history.push(text); edits.push({ source, changes })
      for (const change of changes) {
        const start = offsetAt({ lineNumber: change.range.startLineNumber, column: change.range.startColumn })
        const end = offsetAt({ lineNumber: change.range.endLineNumber, column: change.range.endColumn })
        text = text.slice(0, start) + change.text + text.slice(end)
      }
      return true
    },
    undo() { if (history.length) text = history.pop() },
  }
  return { editor, edits, get text() { return text } }
}

test('generating or cancelling a preview leaves SQL untouched; applying is one undoable edit', () => {
  const sql = 'SELECT $1::integer', f = editorFixture(sql)
  const target = { tabKey: 'tab', submission: { sql, documentSql: sql, startOffset: 0 } }
  const preview = parameterScript(sql, '[7]')
  assert.equal(f.text, sql); assert.equal(f.edits.length, 0)
  assert.equal(applyParameterScript(f.editor, 'tab', target, preview), true)
  assert.equal(f.text, preview); assert.equal(f.editor.stops, 2); assert.equal(f.edits.length, 1)
  assert.equal(f.edits[0].source, 'pgdev-prepare')
  f.editor.undo(); assert.equal(f.text, sql)
})

test('selection application retains surrounding Unicode text exactly', () => {
  const prefix = '-- 😀 before\n', sql = 'SELECT $1::text', suffix = '\n-- untouched after'
  const original = prefix + sql + suffix, f = editorFixture(original)
  const target = { tabKey: 'tab', submission: { sql, documentSql: original, startOffset: prefix.length } }
  const preview = parameterScript(sql)
  applyParameterScript(f.editor, 'tab', target, preview)
  assert.equal(f.text, prefix + preview + suffix)
  f.editor.undo(); assert.equal(f.text, original)
})

test('stale queries, wrong tabs and read-only editors reject application without edits', () => {
  const sql = 'SELECT $1', target = { tabKey: 'first', submission: { sql, documentSql: sql, startOffset: 0 } }
  const f = editorFixture(sql), preview = parameterScript(sql)
  assert.throws(() => applyParameterScript(f.editor, 'other', target, preview), /changed/)
  assert.throws(() => applyParameterScript(f.editor, 'first', { ...target, submission: { ...target.submission, documentSql: 'different SQL' } }, preview), /changed/)
  f.editor.readOnly = true
  assert.throws(() => applyParameterScript(f.editor, 'first', target, preview), /read-only/)
  assert.equal(f.text, sql); assert.equal(f.edits.length, 0); assert.equal(f.editor.stops, 0)
})
