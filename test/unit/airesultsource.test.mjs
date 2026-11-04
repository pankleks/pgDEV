import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

test('MCP reports selected result B while queries still target main connection A', async () => {
  globalThis.window = {
    setInterval: () => 0, addEventListener: () => {},
    pgdevDesktop: {
      storage: {
        load: async () => ({ connections: { saved: [
          { id: 'profile-A', name: 'Database A', label: 'a', database: 'a' },
          { id: 'profile-B', name: 'Database B', label: 'b', database: 'b' },
        ], last: null }, pinnedFiles: [] }),
        write: async () => {},
      },
    },
  }
  let ai, multiResults
  try {
    const load = sourceLoader()
    const { createBridge } = await load('server/ai/bridge.ts')
    const { createAiTools } = await load('server/ai/tools.ts')
    const { useAi } = await load('web/composables/ai.ts')
    const { useConnection } = await load('web/composables/connection.ts')
    const { useTabs } = await load('web/composables/tabs.ts')
    const resultModule = await load('web/composables/results.ts')
    multiResults = resultModule.multiResults
    const results = resultModule.useResults()
    const { api } = await load('web/api.ts')
    const bridge = createBridge()
    window.pgdevDesktop.subscribeAi = onAction => bridge.subscribe(onAction)
    api.aiConfig = async () => ({})
    api.aiLimits = async () => ({})
    api.aiBridgeResult = async (id, result, error) => { bridge.resolve(id, result, error) }
    api.connect = async () => ({ id: 'session-B' })
    api.disconnect = async () => {}
    const data = id => ({ kind: 'data', columns: ['source'], columnTypes: ['text'], rows: [[id]], rowCount: 1, truncated: false })
    api.query = async id => ({ results: [data(id)], durationMs: 1 })
    const conn = useConnection()
    const tabs = useTabs()
    await Promise.all([conn.ready, tabs.sessionsReady])
    Object.assign(conn.state, { id: 'session-A', profileId: 'profile-A', name: 'Database A' })
    tabs.newQuery()
    const key = tabs.state.activeKey
    ai = useAi()
    await ai.start()
    const targets = []
    const tools = createAiTools({
      bridge, connectionIds: () => ['session-A', 'session-B'],
      runReadOnly: async id => { targets.push(id); return { kind: 'ok', results: [data(id)] } },
      getSchema: assert.fail, getDdl: assert.fail,
    })

    await results.run(key, 'session-A', 'SELECT 1', undefined, { profileId: 'profile-A', connectionName: 'Database A' })
    const ordinary = await tools.get_active_result({})
    assert.equal(ordinary.result.connectionId, 'session-A')
    assert.equal(ordinary.result.profileId, 'profile-A')
    assert.equal(ordinary.result.connectionName, 'Database A')

    await multiResults.run(key, 'SELECT 1', [conn.saved().find(p => p.id === 'profile-B')], 30)
    const selected = await tools.get_active_result({})
    assert.equal(selected.ok, true)
    assert.equal(selected.result.connectionId, 'session-B')
    assert.equal(selected.result.profileId, 'profile-B')
    assert.equal(selected.result.connectionName, 'Database B')
    assert.deepEqual(selected.result.results[0].rows, [['session-B']])
    assert.equal((await bridge.request('get-context')).connectionId, 'session-A')

    await conn.saveProfile({ ...conn.saved().find(p => p.id === 'profile-B'), name: 'Renamed B' })
    const renamed = await tools.get_active_result({})
    assert.equal(renamed.result.connectionName, 'Renamed B')
    assert.equal(renamed.result.connectionId, 'session-B')
    assert.equal(renamed.result.profileId, 'profile-B')

    const query = await tools.query({ sql: 'SELECT 1' })
    assert.equal(query.ok, true)
    assert.deepEqual(targets, ['session-A'], 'reading result B must not retarget subsequent MCP queries')
    const mirrored = await tools.get_active_result({})
    assert.equal(mirrored.result.connectionId, 'session-A')
    assert.equal(mirrored.result.profileId, 'profile-A')
    assert.equal(mirrored.result.connectionName, 'Database A')
    Object.assign(conn.state, { id: 'session-C', profileId: null, name: 'Database C' })
    const retained = await tools.get_active_result({})
    assert.equal(retained.result.connectionId, 'session-A', 'retained rows keep their real source rather than the current connection')
    assert.equal(retained.result.profileId, 'profile-A')
  } finally {
    ai?.stop()
    for (const key of Object.keys(multiResults?.state.byTab ?? {})) multiResults.release(key)
    delete globalThis.window
  }
})
