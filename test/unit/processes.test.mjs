import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { processRoutes } from '../../server/dist/routes/processes.js'
import { setCatalogPool, removePool, setPool } from '../../server/dist/pools.js'
import { validateRequest } from '../../desktop/security.mjs'

test('process monitor lists sessions and validates targeted actions', async () => {
  const calls = []
  let rows = []
  let failure = null
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params })
      if (failure) throw failure
      return { rows }
    },
    end: async () => {},
  }
  setPool('process-test', pool)
  setCatalogPool('process-test', pool)
  const app = Fastify()
  await app.register(processRoutes)
  const base = '/api/connections/process-test/processes'
  const payload = { backendStart: '2026-10-14 14:02:37.940894+00' }
  try {
    rows = [{ pid: 33132, state: 'idle in transaction' }]
    const list = await app.inject({ url: base })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().processes, rows)
    assert.match(calls.at(-1).sql, /pid <> pg_backend_pid\(\)/)
    assert.match(calls.at(-1).sql, /datname = current_database\(\)/)
    assert.match(calls.at(-1).sql, /pg_blocking_pids/)
    assert.doesNotMatch(calls.at(-1).sql, /state\s*[!=<>]/)

    rows = [{ ok: true }]
    for (const action of ['cancel', 'terminate']) {
      const response = await app.inject({ method: 'POST', url: `${base}/33132/${action}`, payload })
      assert.equal(response.statusCode, 200)
      assert.match(calls.at(-1).sql, new RegExp(`pg_${action}_backend`))
      assert.match(calls.at(-1).sql, /backend_start = \$2::timestamptz/)
      assert.match(calls.at(-1).sql, /pid <> pg_backend_pid\(\)/)
      assert.match(calls.at(-1).sql, /backend_type = 'client backend'/)
      assert.deepEqual(calls.at(-1).params, [33132, payload.backendStart])
      assert.equal(calls.at(-1).sql.includes("state = 'active'"), action === 'cancel')
    }
    const before = calls.length
    for (const [pid, action, body] of [
      ['0', 'terminate', payload], ['-1', 'terminate', payload],
      ['2147483648', 'cancel', payload], ['33132', 'drop', payload],
      ['33132', 'terminate', {}], ['33132', 'terminate', { backendStart: 'bad' }],
    ]) {
      assert.equal((await app.inject({ method: 'POST', url: `${base}/${pid}/${action}`, payload: body })).statusCode, 400)
    }
    assert.equal(calls.length, before)
    rows = []
    assert.equal((await app.inject({ method: 'POST', url: `${base}/33132/terminate`, payload })).statusCode, 409)
    failure = new Error('permission denied to terminate process')
    const denied = await app.inject({ method: 'POST', url: `${base}/33132/terminate`, payload })
    assert.equal(denied.statusCode, 500)
    assert.match(denied.json().message, /permission denied/)
  } finally {
    await app.close()
    await removePool('process-test')
  }
})

test('desktop allows only the intended process operations', () => {
  const base = '/api/connections/example/processes'
  assert.equal(validateRequest('GET', base), base)
  for (const action of ['cancel', 'terminate']) {
    assert.equal(validateRequest('POST', `${base}/123/${action}`), `${base}/123/${action}`)
  }
  assert.throws(() => validateRequest('GET', `${base}/123/terminate`))
  assert.throws(() => validateRequest('POST', `${base}/123/drop`))
})
