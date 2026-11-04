import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const sessions = await sourceLoader()('server/sessions.ts')
const {
  sessionKey, getSession, transactionState, parseTransactionId, assertTransaction,
  setSession, beginSession, finishSession, teardownSession, closeSessionsForClient,
} = sessions

// Per-tab transaction state: the pinning, 409-conflict and reaper
// arming rules decide whether a batch runs, waits or is refused.

let seq = 0
const key = () => `conn-1|tab-sessions-${++seq}`
const stubClient = () => {
  const queries = []
  return {
    queries,
    released: 0,
    query: async (sql) => {
      queries.push(sql)
      return { rows: [] }
    },
    release: () => {},
  }
}
const tracked = () => {
  const c = stubClient()
  let released = 0
  const orig = c.release
  c.release = () => {
    released++
    orig()
  }
  return { client: c, wasReleased: () => released > 0 }
}

test('sessionKey joins connection and tab', () => {
  assert.equal(sessionKey('c', 't'), 'c|t')
})

test('parseTransactionId passes through absence and validates presence', () => {
  assert.equal(parseTransactionId(undefined), undefined)
  assert.equal(parseTransactionId(null), null)
  assert.equal(parseTransactionId('abc'), 'abc')
  for (const bad of ['', 'x'.repeat(129), 42, {}, []]) {
    assert.throws(() => parseTransactionId(bad), /Invalid transaction id/, JSON.stringify(bad))
  }
})

test('assertTransaction skips legacy callers and conflicts on change', async () => {
  const k = key()
  const { client } = tracked()
  setSession(k, 'conn-1', client)
  const id = transactionState(k).transactionId
  assertTransaction(k, undefined)
  assertTransaction(k, id)
  // A tab without that transaction (it ended, or never existed) conflicts.
  const kc = key()
  let err
  try {
    assertTransaction(kc, id)
  } catch (e) {
    err = e
  }
  assert.match(err?.message ?? '', /ended or changed/)
  assert.equal(err?.statusCode, 409)
  assert.equal(err?.code, 'TRANSACTION_CHANGED')
  await teardownSession(k, 'rollback')
})

test('transactionState reflects only open user transactions', async () => {
  assert.deepEqual(transactionState('conn-1|missing'), { transactionId: null, transactionOpen: false })
  const { client } = tracked()
  const kt = key()
  setSession(kt, 'conn-1', client)
  const st = transactionState(kt)
  assert.equal(st.transactionOpen, true)
  assert.ok(st.transactionId)
  // A close requested while a batch runs already reports the transaction gone.
  beginSession(kt)
  await teardownSession(kt, 'rollback')
  assert.deepEqual(transactionState(kt), { transactionId: null, transactionOpen: false })
  await finishSession(kt, getSession(kt), 'keep')
})

test('the reaper is armed while a transaction sits idle, not while a batch runs', async () => {
  const { client } = tracked()
  const k = key()
  setSession(k, 'conn-1', client)
  assert.ok(getSession(k).timer, 'an idle user transaction arms the reaper')
  const s = beginSession(k)
  assert.equal(getSession(k).timer, null, 'a running batch disarms it')
  await finishSession(k, s, 'keep')
  assert.ok(getSession(k).timer, 'keeping the transaction re-arms it')
  await teardownSession(k, 'rollback')
})

test('beginSession guards the busy flag and disarms the timer', async () => {
  const { client } = tracked()
  const k = key()
  setSession(k, 'conn-1', client)
  const s = beginSession(k)
  assert.ok(s)
  assert.equal(beginSession(k), undefined, 'a busy session cannot be entered twice')
  assert.equal(getSession(k).timer, null)
  await finishSession(k, s, 'rollback')
  assert.equal(getSession(k), undefined)
})

test('teardown of a busy session defers to the running batch', async () => {
  const { client, wasReleased } = tracked()
  const k = key()
  setSession(k, 'conn-1', client)
  const s = beginSession(k)
  await teardownSession(k, 'rollback')
  assert.equal(wasReleased(), false, 'the running batch still owns the client')
  assert.equal(getSession(k).closeRequested, true)
  await finishSession(k, s, 'keep')
  assert.equal(getSession(k), undefined, 'keep honours the deferred close with a rollback')
  assert.deepEqual(client.queries, ['ROLLBACK', 'DISCARD ALL'])
})

test('finishSession commits and releases an idle session', async () => {
  const { client, wasReleased } = tracked()
  const k = key()
  setSession(k, 'conn-1', client)
  const s = beginSession(k)
  await finishSession(k, s, 'commit')
  assert.deepEqual(client.queries, ['COMMIT', 'DISCARD ALL'])
  assert.equal(wasReleased(), true)
  assert.equal(getSession(k), undefined)
})

test('closeSessionsForClient drops sessions pinned to a dead client', async () => {
  const { client } = tracked()
  const other = stubClient()
  const k1 = key()
  const k2 = key()
  setSession(k1, 'conn-1', client)
  setSession(k2, 'conn-1', other)
  await closeSessionsForClient(client)
  assert.equal(getSession(k1), undefined)
  assert.ok(getSession(k2), 'sessions on other clients survive')
  await teardownSession(k2, 'rollback')
})
