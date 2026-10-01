import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogTree, filterTree } from '../desktop/src/lib/catalogTree.ts'
import { scopedHighlight } from '../web/src/lib/browserSearch.ts'

const tree = catalogTree({
  tables: [{ schema: 'public', name: 'items', oid: '1', relkind: 'r', parents: '', isPartition: false, isPartitioned: false, columns: [{ name: 'id', type: 'integer', nullable: false, defaultValue: null }], indexes: [], constraints: [{ name: 'items_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }], triggers: [] }],
  functions: [{ schema: 'public', name: 'echo', oid: '2', args: 'value integer', arguments: 'value integer', returns: 'integer', typeSig: 'integer', kind: 'function', comment: null }],
  views: [], types: [], sequences: [], builtins: [],
})

test('column and parameter filters preserve their object ancestry', () => {
  const columns = filterTree(tree, 'col id')
  assert.equal(columns.length, 1)
  assert.equal(columns[0].key, 'tables')
  assert.equal(columns[0].children[0].children[0].children[0].name, 'id')
  const parameters = filterTree(tree, 'param value')
  assert.equal(parameters[0].key, 'functions')
  assert.equal(parameters[0].children[0].children[0].name, 'value')
  assert.deepEqual(filterTree(tree, 'param integer'), [])
})

test('object targets retain OIDs and constraint parents; search does not mutate the tree', () => {
  const table = tree[0].children[0]
  assert.equal(table.target.oid, '1')
  assert.equal(table.children[2].children[0].target.parent, 'items')
  assert.equal(filterTree(tree, 'items table')[0].children[0].children.length, 4)
  assert.deepEqual(filterTree(tree, 'no_such_object'), [])
  assert.equal(tree[0].children[0].children.length, 4)
})

test('database labels are escaped before HTML highlighting', () => {
  assert.equal(scopedHighlight('<img onerror="bad">', [], null, ['table']), '&lt;img onerror=&quot;bad&quot;&gt;')
})
