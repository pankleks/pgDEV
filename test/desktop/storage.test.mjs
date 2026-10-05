import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStorage } from '../../desktop/storage.mjs'

const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text).map((byte) => byte ^ 0x73),
  decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0x73).toString(),
}

async function fixture(t, security = encryption) {
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-storage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, storage: createStorage(directory, security) }
}

test('native records round-trip, encrypt credentials, and serialize writes', async (t) => {
  const { directory, storage } = await fixture(t)
  await storage.load()
  await Promise.all([storage.write('settings', { size: 12 }), storage.write('settings', { size: 18 })])
  await storage.write('connections', { saved: [{ password: 'never-in-plaintext', connectionString: 'postgres://u:secret@localhost/db' }] })
  const text = await readFile(join(directory, 'connections.json'), 'utf8')
  assert.ok(!text.includes('never-in-plaintext'))
  assert.ok(!text.includes('postgres://'))
  const loaded = await storage.load()
  assert.equal(loaded.settings.size, 18)
  assert.equal(loaded.connections.saved[0].password, 'never-in-plaintext')
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json.bak'), 'utf8')).value.size, 12)
})

test('Linux basic_text never persists passwords or credential URI options', async (t) => {
  const { directory, storage } = await fixture(t, { ...encryption, getSelectedStorageBackend: () => 'basic_text' })
  await storage.load()
  await storage.write('connections', { saved: [{ password: 'nope', connectionString: 'postgres://u:secret@localhost/db?password=other&ssl=true' }] })
  const text = await readFile(join(directory, 'connections.json'), 'utf8')
  assert.ok(!text.includes('secret'))
  assert.ok(!text.includes('nope'))
  assert.ok(!text.includes('other'))
  assert.ok((await storage.load()).warnings.length)
})

test('corrupt snapshots recover from backup and preserve the damaged file', async (t) => {
  const { directory, storage } = await fixture(t)
  await storage.write('session', { tabs: [{ content: 'original' }] })
  await storage.write('session', { tabs: [{ content: 'new' }] })
  await writeFile(join(directory, 'session.json'), 'broken')
  const recovered = createStorage(directory, encryption)
  assert.equal((await recovered.load()).session.tabs[0].content, 'original')
  await recovered.write('session', { tabs: [{ content: 'repaired' }] })
  const { readdir } = await import('node:fs/promises')
  const corrupt = (await readdir(directory)).find((name) => name.startsWith('session.json.corrupt-'))
  assert.equal(await readFile(join(directory, corrupt), 'utf8'), 'broken')
})

test('unrecoverable records and unsupported versions are not overwritten', async (t) => {
  const { directory, storage } = await fixture(t)
  await writeFile(join(directory, 'session.json'), '{"version":99,"value":{}}')
  assert.ok((await storage.load()).warnings.length)
  await assert.rejects(storage.write('session', {}), /unreadable/)
  assert.equal(await readFile(join(directory, 'session.json'), 'utf8'), '{"version":99,"value":{}}')
  assert.throws(() => storage.write('../outside', {}), /Unknown/)
})

test('valid JSON with an invalid data shape is treated as corruption', async (t) => {
  const { directory, storage } = await fixture(t)
  await writeFile(join(directory, 'pinnedFiles.json'), '{"version":1,"value":{"not":"pins"}}')
  const loaded = await storage.load()
  assert.deepEqual(loaded.pinnedFiles, [])
  assert.ok(loaded.warnings.some((warning) => warning.includes('pinnedFiles')))
  await assert.rejects(storage.write('pinnedFiles', []), /unreadable/)
})

test('missing primary snapshot still recovers unsaved SQL from backup', async (t) => {
  const { directory, storage } = await fixture(t)
  await writeFile(join(directory, 'session.json.bak'), JSON.stringify({ version: 1, value: { tabs: [{ content: 'recover this SQL' }] } }))
  assert.equal((await storage.load()).session.tabs[0].content, 'recover this SQL')
  await storage.write('session', { tabs: [{ content: 'recovered and saved' }] })
  assert.equal(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')).value.tabs[0].content, 'recovered and saved')
})
