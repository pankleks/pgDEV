import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { Client } from 'pg'
import { connectionRoutes } from '../../server/dist/routes/connections.js'
import { connectionIds, getPool, setPool, removePool } from '../../server/dist/pools.js'
import { validateRequest } from '../../desktop/security.mjs'

test('discovery validates credentials, uses postgres and always closes its standalone client', async () => {
  const original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end }
  const clients = []
  const queries = []
  const ended = []
  let fail = ''
  Client.prototype.connect = async function () {
    clients.push(this)
    if (fail === 'connect') throw new Error('authentication failed')
  }
  Client.prototype.query = async function (sql) {
    queries.push(sql)
    if (fail === 'query') throw new Error('catalog query failed')
    return { rows: [{ name: 'orders' }, { name: 'postgres' }] }
  }
  Client.prototype.end = async function () { ended.push(this) }
  const activePool = { end: async () => {} }
  setPool('discovery-active', activePool)
  const before = connectionIds()
  const app = Fastify()
  await app.register(connectionRoutes)
  const payload = { host: 'db.example', port: 5444, user: 'reader', password: 'secret', ssl: true }
  const discover = (body) => app.inject({ method: 'POST', url: '/api/connections/discover', payload: body })
  try {
    const response = await discover({ ...payload, database: 'must-not-be-used' })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { databases: ['orders', 'postgres'] })
    assert.equal(clients[0].database, 'postgres')
    assert.equal(clients[0].host, payload.host)
    assert.equal(clients[0].port, payload.port)
    assert.equal(clients[0].user, payload.user)
    assert.deepEqual(clients[0].ssl, { rejectUnauthorized: false })
    assert.equal(clients[0].connectionParameters.statement_timeout, 10000)
    assert.match(queries[0], /NOT datistemplate AND datallowconn/)
    assert.match(queries[0], /has_database_privilege\(oid, 'CONNECT'\)/)
    assert.match(queries[0], /ORDER BY datname/)
    assert.equal(ended[0], clients[0])
    await discover({ ...payload, ssl: false, password: '' })
    assert.equal(clients[1].ssl, false, 'passwordless authentication remains supported')

    for (const stage of ['connect', 'query']) {
      fail = stage
      const error = await discover(payload)
      assert.equal(error.statusCode, 400)
      assert.match(error.json().error, /via "postgres"/)
      assert.match(error.json().error, /manually/)
      assert.equal(ended.at(-1), clients.at(-1), `${stage} failure closes the client`)
    }
    const count = clients.length
    for (const invalid of [{}, { ...payload, host: '' }, { ...payload, port: 0 },
      { ...payload, port: 65536 }, { ...payload, user: '' }, { ...payload, ssl: {} }]) {
      assert.equal((await discover(invalid)).statusCode, 400)
    }
    assert.equal(clients.length, count, 'invalid input never reaches PostgreSQL')
    assert.deepEqual(connectionIds(), before, 'discovery never registers or switches a connection')
    assert.equal(getPool('discovery-active'), activePool)
  } finally {
    Object.assign(Client.prototype, original)
    await app.close()
    await removePool('discovery-active')
  }
})

test('desktop allows POST discovery but no GET or arbitrary discovery paths', () => {
  assert.equal(validateRequest('POST', '/api/connections/discover'), '/api/connections/discover')
  assert.throws(() => validateRequest('GET', '/api/connections/discover'))
  assert.throws(() => validateRequest('POST', '/api/connections/discover/anything'))
})
