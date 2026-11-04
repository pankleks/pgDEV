import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { codePointsToIndex } = await sourceLoader()('web/lib/textoffset.ts')

// Error markers: PostgreSQL positions count characters, editor offsets UTF-16.

test('ASCII and BMP text map one to one', () => {
  assert.equal(codePointsToIndex('SELECT x', 7), 7)
  assert.equal(codePointsToIndex('zażółć x', 7), 7)
})

test('each astral character before the position shifts it by one unit', () => {
  const text = "SELECT '😀😀', nope"
  // "nope" is character 13 (0-based) to PostgreSQL, UTF-16 index 15.
  assert.equal(codePointsToIndex(text, 13), 15)
  assert.equal(text.slice(codePointsToIndex(text, 13)), 'nope')
})

test('positions past the end clamp to the text length', () => {
  assert.equal(codePointsToIndex('ab', 10), 2)
  assert.equal(codePointsToIndex('', 3), 0)
})
