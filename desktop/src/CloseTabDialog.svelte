<script lang="ts">
  import { onMount } from 'svelte'
  import type { QueryTab } from './lib/queryWorkspace'
  let { tab, onconfirm, oncancel }: { tab: QueryTab; onconfirm: () => void; oncancel: () => void } = $props()
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal() })
</script>

<dialog bind:this={dialog} aria-label="Close SQL tab" oncancel={(event) => { event.preventDefault(); if (!tab.closing) oncancel() }}>
  <h2>Close {tab.title}?</h2>
  {#if tab.sql.length}<p>SQL text in this tab will be discarded and removed from the saved session.</p>{/if}
  {#if tab.running}<p>The running query will be stopped.</p>{/if}
  {#if tab.transactionId}<p>The open transaction will be rolled back.</p>{/if}
  {#if tab.message && !tab.closing}<p class="error" role="alert">{tab.message}</p>{/if}
  <div class="toolbar">
    <button onclick={onconfirm} disabled={tab.closing || tab.saving}>{tab.closing ? 'Closing…' : 'Close tab'}</button>
    <button onclick={oncancel} disabled={tab.closing}>Keep tab</button>
  </div>
</dialog>

<style>
  dialog::backdrop { background: #0009; }
  dialog { width: min(500px, 90vw); padding: 20px; background: #222; color: #ddd; border: 1px solid #555; }
</style>
