import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { parseSelectedName, resolveDefinition } = await load('web/lib/definition.ts')

// "Open Definition" in the editor: the selected text must be exactly one
// (optionally schema-qualified) name of a loaded catalog object.

const table = (schema, name, oid, extra = {}) => ({
  schema, name, oid, columns: [], indexes: [], constraints: [], triggers: [],
  isPartition: false, isPartitioned: false, parents: '', relkind: 'r', ...extra,
})
const fn = (schema, name, oid) => ({ schema, name, oid, args: '', returns: 'void', typeSig: '', kind: 'function' })

const data = () => ({
  tables: [
    table('public', 'orders', '10', {
      indexes: [{ name: 'orders_pkey', type: 'primary', method: 'btree' }, { name: 'orders_by_date', type: 'normal', method: 'btree' }],
      constraints: [{ name: 'orders_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }],
      triggers: [{ name: 'orders_audit', definition: '' }],
    }),
    table('sales', 'orders', '11'),
    table('sales', 'Order Lines', '12'),
    table('a', 'dup', '13', { triggers: [{ name: 'same_trigger', definition: '' }] }),
    table('b', 'dup', '14', { triggers: [{ name: 'same_trigger', definition: '' }] }),
  ],
  views: [
    { schema: 'public', name: 'open_orders', oid: '20', materialized: false, columns: [] },
    { schema: 'rep', name: 'daily', oid: '21', materialized: true, columns: [] },
  ],
  functions: [
    fn('public', 'total', '30'), fn('public', 'total', '31'), fn('util', 'total', '32'),
    fn('util', 'only_util', '33'), fn('x', 'twice', '34'), fn('y', 'twice', '35'),
  ],
  types: [{ schema: 'public', name: 'mood', oid: '40', kind: 'enum', detail: '' }],
  sequences: [{ schema: 'public', name: 'orders_id_seq', oid: '50', dataType: 'bigint', detail: '' }],
  builtins: [fn('pg_catalog', 'now', '60')],
})

test('parses one optionally qualified, optionally quoted name', () => {
  assert.deepEqual(parseSelectedName('orders'), ['', 'orders'])
  assert.deepEqual(parseSelectedName('  Orders  '), ['', 'orders'], 'unquoted names fold to lower case')
  assert.deepEqual(parseSelectedName('Sales.Orders'), ['sales', 'orders'])
  assert.deepEqual(parseSelectedName('sales . "Order Lines"'), ['sales', 'Order Lines'])
  assert.deepEqual(parseSelectedName('"a""b"'), ['', 'a"b'])
  for (const text of ['', 'a b', 'a.b.c', 'orders;', 'fn(1)', '1abc', '"unterminated', 'a.', 'x'.repeat(301)]) {
    assert.equal(parseSelectedName(text), null, text)
  }
})

test('resolves tables and views, preferring public for unqualified names', () => {
  assert.deepEqual(resolveDefinition(data(), 'orders'), [{ type: 'table', schema: 'public', name: 'orders', oid: '10' }])
  assert.deepEqual(resolveDefinition(data(), 'sales.orders'), [{ type: 'table', schema: 'sales', name: 'orders', oid: '11' }])
  assert.deepEqual(resolveDefinition(data(), 'sales."Order Lines"'), [{ type: 'table', schema: 'sales', name: 'Order Lines', oid: '12' }])
  assert.deepEqual(resolveDefinition(data(), '"Order Lines"'), [{ type: 'table', schema: 'sales', name: 'Order Lines', oid: '12' }],
    'a unique non-public match resolves')
  assert.deepEqual(resolveDefinition(data(), 'daily'), [{ type: 'view', schema: 'rep', name: 'daily', oid: '21' }])
  assert.deepEqual(resolveDefinition(data(), 'OPEN_ORDERS'), [{ type: 'view', schema: 'public', name: 'open_orders', oid: '20' }])
  assert.deepEqual(resolveDefinition(data(), 'dup'), [], 'never guesses between several non-public schemas')
  assert.deepEqual(resolveDefinition(data(), '"Orders"'), [], 'quoted names are case-sensitive')
})

test('resolves sequences, types and every overload of a function in one schema', () => {
  assert.deepEqual(resolveDefinition(data(), 'orders_id_seq'), [{ type: 'sequence', schema: 'public', name: 'orders_id_seq', oid: '50' }])
  assert.deepEqual(resolveDefinition(data(), 'mood'), [{ type: 'type', schema: 'public', name: 'mood', oid: '40' }])
  assert.deepEqual(resolveDefinition(data(), 'total').map((t) => t.oid), ['30', '31'], 'public overloads only')
  assert.deepEqual(resolveDefinition(data(), 'util.total').map((t) => t.oid), ['32'])
  assert.deepEqual(resolveDefinition(data(), 'only_util').map((t) => t.oid), ['33'])
  assert.deepEqual(resolveDefinition(data(), 'twice'), [], 'overloads in two non-public schemas are ambiguous')
  assert.deepEqual(resolveDefinition(data(), 'now'), [], 'built-ins have no user DDL to open')
})

test('resolves table-owned objects with their parent table', () => {
  assert.deepEqual(resolveDefinition(data(), 'orders_pkey'),
    [{ type: 'constraint', schema: 'public', name: 'orders_pkey', parent: 'orders' }], 'a key constraint wins over its index')
  assert.deepEqual(resolveDefinition(data(), 'orders_by_date'),
    [{ type: 'index', schema: 'public', name: 'orders_by_date', parent: 'orders' }])
  assert.deepEqual(resolveDefinition(data(), 'public.orders_audit'),
    [{ type: 'trigger', schema: 'public', name: 'orders_audit', parent: 'orders' }])
  assert.deepEqual(resolveDefinition(data(), 'same_trigger'), [], 'same name on tables in two schemas is ambiguous')
  assert.deepEqual(resolveDefinition(data(), 'b.same_trigger'), [{ type: 'trigger', schema: 'b', name: 'same_trigger', parent: 'dup' }])
})

test('nothing resolves without a catalog or for text that is not one name', () => {
  assert.deepEqual(resolveDefinition(null, 'orders'), [])
  for (const text of ['orders o', 'select * from orders', 'missing', 'public.missing', 'orders.id']) {
    assert.deepEqual(resolveDefinition(data(), text), [], text)
  }
})
