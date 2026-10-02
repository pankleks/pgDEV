<script lang="ts">
  import { onMount } from 'svelte'
  let { busy, error, saving, onconfirm, ondiscard, oncancel }: { busy: boolean; error: string; saving: boolean; onconfirm: () => void; ondiscard: () => void; oncancel: () => void } = $props()
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal() })
</script>

<dialog bind:this={dialog} aria-label="Close pgDEV" oncancel={(event) => { event.preventDefault(); if (!saving) oncancel() }}>
  <h2>Close pgDEV?</h2>
  {#if busy}<p>Running queries or writes will be interrupted. Open transactions will be rolled back. Autocommit changes already made are not undone. Unapplied changes in row/table/settings/parameter dialogs will be discarded.</p>{/if}
  <p>SQL tabs and applied settings will be saved. Database connections, results and transactions will not be restored.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="toolbar">
    <button onclick={onconfirm} disabled={saving}>{saving ? 'Saving…' : 'Save and exit'}</button>
    {#if error}<button onclick={ondiscard} disabled={saving}>Exit without saving</button>{/if}
    <button onclick={oncancel} disabled={saving}>Keep open</button>
  </div>
</dialog>

<style>
  dialog::backdrop { background: #0009; }
  dialog { width: min(540px, 90vw); padding: 20px; background: #222; color: #ddd; border: 1px solid #555; }
</style>
