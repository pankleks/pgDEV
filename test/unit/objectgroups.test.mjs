import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const { entriesWithin } = await sourceLoader()('web/lib/objectgroups.ts')

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
