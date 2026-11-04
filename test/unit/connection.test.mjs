import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

test('profiles persist independently, rename without losing selections, and ignore numbered deep links', async () => {
  const writes = []
  let failStorage = false
  globalThis.window = {
    location: { search: '?connect=2' },
    setInterval: () => 0, addEventListener: () => {},
    pgdevDesktop: {
      confirm: async () => true,
      storage: {
        load: async () => ({ connections: { saved: [{ id: 'restored', label: 'postgres@localhost:5432/db', database: 'db', seq: 2 }], selectedIds: ['restored', 'deleted'], last: null, nextSeq: 2 }, pinnedFiles: [] }),
        write: async (kind, value) => {
          if (failStorage) throw new Error('Storage unavailable')
          writes.push({ kind, value: structuredClone(value) })
        },
      },
    },
  }
  try {
    const load = sourceLoader()
    const { useConnection } = await load('web/composables/connection.ts')
    const { api } = await load('web/api.ts')
    const { flushStorage } = await load('web/lib/storage.ts')
    let counter = 0
    const configs = []
    api.connect = async config => { configs.push(config); return { id: `session-${++counter}` } }
    api.disconnect = async () => {}
    api.schema = async () => ({})
    const conn = useConnection()
    await conn.ready
    await flushStorage()
    assert.equal(conn.saved().length, 1)
    assert.deepEqual(conn.state.selectedIds, ['restored'], 'startup restores selected profile IDs and ignores deleted ones')
    assert.equal('seq' in conn.saved()[0], false)
    const cfg = { connectionString: 'postgres://localhost/db' }
    await conn.connect({ ...cfg, name: ' First ' }, true)
    const first = conn.saved()[0]
    await conn.connect({ ...cfg, name: 'Second' }, true)
    const second = conn.saved()[0]
    assert.notEqual(first.id, second.id)
    assert.equal(conn.saved().length, 3)
    const before = counter
    await conn.connect({ ...cfg, name: ' first ' }, true)
    assert.match(conn.state.error, /already exists/)
    assert.equal(counter, before, 'duplicates fail before opening a database session')
    conn.selectProfiles([first.id, second.id, 'deleted'])
    await conn.connect({ ...first, name: 'Renamed' }, true)
    assert.equal(conn.state.profileId, first.id)
    assert.equal(conn.state.name, 'Renamed')
    assert.equal(conn.saved().length, 3)
    assert.deepEqual(new Set(conn.state.selectedIds), new Set([first.id, second.id]))
    assert.ok(configs.every(c => !('id' in c) && !('name' in c) && !('seq' in c)))
    await flushStorage()
    const stored = writes.filter(w => w.kind === 'connections').at(-1).value
    assert.equal(stored.saved.find(p => p.id === first.id).name, 'Renamed')
    assert.deepEqual(stored.selectedIds, conn.state.selectedIds)
    assert.equal('nextSeq' in stored, false)
    const liveId = conn.state.id
    const callsBeforeSave = counter
    const copy = await conn.saveProfile({ ...cfg, name: 'Saved offline', connectionString: 'postgres://localhost/other' })
    assert.ok(copy)
    assert.notEqual(copy.id, first.id)
    assert.equal(conn.saved().length, 4)
    assert.equal(conn.state.id, liveId)
    assert.equal(conn.state.name, 'Renamed')
    assert.equal(conn.saved().find(p => p.id === first.id).connectionString, cfg.connectionString)
    const updated = await conn.saveProfile({ ...copy, name: 'Offline renamed', connectionString: 'postgres://localhost/edited' })
    assert.equal(updated.id, copy.id)
    assert.equal(conn.saved().length, 4)
    assert.equal(writes.at(-1).value.saved.find(p => p.id === copy.id).connectionString, 'postgres://localhost/edited')
    assert.equal(await conn.saveProfile({ ...cfg, name: ' offline RENAMED ' }), null)
    assert.match(conn.state.error, /already exists/)
    failStorage = true
    assert.equal(await conn.saveProfile({ ...updated, name: 'Must not appear' }), null)
    assert.match(conn.state.error, /could not be saved/)
    assert.equal(conn.saved().find(p => p.id === copy.id).name, 'Offline renamed')
    failStorage = false
    for (const invalid of [{ connectionString: 'not a URI' }, { database: '' }, { database: 'db', port: 0 }]) {
      assert.equal(await conn.saveProfile({ ...invalid, name: 'Invalid' }), null)
      assert.equal(conn.saved().length, 4)
    }
    assert.equal(counter, callsBeforeSave, 'saving profiles never opens a database connection')
    await conn.disconnect()
    await conn.autoConnect()
    assert.equal(conn.state.name, 'Renamed', 'numbered URL does not override normal last-profile startup')
    await conn.saveProfile({ ...conn.saved().find(p => p.id === first.id), name: 'Renamed offline' })
    assert.equal(conn.state.name, 'Renamed offline', 'a name-only save updates the live badge without reconnecting')
    const liveLabel = conn.state.label
    await conn.saveProfile({ ...conn.saved().find(p => p.id === first.id), connectionString: 'postgres://localhost/different' })
    assert.equal(conn.state.profileId, null, 'editing saved database settings must not claim the live session switched databases')
    assert.equal(conn.state.label, liveLabel)
    conn.forget(first.id)
    assert.deepEqual(conn.state.selectedIds, [second.id])
    await flushStorage()
  } finally {
    delete globalThis.window
  }
})
