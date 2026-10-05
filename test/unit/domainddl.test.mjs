import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { typeDdl } = await sourceLoader()('server/catalog/ddl.ts')

const row = { typtype: 'd', schema: 'public', name: 'positive', base: 'integer', typnotnull: true, typdefault: '3' }
const pool = (record) => ({ query: async () => ({ rows: [record] }) })

test('pre-PG18 domains retain NOT NULL from typnotnull and their CHECK constraint', async () => {
  const ddl = await typeDdl(pool({ ...row, has_not_null_constraint: false, cons: 'CONSTRAINT pos CHECK ((VALUE > 0))' }), '1', 'public', 'positive')
  assert.ok(ddl.includes('DEFAULT 3 NOT NULL CONSTRAINT pos CHECK'))
  assert.equal(ddl.match(/NOT NULL/g)?.length, 1)
})

test('PG18 domains preserve named NOT NULL without emitting it twice', async () => {
  const ddl = await typeDdl(pool({ ...row, has_not_null_constraint: true, cons: 'CONSTRAINT "required value" NOT NULL CONSTRAINT pos CHECK ((VALUE > 0))' }), '1', 'public', 'positive')
  assert.ok(ddl.includes('DEFAULT 3 CONSTRAINT "required value" NOT NULL CONSTRAINT pos CHECK'))
  assert.equal(ddl.match(/NOT NULL/g)?.length, 1)
})

test('nullable domains do not acquire a NOT NULL constraint', async () => {
  const ddl = await typeDdl(pool({ ...row, typnotnull: false, has_not_null_constraint: false }), '1', 'public', 'positive')
  assert.ok(!ddl.includes('NOT NULL'))
})
