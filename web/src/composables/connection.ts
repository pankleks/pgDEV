import { createState } from '../lib/state.svelte'
import { api } from '../api'
import type { ConnectionConfig } from '../types'
import { saveConnections, storageReady } from '../lib/storage'
import { configOf, duplicateName, migrateProfiles, profileName, type ProfileConfig, type SavedConnection } from '../lib/connectionprofile'
export type { SavedConnection } from '../lib/connectionprofile'
import { useSchema } from './schema'
import { useSettings } from './settings'
import { useToast } from './toast'

const state = createState({
  id: null as string | null,
  label: '',
  name: '',
  profileId: null as string | null,
  selectedIds: [] as string[],
  pgVersion: '',
  dialog: false,
  connecting: false,
  saving: false,
  error: '',
})

const savedConnections = createState<SavedConnection[]>([])
let lastConnection: ProfileConfig | null = null
let readyPromise: Promise<void> | null = null
let locallyChanged = false
let connectionAttempt = 0

function labelOf(cfg: ConnectionConfig): string {
  if (cfg.connectionString) {
    try {
      const url = new URL(cfg.connectionString)
      if (url.password) url.password = '***'
      for (const key of [...url.searchParams.keys()]) {
        if (/password|secret|token/i.test(key)) url.searchParams.set(key, '***')
      }
      return url.toString()
    } catch {
      return 'Connection string'
    }
  }
  return `${cfg.user ?? 'postgres'}@${cfg.host ?? 'localhost'}:${cfg.port ?? 5432}/${cfg.database ?? ''}`
}

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  if (!value || typeof value !== 'object') return false
  const cfg = value as Record<string, unknown>
  return (
    (cfg.connectionString === undefined || typeof cfg.connectionString === 'string') &&
    (cfg.host === undefined || typeof cfg.host === 'string') &&
    (cfg.port === undefined || typeof cfg.port === 'number') &&
    (cfg.database === undefined || typeof cfg.database === 'string') &&
    (cfg.user === undefined || typeof cfg.user === 'string') &&
    (cfg.password === undefined || typeof cfg.password === 'string') &&
    (cfg.ssl === undefined || typeof cfg.ssl === 'boolean')
  )
}

function parseSavedConnections(value: unknown): SavedConnection[] {
  if (!Array.isArray(value)) return []
  const entries = value.filter((entry): entry is ConnectionConfig & { label: string } => {
    if (!entry || typeof entry !== 'object') return false
    const saved = entry as Record<string, unknown>
    return typeof saved.label === 'string' && isConnectionConfig(entry)
  })
  return migrateProfiles(entries)
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = storageReady
      .then(({ connections }) => {
        if (locallyChanged || !connections) return
        savedConnections.splice(0, savedConnections.length, ...parseSavedConnections(connections.saved))
        if (isConnectionConfig(connections.last)) {
          const last = connections.last as ProfileConfig
          const profile = savedConnections.find((entry) => last.id ? entry.id === last.id : entry.label === labelOf(last))
          lastConnection = profile ? { ...profile } : { ...configOf(last), name: typeof last.name === 'string' ? last.name : undefined }
        }
        state.selectedIds = Array.isArray(connections.selectedIds)
          ? connections.selectedIds.filter((id) => savedConnections.some((entry) => entry.id === id)) : []
        // Persist stable IDs once, including when startup auto-connect is disabled.
        if (JSON.stringify(connections.saved) !== JSON.stringify(savedConnections)) {
          void saveConnections(savedConnections, lastConnection, state.selectedIds).catch(() => useToast().show('Connection profiles could not be migrated.'))
        }
      })
      .catch(() => undefined)
  }
  return readyPromise
}

function persist() {
  const saved = savedConnections.map((connection) => ({ ...connection }))
  const last = lastConnection ? { ...lastConnection } : null
  const selectedIds = [...state.selectedIds]
  void ensureReady().then(() => saveConnections(saved, last, selectedIds)).catch(() => useToast().show('Connections could not be saved. Check the application data directory.'))
}

export function useConnection() {
  function saved(): SavedConnection[] {
    void ensureReady()
    return savedConnections
  }

  function nameOf(cfg: ProfileConfig): string {
    const name = profileName(cfg.name, labelOf(cfg))
    if (duplicateName(savedConnections, name, cfg.id)) throw new Error('Connection name already exists. Choose a unique name.')
    return name
  }

  function remember(cfg: ProfileConfig): SavedConnection {
    const label = labelOf(cfg)
    const profile = { ...configOf(cfg), label, name: nameOf(cfg), id: cfg.id ?? crypto.randomUUID() }
    const list = savedConnections.filter((c) => c.id !== profile.id)
    savedConnections.splice(0, savedConnections.length, profile, ...list)
    return profile
  }

  function rememberLast(cfg: ProfileConfig) {
    lastConnection = { ...cfg }
  }

  function lastConfig(): ProfileConfig | null {
    if (lastConnection) return { ...lastConnection }
    return savedConnections.length ? { ...savedConnections[0] } : null
  }

  function forget(id: string) {
    if (state.saving) return
    locallyChanged = true
    savedConnections.splice(
      0,
      savedConnections.length,
      ...savedConnections.filter((connection) => connection.id !== id),
    )
    if (lastConnection?.id === id) lastConnection = null
    state.selectedIds = state.selectedIds.filter((selected) => selected !== id)
    if (state.profileId === id) state.profileId = null
    persist()
  }

  function forgetAll() {
    if (state.saving) return
    locallyChanged = true
    savedConnections.splice(0, savedConnections.length)
    lastConnection = null
    state.selectedIds = []
    state.profileId = null
    persist()
  }

  function selectProfiles(ids: string[]) {
    if (state.saving) return
    locallyChanged = true
    state.selectedIds = savedConnections.filter((entry) => ids.includes(entry.id)).map((entry) => entry.id)
    persist()
  }

  async function connect(cfg: ProfileConfig, save: boolean, preserveLast = false) {
    if (state.connecting || state.saving) return
    const attempt = ++connectionAttempt
    state.connecting = true
    state.error = ''
    await ensureReady()
    try {
      const name = save ? nameOf(cfg) : profileName(cfg.name, labelOf(cfg))
      const prevId = state.id
      // The statement timeout is a settings-level value (not part of the
      // remembered config) applied when the pool opens: changing it in
      // Settings takes effect on the next connect.
      const body: ConnectionConfig = { ...configOf(cfg), statementTimeout: useSettings().state.statementTimeout }
      const { id, pgVersion } = await api.connect(body)
      if (attempt !== connectionAttempt) {
        await api.disconnect(id).catch(() => {})
        return
      }
      if (prevId && prevId !== id) {
        const { confirmResultRelease } = await import('./results')
        if (attempt !== connectionAttempt || !await confirmResultRelease('Switch connections')) {
          await api.disconnect(id).catch(() => {})
          return
        }
        if (attempt !== connectionAttempt) {
          await api.disconnect(id).catch(() => {})
          return
        }
        // Switching connections from the badge dialog: close the old pool
        // and drop its per-tab results so stale data isn't shown.
        await api.disconnect(prevId).catch(() => {})
        if (attempt !== connectionAttempt) {
          await api.disconnect(id).catch(() => {})
          return
        }
        try {
          const { useResults, multiResults } = await import('./results')
          // Re-check after the await: a disconnect+reconnect during the
          // import must not drop the new connection's tab results or
          // overwrite state.id below (which would leak the newer pool).
          // No further awaits follow before the writes, so this closes it.
          if (attempt !== connectionAttempt) {
            await api.disconnect(id).catch(() => {})
            return
          }
          const res = useResults()
          for (const key of Object.keys(res.state.byTab)) if (!multiResults.owns(key)) res.drop(key)
        } catch {
          // ignore cleanup errors
        }
      }
      useSchema().reset()
      state.id = id
      state.label = labelOf(cfg)
      state.name = name
      state.profileId = cfg.id ?? null
      state.pgVersion = pgVersion ?? ''
      state.dialog = false
      if (save) {
        locallyChanged = true
        const profile = remember(cfg)
        state.profileId = profile.id
        rememberLast(profile)
        persist()
      } else if (!preserveLast) {
        locallyChanged = true
        lastConnection = null
        persist()
      }
      await useSchema().load(id)
    } catch (e) {
      if (attempt === connectionAttempt) state.error = (e as Error).message
    } finally {
      if (attempt === connectionAttempt) state.connecting = false
    }
  }

  async function saveProfile(cfg: ProfileConfig): Promise<SavedConnection | null> {
    if (state.connecting || state.saving) return null
    // ponytail: serialize profile mutations during a durable write; queue them if concurrent editing is needed.
    state.saving = true
    state.error = ''
    try {
      await ensureReady()
      if (cfg.connectionString !== undefined) {
        let valid = false
        try { valid = ['postgres:', 'postgresql:'].includes(new URL(cfg.connectionString).protocol) } catch { /* invalid URI */ }
        if (!valid) throw new Error('Enter a valid postgres:// or postgresql:// connection string.')
      } else {
        if (!cfg.database?.trim()) throw new Error('Database is required')
        if (cfg.port !== undefined && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)) throw new Error('Port must be between 1 and 65535')
      }
      const previous = savedConnections.map((profile) => ({ ...profile }))
      const previousLast = lastConnection
      const previousChanged = locallyChanged
      const profile = remember(cfg)
      locallyChanged = true
      if (lastConnection?.id === profile.id) rememberLast(profile)
      try {
        await saveConnections(savedConnections, lastConnection, state.selectedIds)
      } catch {
        savedConnections.splice(0, savedConnections.length, ...previous)
        lastConnection = previousLast
        locallyChanged = previousChanged
        throw new Error('Connection could not be saved. Check the application data directory and try again.')
      }
      if (state.profileId === profile.id) {
        const original = previous.find((entry) => entry.id === profile.id)
        if (original && JSON.stringify(configOf(original)) === JSON.stringify(configOf(profile))) state.name = profile.name
        else state.profileId = null // Saved settings changed; the live database session did not.
      }
      return profile
    } catch (error) {
      state.error = (error as Error).message
      return null
    } finally {
      state.saving = false
    }
  }

  async function autoConnect() {
    await ensureReady()
    if (state.id || state.connecting) return
    const cfg = lastConfig()
    if (!cfg) return
    await connect(cfg, false, true)
    if (!state.id) {
      state.dialog = true
      useToast().show(`Auto-connect failed: ${state.error}`)
    }
  }

  async function disconnect() {
    if (state.saving) return
    const attempt = ++connectionAttempt
    state.connecting = false
    const id = state.id
    if (id) {
      const { confirmResultRelease } = await import('./results')
      if (attempt !== connectionAttempt || !await confirmResultRelease('Disconnect from this database')) return
      if (attempt !== connectionAttempt) return
      // Best-effort cancel of in-flight queries; the destructive clear below
      // runs only after the server confirms the pool is closed. A failed
      // DELETE keeps the UI connected so a stale pool cannot linger behind a
      // phantom "not connected" badge.
      try {
        const { useResults, multiResults } = await import('./results')
        const res = useResults()
        const runningKeys = Object.keys(res.state.byTab).filter((key) => {
          const r = res.state.byTab[key]
          return !multiResults.owns(key) && (r.running || r.loadingMore) && !r.cancelling
        })
        await Promise.all(runningKeys.map((key) => res.cancel(key, id).catch(() => undefined)))
      } catch {
        // ignore cleanup errors
      }
      if (attempt !== connectionAttempt) return
      try {
        await api.disconnect(id)
      } catch (err) {
        if (attempt !== connectionAttempt) return
        const message = err instanceof Error ? err.message : String(err)
        useToast().show(`Disconnect failed: ${message}`)
        return
      }
      if (attempt !== connectionAttempt) return
      try {
        const { useResults, multiResults } = await import('./results')
        if (attempt !== connectionAttempt) return
        const res = useResults()
        for (const key of Object.keys(res.state.byTab)) if (!multiResults.owns(key)) res.drop(key)
      } catch {
        // ignore cleanup errors
      }
    }
    if (attempt !== connectionAttempt) return
    state.id = null
    state.label = ''
    state.name = ''
    state.profileId = null
    state.pgVersion = ''
    useSchema().reset()
  }

  return { state, connect, disconnect, autoConnect, saved, forget, forgetAll, selectProfiles, saveProfile, ready: ensureReady() }
}
