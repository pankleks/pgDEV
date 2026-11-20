import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { configOf, profileName, duplicateName, migrateProfiles } = await load('web/lib/connectionprofile.ts')

test('profile names are trimmed, unique ignoring case, and independent of connection details', () => {
  const profiles = migrateProfiles([
    { label: 'same', name: ' Production ', connectionString: 'postgres://localhost/db', seq: 4 },
    { label: 'same', name: 'Staging', connectionString: 'postgres://localhost/db', seq: 5 },
  ])
  assert.equal(profileName('   ', 'fallback'), 'fallback')
  assert.deepEqual(profiles.map(p => p.name), ['Production', 'Staging'])
  assert.notEqual(profiles[0].id, profiles[1].id)
  assert.equal(duplicateName(profiles, ' production '), true)
  assert.equal(duplicateName(profiles, 'PRODUCTION', profiles[0].id), false)
  assert.deepEqual(configOf(profiles[0]), { connectionString: 'postgres://localhost/db' })
  assert.ok(profiles.every(p => !('seq' in p)))
  const renamed = migrateProfiles([{ ...profiles[0], name: 'Renamed' }, profiles[1]])
  assert.equal(renamed[0].id, profiles[0].id)
  assert.deepEqual(migrateProfiles(renamed), renamed)
})

test('legacy profiles gain stable IDs and unique fallback names without losing credentials', () => {
  const profiles = migrateProfiles([
    { label: 'local', host: 'localhost', password: 'secret', seq: 1 },
    { label: 'local', host: 'localhost', password: 'other', seq: 2 },
  ])
  assert.deepEqual(profiles.map(p => p.name), ['local', 'local (2)'])
  assert.equal(profiles[0].password, 'secret')
  assert.deepEqual(migrateProfiles(profiles), profiles)
})

test('the AI write opt-in survives profile handling in both forms; the removed agent role is dropped', () => {
  // Profiles saved by older versions may still carry agentRole: never sent, never kept.
  assert.deepEqual(configOf({ connectionString: 'postgres://x@h/db', agentRole: 'agent_reader', name: 'n' }),
    { connectionString: 'postgres://x@h/db' })
  assert.equal('agentRole' in configOf({ host: 'h', agentRole: 'r' }), false)
  assert.equal('agentRole' in migrateProfiles([{ label: 'l', host: 'h', agentRole: 'r' }])[0], false)
  // The write opt-in travels with the profile and is only sent when true.
  assert.equal(configOf({ connectionString: 'postgres://x@h/db', agentWrite: true }).agentWrite, true)
  assert.equal(configOf({ host: 'h', agentWrite: true }).agentWrite, true)
  assert.equal('agentWrite' in configOf({ host: 'h', agentWrite: false }), false)
  assert.equal(migrateProfiles([{ label: 'l', host: 'h', agentWrite: true }])[0].agentWrite, true)
})
