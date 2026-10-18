<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Check, CodeXml, Copy, Database, Eye, EyeOff, Lock, Plug, Plus, Power, Save, Search, Server, SlidersHorizontal, User, X } from '@lucide/svelte'
  import { api } from '../api'
  import { useConnection, type SavedConnection } from '../composables/connection'
  import { confirmAction } from '../lib/desktop'
  import { stateView } from '../lib/state.svelte'
  import type { ConnectionConfig } from '../types'
  import type { ProfileConfig } from '../lib/connectionprofile'
  import { useToast } from '../composables/toast'

  const conn = useConnection()
  const saved = conn.saved()
  const snapshot = stateView(() => ({ ...conn.state, saved: saved.map((entry) => ({ ...entry })) }))
  let mode = $state<'params' | 'url'>('params')
  let remember = $state(true)
  let showPassword = $state(false)
  let selectedLabel = $state<string | null>(null)
  let name = $state('')
  let url = $state('')
  const defaults: ConnectionConfig = {
    host: 'localhost', port: 5432, database: '', user: 'postgres', password: '', ssl: false,
  }
  const form = $state<ConnectionConfig>({ ...defaults })
  let databases = $state<string[]>([])
  let discovering = $state(false)
  let discovered = $state(false)
  let discoveryError = $state('')
  let discoveryGeneration = 0
  const canDiscover = $derived(!!form.host?.trim() && !!form.user?.trim() &&
    Number.isInteger(form.port) && Number(form.port) >= 1 && Number(form.port) <= 65535)
  $effect(() => {
    void [mode, form.host, form.port, form.user, form.password, form.ssl]
    discoveryGeneration++
    databases = []
    discovering = false
    discovered = false
    discoveryError = ''
  })
  onDestroy(() => { discoveryGeneration++ })

  async function discover() {
    if (!canDiscover || discovering || snapshot.current.connecting) return
    const generation = ++discoveryGeneration
    discovering = true
    discovered = false
    discoveryError = ''
    databases = []
    try {
      const result = await api.discoverDatabases({ ...form })
      if (generation !== discoveryGeneration) return
      databases = result.databases
      discovered = true
    } catch (error) {
      if (generation === discoveryGeneration) discoveryError = (error as Error).message
    } finally {
      if (generation === discoveryGeneration) discovering = false
    }
  }

  interface ConnectionRow {
    id: string
    label: string
    sub: string
    saved: SavedConnection | null
    active: boolean
  }

  const hasLeftColumn = $derived(snapshot.current.id !== null || snapshot.current.saved.length > 0)
  const allConnections = $derived.by(() => {
    const items: ConnectionRow[] = snapshot.current.saved.map((entry) => ({
      id: entry.id,
      label: entry.name,
      sub: entry.connectionString ? 'connection string' : `${entry.host}:${entry.port} • ${entry.database}`,
      saved: entry,
      active: entry.id === snapshot.current.profileId,
    }))
    if (snapshot.current.id && !items.some((item) => item.active)) {
      items.unshift({ id: 'active', label: snapshot.current.name, sub: '', saved: null, active: true })
    }
    return items
  })

  function pick(entry: SavedConnection) {
    if (snapshot.current.saving) return
    selectedLabel = entry.id
    name = entry.name
    conn.state.error = ''
    if (entry.connectionString) {
      mode = 'url'
      url = entry.connectionString
    } else {
      mode = 'params'
      form.host = entry.host ?? 'localhost'
      form.port = entry.port ?? 5432
      form.database = entry.database ?? ''
      form.user = entry.user ?? 'postgres'
      form.password = entry.password ?? ''
      form.ssl = entry.ssl ?? false
    }
  }

  function newConnection() {
    selectedLabel = null
    name = ''
    url = ''
    mode = 'params'
    remember = true
    showPassword = false
    Object.assign(form, defaults)
    conn.state.error = ''
    discoveryGeneration++
    databases = []
    discovering = false
    discovered = false
    discoveryError = ''
  }

  function pickWithKeyboard(event: KeyboardEvent, entry: SavedConnection | null) {
    if (event.target !== event.currentTarget || !entry) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(entry)
    }
  }

  async function clearAll() {
    if (!saved.length) return
    if (await confirmAction('Forget all saved connections?')) { conn.forgetAll(); selectedLabel = null; name = '' }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (discovering || snapshot.current.saving) return
    if (mode === 'url' && !url.trim()) {
      conn.state.error = 'Connection string is required'
      return
    }
    await conn.connect(currentConfig(), remember)
  }

  function currentConfig(): ProfileConfig {
    const config: ConnectionConfig = mode === 'url'
      ? { connectionString: url.trim() }
      : { ...form, port: Number(form.port) }
    return { ...config, name, id: selectedLabel ?? undefined }
  }

  async function save(asNew: boolean, event: MouseEvent) {
    if (discovering || snapshot.current.connecting || snapshot.current.saving) return
    if (!(event.currentTarget as HTMLButtonElement).form?.reportValidity()) return
    const config = currentConfig()
    if (asNew) delete config.id
    const profile = await conn.saveProfile(config)
    if (!profile) return
    selectedLabel = profile.id
    name = profile.name
    remember = true
    useToast().show(`Connection "${profile.name}" saved.`)
  }

  function close() { if (!snapshot.current.saving) conn.state.dialog = false }
</script>

{#snippet connectionActions()}
  <div class="connection-save-actions">
    <button type="button" disabled={snapshot.current.connecting || snapshot.current.saving || discovering} onclick={(event) => save(false, event)}><Save size={14} />{snapshot.current.saving ? 'Saving…' : selectedLabel ? 'Save changes' : 'Save connection'}</button>
    {#if selectedLabel}<button type="button" disabled={snapshot.current.connecting || snapshot.current.saving || discovering} onclick={(event) => save(true, event)}><Copy size={14} /> Save as new</button>{/if}
  </div>
  <small class="save-hint">Saving a profile does not connect or switch databases.</small>
  <button class="primary connect-btn" type="submit" disabled={snapshot.current.connecting || snapshot.current.saving || discovering}><Plug size={15} />{snapshot.current.connecting ? 'Connecting…' : 'Connect'}</button>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={(event) => { if (event.target === event.currentTarget) close() }}>
  <div class="modal connect-modal" role="dialog" aria-modal="true" aria-label="Connect to PostgreSQL" tabindex="-1">
    <button class="icon connect-close" title="Close" disabled={snapshot.current.saving} onclick={close}><X size={16} /></button>
    <div class="connect-head">
      <div class="connect-logo"><Database size={30} /></div>
      <div>
        <h2>Connect to PostgreSQL</h2>
        <p class="connect-sub">Connect to a PostgreSQL database to explore and query your data.</p>
      </div>
    </div>
    <div class="connect-cols" class:single={!hasLeftColumn}>
      {#if hasLeftColumn}
        <div class="connect-panel">
          <div class="recent-head">
            <h3 class="panel-title">Connections</h3>
            {#if snapshot.current.saved.length}<button class="link" disabled={snapshot.current.saving} onclick={clearAll}>Clear all</button>{/if}
          </div>
          <div class="saved">
            {#each allConnections as entry (entry.id)}
              <div class="saved-item" class:current={entry.active} class:selected={entry.id === selectedLabel} role="button" tabindex={entry.saved ? 0 : -1}
                aria-label={entry.label} aria-pressed={entry.id === selectedLabel} onclick={() => { if (entry.saved) pick(entry.saved) }}
                onkeydown={(event) => pickWithKeyboard(event, entry.saved)}>
                <Database class="saved-icon" size={17} />
                <span class="saved-text"><strong>{entry.label}</strong>{#if entry.sub}<small>{entry.sub}</small>{/if}</span>
                {#if entry.active}
                  <button class="row-action disconnect" title="Disconnect" disabled={snapshot.current.connecting || snapshot.current.saving}
                    onclick={(event) => { event.stopPropagation(); void conn.disconnect() }}><Power size={14} /></button>
                {:else if entry.saved}
                  <button class="row-action" title="Forget" disabled={snapshot.current.saving}
                    onclick={(event) => { event.stopPropagation(); conn.forget(entry.id); if (selectedLabel === entry.id) selectedLabel = null }}><X size={14} /></button>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
      <div class="connect-panel">
        <div class="recent-head">
          <h3 class="panel-title">{selectedLabel ? 'Edit connection' : 'New connection'}</h3>
          {#if selectedLabel}<button class="link" title="Clear the form to enter a new connection" disabled={snapshot.current.connecting || snapshot.current.saving || discovering} onclick={newConnection}><Plus size={13} /> New connection</button>{/if}
        </div>
        <div class="seg" role="tablist" aria-label="Connection format">
          <button type="button" class="seg-btn" class:active={mode === 'params'} role="tab"
            aria-selected={mode === 'params'} onclick={() => { mode = 'params' }}><SlidersHorizontal size={14} /> Parameters</button>
          <button type="button" class="seg-btn" class:active={mode === 'url'} role="tab"
            aria-selected={mode === 'url'} onclick={() => { mode = 'url' }}><CodeXml size={14} /> Connection string</button>
        </div>
        {#if mode === 'params'}
          <form class="fields" inert={snapshot.current.saving} onsubmit={submit}>
            <label class="field-label"><span>Connection name</span><span class="field"><input bind:value={name} placeholder="Optional unique name" /></span></label>
            <label class="field-label"><span>Host</span><span class="field"><Server class="field-icon" size={14} /><input bind:value={form.host} /></span></label>
            <label class="field-label"><span>Port</span><span class="field"><input bind:value={form.port} type="number" min="1" max="65535" required /></span></label>
            <div class="field-label">
              <label for="connection-database">Database</label>
              <span class="field"><Database class="field-icon" size={14} /><input id="connection-database" bind:value={form.database} required placeholder="postgres" />
                <button type="button" class="btn-sm discover-btn" title="Discover accessible databases using postgres" disabled={!canDiscover || discovering || snapshot.current.connecting} onclick={discover}><Search size={13} />{discovering ? 'Discovering…' : 'Discover databases'}</button>
              </span>
              {#if databases.length}
                <div class="database-picker" role="group" aria-label="Discovered databases">
                  <div class="discovery-head"><span role="status">Found {databases.length} databases</span><span>Select a database</span></div>
                  <div class="database-options">
                    {#each databases as name}
                      <button type="button" class="database-option" class:selected={form.database === name} aria-pressed={form.database === name} aria-label={name} title={name}
                        onclick={() => { form.database = name }}>
                        <Database size={14} /><span>{name}</span>{#if form.database === name}<Check size={14} />{/if}
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if discovering}<small role="status">Connecting to postgres to discover databases…</small>{/if}
              {#if discovered && !databases.length}<small role="status">No accessible databases found. You can enter a name manually.</small>{/if}
              {#if discoveryError}<small class="error" role="alert">{discoveryError}</small>{/if}
            </div>
            <label class="field-label"><span>User</span><span class="field"><User class="field-icon" size={14} /><input bind:value={form.user} /></span></label>
            <label class="field-label">
              <span>Password</span>
              <span class="field">
                <Lock class="field-icon" size={14} />
                <input bind:value={form.password} type={showPassword ? 'text' : 'password'} autocomplete="off" placeholder="Enter password" />
                <button type="button" class="icon field-eye" title={showPassword ? 'Hide password' : 'Show password'}
                  onclick={() => { showPassword = !showPassword }}>
                  {#if showPassword}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
                </button>
              </span>
            </label>
            <div class="checks">
              <label class="check-item"><input bind:checked={form.ssl} type="checkbox" /><span><strong>SSL</strong><small>Use SSL to connect to the database</small></span></label>
              <label class="check-item"><input bind:checked={remember} type="checkbox" /><span><strong>Remember on this device</strong><small>Credentials use secure OS storage when available</small></span></label>
            </div>
            {@render connectionActions()}
          </form>
        {:else}
          <form class="fields" inert={snapshot.current.saving} onsubmit={submit}>
            <label class="field-label"><span>Connection name</span><span class="field"><input bind:value={name} placeholder="Optional unique name" /></span></label>
            <label class="field-label"><span>URL</span><span class="field"><input bind:value={url} placeholder="postgres://user:pass@host:5432/db" /></span></label>
            <div class="checks">
              <label class="check-item"><input bind:checked={remember} type="checkbox" /><span><strong>Remember on this device</strong><small>Credentials use secure OS storage when available</small></span></label>
            </div>
            {@render connectionActions()}
          </form>
        {/if}
        {#if snapshot.current.error}<div class="error">{snapshot.current.error}</div>{/if}
      </div>
    </div>
  </div>
</div>

<style>
  .connection-save-actions { display: flex; gap: 8px; margin-top: 6px; }
  .connection-save-actions button { flex: 1; }
  .save-hint { color: var(--text-dim); font-size: 11px; }
  .database-picker { margin-top: 3px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); overflow: hidden; }
  .discovery-head { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; background: var(--panel); border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text-dim); }
  .database-options { max-height: 168px; overflow-y: auto; padding: 4px; }
  .database-option { width: 100%; justify-content: flex-start; gap: 8px; padding: 7px 8px; border: none; border-radius: 4px; background: transparent; font-size: 12px; text-align: left; }
  .database-option span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .database-option.selected { background: rgba(79, 156, 249, 0.13); color: var(--accent); }
  .database-option:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
