<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { RefreshCw } from '@lucide/svelte'
  import { api } from '../api'
  import type { DatabaseProcess } from '../types'
  import { confirmAction } from '../lib/desktop'

  let { connectionId, label }: { connectionId: string; label: string } = $props()
  let processes = $state<DatabaseProcess[]>([])
  let selected = $state<string | null>(null)
  let filter = $state('')
  let hideIdle = $state(false)
  let loading = $state(false)
  let acting = $state(false)
  let error = $state('')
  let message = $state('')
  let alive = true
  const identity = (p: DatabaseProcess) => `${p.pid}:${p.backend_start}`
  const visible = $derived(processes.filter((p) => (!hideIdle || p.state !== 'idle') &&
    [p.pid, p.database, p.username, p.application_name, p.state, p.query, ...p.blocking_pids]
      .join(' ').toLowerCase().includes(filter.toLowerCase())))
  const active = $derived(visible.find((p) => identity(p) === selected))
  const blocked = $derived(active ? processes.filter((p) => p.blocking_pids.includes(active.pid)).map((p) => p.pid) : [])

  function age(seconds: number | null) {
    if (seconds === null) return '—'
    const value = Math.max(0, Math.floor(seconds))
    return value < 60 ? `${value}s` : value < 3600 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`
  }

  async function refresh() {
    if (loading) return
    loading = true
    error = ''
    try {
      const response = await api.processes(connectionId)
      if (!alive) return
      processes = response.processes
      if (!processes.some((p) => identity(p) === selected)) selected = null
    } catch (cause) {
      if (alive) error = (cause as Error).message
    } finally {
      if (alive) loading = false
    }
  }

  async function act(action: 'cancel' | 'terminate') {
    const process = active
    if (!process || acting || loading) return
    acting = true
    error = ''
    message = ''
    try {
      if (action === 'terminate' && !await confirmAction(`Disconnect session ${process.pid} (${process.username} · ${process.application_name || process.database})? Its open transaction will roll back, uncommitted changes will be lost, and its locks will be released.`)) return
      if (!alive) return
      await api.processAction(connectionId, process, action)
      if (!alive) return
      message = action === 'cancel' ? `Cancellation requested for ${process.pid}.` : `Termination requested for ${process.pid}.`
      await refresh()
    } catch (cause) {
      if (alive) error = (cause as Error).message
    } finally {
      if (alive) acting = false
    }
  }

  onMount(() => { void refresh() })
  onDestroy(() => { alive = false })
</script>

<section class="processes-panel" aria-labelledby="processes-title">
  <header>
    <div><h2 id="processes-title">Processes</h2><small>{label} · Current database</small></div>
    <span class="spacer"></span>
    <button class="btn-sm" disabled={loading || acting} onclick={refresh}><RefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh'}</button>
  </header>
  <div class="filters">
    <input aria-label="Filter processes" placeholder="Filter PID, user, application, or SQL…" bind:value={filter} />
    <label><input type="checkbox" bind:checked={hideIdle} /> Hide idle</label>
    <small>{visible.length} sessions</small>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <div class="process-grid">
    <table>
      <thead><tr><th>PID</th><th>User / Application</th><th>State</th><th>Tx age</th><th>Query age</th><th>Wait</th><th>Blocked by</th></tr></thead>
      <tbody>
        {#each visible as process (identity(process))}
          <tr class:selected={selected === identity(process)}>
            <td><button class="pid" aria-pressed={selected === identity(process)} onclick={() => { selected = identity(process) }}>{process.pid}</button></td>
            <td>{process.username}<small>{process.application_name || '—'}</small></td>
            <td>{process.state ?? 'Unavailable'}</td>
            <td>{age(process.transaction_age)}</td><td>{age(process.query_age)}</td>
            <td>{[process.wait_event_type, process.wait_event].filter(Boolean).join(' / ') || '—'}</td>
            <td>{process.blocking_pids.join(', ') || '—'}</td>
          </tr>
        {:else}
          <tr><td colspan="7">{loading ? 'Loading sessions…' : 'No matching sessions.'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <section class="details" aria-label="Selected process">
    {#if active}
      <strong>Session {active.pid} · {active.database}</strong>
      {#if active.state?.startsWith('idle in transaction')}<p class="warning">Open transaction — may hold locks even though no query is running.</p>{/if}
      {#if blocked.length}<p class="warning">Blocking sessions: {blocked.join(', ')}</p>{/if}
      <small>{active.state === 'active' ? 'Current query' : 'Last query'}</small>
      <pre>{active.query || 'Query text unavailable. Your role may need pg_read_all_stats.'}</pre>
    {:else}
      <p>Select a PID to inspect its query and manage the session.</p>
    {/if}
  </section>
  <footer>
    <small>Cancel stops a statement. Terminate disconnects the session and rolls back its transaction.</small>
    <button class="btn-sm" disabled={!active?.backend_start || active.state !== 'active' || acting || loading} onclick={() => act('cancel')}>Cancel query</button>
    <button class="btn-sm danger" disabled={!active?.backend_start || acting || loading} onclick={() => act('terminate')}>Terminate session…</button>
  </footer>
</section>

<style>
  .processes-panel { flex: 1; min-height: 0; padding: 20px; overflow: auto; background: var(--panel); color: var(--text); }
  header, .filters, footer { display: flex; align-items: center; gap: 12px; }
  h2 { margin: 0 0 4px; font-size: 16px; }
  small { color: var(--text-dim); }
  .filters { margin: 18px 0 12px; }
  .filters > input { flex: 1; min-width: 100px; }
  label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .process-grid { max-height: 35vh; overflow: auto; border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
  th { position: sticky; top: 0; background: var(--panel); color: var(--text-dim); }
  th, td { padding: 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td small { display: block; margin-top: 3px; }
  tr.selected { background: var(--selection, #264f78); }
  .pid { padding: 3px 6px; font: inherit; }
  .details { margin-top: 16px; }
  .details > small { display: block; margin-top: 10px; }
  pre { max-height: 20vh; min-height: 60px; overflow: auto; padding: 10px; background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; user-select: text; }
  p { margin: 8px 0; }
  .error { color: var(--danger, #f48771); }
  .warning { color: #dcca83; }
  footer { margin-top: 16px; flex-wrap: wrap; }
  footer small { flex: 1; min-width: 220px; }
</style>
