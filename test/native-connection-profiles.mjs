import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyProfiles, rememberProfile, forgetProfile, parseProfiles, profileUri, withConnectionPassword } from '../desktop/src/lib/connectionProfiles.ts'
import { createSnapshotWriter } from '../desktop/src/lib/snapshotWriter.ts'

test('profiles remove both password locations without changing encoded user/database or TLS settings', () => {
  const uri = 'postgresql://a%40b:secret%40one@localhost:5432/db%20name?sslmode=require&password=secret-two&hostaddr=127.0.0.1'
  const profile = rememberProfile(emptyProfiles(), 'Local', uri)
  assert.ok(!JSON.stringify(profile).includes('secret'))
  const url = new URL(profile.saved[0].uri)
  assert.equal(url.username, 'a%40b'); assert.equal(url.pathname, '/db%20name')
  assert.equal(url.password, ''); assert.equal(url.searchParams.get('sslmode'), 'require')
  assert.equal(url.searchParams.get('hostaddr'), '127.0.0.1')
  assert.deepEqual(parseProfiles(profile), profile)
})

test('unsupported URI parameters and fragments fail without echoing credentials', () => {
  for (const uri of ['postgresql://user:secret@localhost/db?options=secret', 'postgresql://user:secret@localhost/db?sslkey=secret', 'postgresql://user:secret@localhost/db#secret', 'secret', 'https://user:secret@localhost']) {
    assert.throws(() => profileUri(uri), error => !error.message.includes('secret'))
  }
})

test('stable numbers survive updates, removals and the ten-profile bound', () => {
  let record = emptyProfiles()
  for (let i = 1; i <= 12; i++) record = rememberProfile(record, `Profile ${i}`, 'postgresql://localhost/db')
  assert.equal(record.saved.length, 10); assert.equal(record.highWater, 12)
  record = rememberProfile(record, 'Profile 8', 'postgresql://localhost/other')
  assert.equal(record.saved[0].seq, 8); assert.equal(record.highWater, 12)
  record = forgetProfile(record, 12)
  record = rememberProfile(record, 'Next', 'postgresql://localhost/db')
  assert.equal(record.saved[0].seq, 13)
  assert.deepEqual(parseProfiles(record), record)
})

test('restoration rejects duplicate identities, secret-bearing records and corrupt envelopes', () => {
  const record = rememberProfile(emptyProfiles(), 'Local', 'postgresql://localhost/db')
  const item = record.saved[0]
  for (const value of [null, { ...record, version: 2 }, { ...record, password: 'secret' }, { ...record, highWater: 0 }, { ...record, saved: [item, item] }, { ...record, saved: [{ ...item, password: 'secret' }] }, { ...record, saved: [{ ...item, uri: 'postgresql://u:secret@localhost/db' }] }]) assert.throws(() => parseProfiles(value))
  assert.throws(() => rememberProfile(record, ' ', 'postgresql://localhost/db'))
  assert.throws(() => rememberProfile({ ...record, highWater: Number.MAX_SAFE_INTEGER }, 'Next', 'postgresql://localhost/db'))
})

test('password overrides are transient, safely encoded and do not change the profile', () => {
  const record = rememberProfile(emptyProfiles(), 'Local', 'postgresql://user:old@localhost/db?password=old')
  const before = JSON.stringify(record)
  const uri = withConnectionPassword(record.saved[0].uri, 'p@ss:/?#ąć')
  assert.equal(decodeURIComponent(new URL(uri).password), 'p@ss:/?#ąć')
  assert.equal(new URL(uri).searchParams.has('password'), false)
  assert.equal(JSON.stringify(record), before)
  assert.equal(withConnectionPassword('direct-uri', ''), 'direct-uri')
})

test('profile persistence snapshots queue safely and retry failed saves without storing a password', async () => {
  const writes = []; let fail = true
  const writer = createSnapshotWriter(async record => { if (fail) { fail = false; throw new Error('disk') } writes.push(record) })
  const record = rememberProfile(emptyProfiles(), 'Local', 'postgresql://user:secret@localhost/db')
  await assert.rejects(writer.save(record), /disk/)
  const retry = writer.save(record)
  record.saved[0].label = 'Later'
  await retry
  assert.equal(writes[0].saved[0].label, 'Local')
  assert.ok(!JSON.stringify(writes).includes('secret'))
})
