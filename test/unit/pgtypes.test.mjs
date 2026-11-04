import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { rawTextTypes } = await sourceLoader()('server/pgtypes.ts')

// JSON/temporal/array columns must reach the browser as raw server text:
// the driver's parsers lose bigint precision, rewrite number spellings and
// turn dates into shifted ISO strings.

test('lossy type ids parse as identity', () => {
  for (const oid of [114, 3802, 1082, 1083, 1114, 1184, 1266, 1182, 1183, 1115, 1185, 1270,
    1000, 1005, 1007, 1016, 1009, 1014, 1015]) {
    const parse = rawTextTypes.getTypeParser(oid)
    assert.equal(parse('{"id":9007199254740993}'), '{"id":9007199254740993}', `oid ${oid}`)
  }
})

test('arrays, interval, geometric and range types stay PostgreSQL text', () => {
  // Their driver parsers produce JS arrays/objects whose JSON text PostgreSQL
  // cannot read back, so editing such a cell would fail on save.
  const cases = {
    1231: '{1.10,2.20}', // numeric[]
    2951: '{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}', // uuid[]
    3807: '{"{\\"a\\": 1}"}', // jsonb[]
    1022: '{1.5,NaN}', // float8[]
    1186: '1 day 02:00:00', // interval
    600: '(1,2)', // point
    718: '<(1,2),3>', // circle
    3904: '[1,5)', // int4range
  }
  for (const [oid, text] of Object.entries(cases)) {
    assert.equal(rawTextTypes.getTypeParser(Number(oid))(text), text, `oid ${oid}`)
  }
})

test('lossless scalars keep the driver parser', () => {
  assert.equal(rawTextTypes.getTypeParser(23)('42'), 42)
  assert.equal(rawTextTypes.getTypeParser(21)('-7'), -7)
  assert.equal(rawTextTypes.getTypeParser(16)('t'), true)
  assert.equal(rawTextTypes.getTypeParser(701)('1.5'), 1.5)
  assert.ok(Buffer.isBuffer(rawTextTypes.getTypeParser(17)('\\x00ff')), 'bytea stays a Buffer for the size label')
})

test('int8 and numeric stay exact text', () => {
  assert.equal(rawTextTypes.getTypeParser(20)('9007199254740993'), '9007199254740993')
  assert.equal(rawTextTypes.getTypeParser(1700)('12345678901234567890.123'), '12345678901234567890.123')
})
