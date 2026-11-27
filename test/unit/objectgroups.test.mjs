import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { entriesWithin, entryRows, groupKeysOf, groupNamedObjects } = await sourceLoader()('web/lib/objectgroups.ts')

let oid = 0
const objects = (names, schema = 'public') => names.map((name) => ({ schema, name, oid: String(++oid) }))
// A readable tree: items by name, folders as { name: [...children] }.
const shape = (entries) => entries.map((e) => e.kind === 'group' ? { [e.name]: shape(e.children) } : e.name)
const group = (names) => shape(groupNamedObjects(objects(names), true, 'function'))

test('names sharing a prefix nest in one folder per level (issue #4)', () => {
  assert.deepEqual(group([
    'employee', 'employee', 'employee_document_rev', 'employee_document_rev', 'employee_get', 'employee_get',
    'employee_skill', 'employee_skill_get', 'employee_skill_add', 'employee_unit', 'employee_unit', 'event_log',
  ]), [
    { employee: [
      'employee', 'employee',
      { employee_document_rev: ['employee_document_rev', 'employee_document_rev'] },
      { employee_get: ['employee_get', 'employee_get'] },
      { employee_skill: ['employee_skill', 'employee_skill_add', 'employee_skill_get'] },
      { employee_unit: ['employee_unit', 'employee_unit'] },
    ] },
    'event_log',
  ])
})

test('a folder sorts by its name, before its longer siblings', () => {
  // The catalog order put the "document" folder after document_rev_is_last.
  assert.deepEqual(group(['document_rev_get', 'document_rev_is_last', 'document_add', 'document_update', 'documents']), [
    { document: ['document_add', { document_rev: ['document_rev_get', 'document_rev_is_last'] }, 'document_update'] },
    'documents',
  ])
})

test('a folder holding only one subfolder is skipped', () => {
  assert.deepEqual(group(['order_line_add', 'order_line_get', 'other']), [{ order_line: ['order_line_add', 'order_line_get'] }, 'other'])
})

test('lone names stay items, and grouping off keeps the catalog order', () => {
  assert.deepEqual(group(['beta', 'alpha_x']), ['alpha_x', 'beta'])
  assert.deepEqual(shape(groupNamedObjects(objects(['b_1', 'a', 'b_2']), false, 'table')), ['b_1', 'a', 'b_2'])
})

test('a leading underscore never makes a nameless folder', () => {
  assert.deepEqual(group(['_tmp_a', '_tmp_b']), [{ _tmp: ['_tmp_a', '_tmp_b'] }])
})

test('schemas group separately and keys keep their saved format', () => {
  const entries = groupNamedObjects([...objects(['x_a', 'x_b'], 'app'), ...objects(['x_a', 'x_b'])], true, 'view')
  assert.deepEqual(entries.map((e) => e.key), ['group\u0000view\u0000app\u0000x', 'group\u0000view\u0000public\u0000x'])
})

test('nested group keys and open rows are counted at every depth', () => {
  const entries = groupNamedObjects(objects(['a_b_1', 'a_b_2', 'a_c', 'z']), true, 'table')
  assert.deepEqual(groupKeysOf(entries), ['group\u0000table\u0000public\u0000a', 'group\u0000table\u0000public\u0000a_b'])
  const [a] = entries
  assert.equal(entryRows(a, () => false), 1)
  assert.equal(entryRows(a, (g) => g.name === 'a'), 3)
  assert.equal(entryRows(a, () => true), 5)
  assert.deepEqual(a.objects.map((o) => o.name), ['a_b_1', 'a_b_2', 'a_c'])
})

// The object browser renders each section page by page; this decides how many
// entries fit one page of rows.

test('entries are taken until the row budget would be exceeded', () => {
  const ones = Array.from({ length: 1000 }, () => 1)
  assert.equal(entriesWithin(ones, (rows) => rows, 300), 300)
  assert.equal(entriesWithin(ones.slice(0, 10), (rows) => rows, 300), 10)
  assert.equal(entriesWithin([], (rows) => rows, 300), 0)
})

test('open groups count their children; a group is never split', () => {
  // A closed group is one row, an open one its header plus children.
  assert.equal(entriesWithin([1, 1, 51, 1], (rows) => rows, 52), 2)
  assert.equal(entriesWithin([1, 51, 1], (rows) => rows, 52), 2)
})

test('the first entry always shows, even when it alone exceeds the budget', () => {
  assert.equal(entriesWithin([5000, 1], (rows) => rows, 300), 1)
})
