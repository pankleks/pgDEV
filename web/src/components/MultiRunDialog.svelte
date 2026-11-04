<script lang="ts">
  import { onMount } from 'svelte'
  import { Database, Play, X } from '@lucide/svelte'
  import { useConnection } from '../composables/connection'
  import { stateView } from '../lib/state.svelte'
  import type { SavedConnection } from '../lib/connectionprofile'

  let { sql, onrun, onclose }: { sql: string; onrun: (profiles: SavedConnection[]) => void; onclose: () => void } = $props()
  const conn = useConnection()
  const snapshot = stateView(() => conn.saved().map((profile) => ({ ...profile })))
  let selected = $state([...conn.state.selectedIds])
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal() })
  function submit(event: SubmitEvent) {
    event.preventDefault()
    const profiles = snapshot.current.filter((entry) => selected.includes(entry.id))
    if (!profiles.length) return
    conn.selectProfiles(profiles.map((entry) => entry.id))
    onrun(profiles)
  }
</script>

<dialog bind:this={dialog} class="modal-backdrop" aria-labelledby="multi-title" oncancel={(event) => { event.preventDefault(); onclose() }} onclick={(event) => { if (event.target === event.currentTarget) onclose() }}>
  <div class="modal multirun-modal">
  <form onsubmit={submit}>
    <div class="modal-title">
      <h2 id="multi-title">Run on multiple connections</h2>
      <button class="icon" type="button" title="Close" onclick={onclose}><X size={16} /></button>
    </div>
    <p class="description">Run the selected SQL on each checked connection.</p>
    <div class="profiles">
      {#each snapshot.current as profile (profile.id)}
        <label class="profile-row" class:selected={selected.includes(profile.id)}><input type="checkbox" bind:group={selected} value={profile.id} /><Database size={16} /><span>{profile.name}</span></label>
      {/each}
      {#if !snapshot.current.length}<p class="description">No saved connections. Save a connection first.</p>{/if}
    </div>
    <details><summary>Selected SQL</summary><pre>{sql}</pre></details>
    <p class="warning">SQL may modify multiple databases. Execution is independent, not atomic across connections.</p>
    <div class="actions"><button type="button" onclick={onclose}>Cancel</button><button class="primary" disabled={!selected.some((id) => snapshot.current.some((entry) => entry.id === id))} type="submit"><Play size={13} /> Run on selected connections</button></div>
  </form>
  </div>
</dialog>

<style>
  dialog.modal-backdrop { width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; border: none; padding: 0; color: var(--text); }
  dialog::backdrop { background: transparent; }
  .modal-backdrop .modal.multirun-modal { width: min(520px, calc(100vw - 48px)); }
  .description, .warning { color: var(--text-dim); font-size: 12px; line-height: 1.5; }
  .profiles { max-height: 280px; overflow: auto; display: grid; gap: 6px; margin: 14px 0; }
  .profile-row { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); cursor: pointer; font-size: 12px; }
  .profile-row:hover, .profile-row.selected { border-color: var(--accent); }
  .profile-row input { width: auto; margin: 0; accent-color: var(--accent); }
  .profile-row span { min-width: 0; overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  details { margin-bottom: 12px; font-size: 12px; }
  summary { color: var(--text-dim); cursor: pointer; }
  pre { max-height: 160px; overflow: auto; white-space: pre-wrap; margin-top: 8px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); font: 12px/1.5 ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace; }
</style>
