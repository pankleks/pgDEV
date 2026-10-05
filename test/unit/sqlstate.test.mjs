import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeSqlState, standardConformingStrings } from '../../server/dist/sqlstate.js'
import { nextStatement } from '../../server/dist/sqlsplit.js'

test('SQL state follows protocol updates and is initialized once per physical client', async () => {
  const connection = new EventEmitter()
  let reads = 0
  const client = { connection, async query(sql) {
    assert.equal(sql, 'SHOW standard_conforming_strings')
    reads++
    return { rows: [{ standard_conforming_strings: 'off' }] }
  } }
  await observeSqlState(client)
  assert.equal(standardConformingStrings(client), false)
  const sql = "SELECT 'a\\';b'; SELECT 2;"
  assert.equal(nextStatement(sql, 0, standardConformingStrings(client)).text, "SELECT 'a\\';b'")
  connection.emit('parameterStatus', { parameterName: 'standard_conforming_strings', parameterValue: 'on' })
  assert.equal(standardConformingStrings(client), true)
  assert.equal(nextStatement("SELECT 'a\\'; SELECT 2;", 0, standardConformingStrings(client)).text, "SELECT 'a\\'")
  connection.emit('parameterStatus', { parameterName: 'TimeZone', parameterValue: 'UTC' })
  assert.equal(standardConformingStrings(client), true)
  await observeSqlState(client)
  assert.equal(reads, 1)
  assert.equal(connection.listenerCount('parameterStatus'), 1)
})

test('failed string-mode initialization removes the listener and can be retried', async () => {
  const connection = new EventEmitter()
  const client = { connection, async query() { throw new Error('connection lost') } }
  await assert.rejects(observeSqlState(client), /connection lost/)
  assert.equal(connection.listenerCount('parameterStatus'), 0)
  client.query = async () => ({ rows: [{ standard_conforming_strings: 'on' }] })
  await observeSqlState(client)
  assert.equal(standardConformingStrings(client), true)
})
