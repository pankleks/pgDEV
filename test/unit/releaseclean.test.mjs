import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseClean } from '../../server/dist/pools.js'

// A client that ran user SQL goes back to the pool reset, or not at all.

function client(discardFails) {
  const calls = { queries: [], released: [] }
  return {
    calls,
    async query(sql) {
      calls.queries.push(sql)
      if (discardFails) throw new Error('DISCARD ALL cannot run inside a transaction block')
      return { rows: [] }
    },
    release(destroy) {
      calls.released.push(destroy)
    },
  }
}

test('a resettable client is discarded and returned to the pool', async () => {
  const c = client(false)
  await releaseClean(c)
  assert.deepEqual(c.calls.queries, ['DISCARD ALL'])
  assert.deepEqual(c.calls.released, [false])
})

test('a client that cannot be reset is destroyed instead of pooled', async () => {
  const c = client(true)
  await releaseClean(c)
  assert.deepEqual(c.calls.released, [true])
})

test('releaseClean never throws, even on an already released client', async () => {
  const c = client(false)
  c.release = () => { throw new Error('Release called on client which has already been released') }
  await releaseClean(c)
})
