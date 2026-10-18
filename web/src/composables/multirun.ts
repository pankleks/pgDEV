import { createState } from '../lib/state.svelte'
import { configOf, type SavedConnection } from '../lib/connectionprofile'
import type { ConnectionConfig } from '../types'
import type { Results } from './results'

interface MultiApi {
  connect(config: ConnectionConfig): Promise<{ id: string }>
  disconnect(id: string): Promise<void>
}

export interface ConnectionResult {
  key: string
  profileId: string
  name: string
  connectionId: string | null
  connecting: boolean
  cancelled: boolean
}

export function createMultiResults(results: Results, api: MultiApi, warn: (message: string) => void) {
  const state = createState<{ byTab: Record<string, { selected: string; entries: ConnectionResult[] }> }>({ byTab: {} })
  function keys(tabKey: string): string[] { return state.byTab[tabKey]?.entries.map((entry) => entry.key) ?? [] }
  function owns(key: string): boolean { return Object.values(state.byTab).some((group) => group.entries.some((entry) => entry.key === key)) }
  function disconnect(id: string, name: string) {
    return api.disconnect(id).catch(() => warn(`Could not close the session for ${name}.`))
  }
  function release(tabKey: string) {
    const group = state.byTab[tabKey]
    delete state.byTab[tabKey]
    for (const entry of group?.entries ?? []) {
      entry.cancelled = true
      results.drop(entry.key)
      if (entry.connectionId) void disconnect(entry.connectionId, entry.name)
    }
  }
  async function cancel(entry: ConnectionResult) {
    entry.cancelled = true
    if (entry.connectionId) await results.cancel(entry.key, entry.connectionId)
  }
  async function run(tabKey: string, sql: string, profiles: SavedConnection[], statementTimeout: number) {
    if (!sql.trim() || !profiles.length) return
    release(tabKey)
    state.byTab[tabKey] = {
      selected: '',
      entries: profiles.map((profile) => ({
        key: `multi-${crypto.randomUUID()}`, profileId: profile.id, name: profile.name,
        connectionId: null, connecting: true, cancelled: false,
      })),
    }
    const group = state.byTab[tabKey]
    group.selected = group.entries[0].key
    await Promise.all(group.entries.map(async (entry, index) => {
      try {
        const { id } = await api.connect({ ...configOf(profiles[index]), statementTimeout })
        if (state.byTab[tabKey] !== group || entry.cancelled) {
          await disconnect(id, entry.name)
          if (state.byTab[tabKey] === group) results.fail(entry.key, 'Query canceled.')
          return
        }
        entry.connectionId = id
        entry.connecting = false
        await results.run(entry.key, id, sql, undefined, { profileId: entry.profileId, connectionName: entry.name })
      } catch (error) {
        if (state.byTab[tabKey] === group) results.fail(entry.key, (error as Error).message)
      } finally {
        entry.connecting = false
      }
    }))
  }
  return { state, run, release, cancel, keys, owns }
}
