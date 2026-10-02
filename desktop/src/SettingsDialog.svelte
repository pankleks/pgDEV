<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { sanitizeSettings, SETTING_LIMITS, type DesktopSettings } from './lib/settings'
  let { settings, saving, error, writable, onsave, onclose }: { settings: DesktopSettings; saving: boolean; error: string; writable: boolean; onsave: (settings: DesktopSettings) => void; onclose: () => void } = $props()
  // One draft per opening; later preference saves must not overwrite edits.
  let draft = $state(untrack(() => sanitizeSettings(settings)))
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal() })
</script>

<dialog bind:this={dialog} aria-label="Settings" oncancel={(event) => { event.preventDefault(); if (!saving) onclose() }}>
  <h2>Settings</h2>
  <label>Editor font size (px)
    <input type="number" min={SETTING_LIMITS.editorFontSize.min} max={SETTING_LIMITS.editorFontSize.max} step="1" bind:value={draft.editorFontSize} disabled={saving} />
  </label>
  <label>Statement timeout (seconds)
    <input type="number" min={SETTING_LIMITS.statementTimeout.min} max={SETTING_LIMITS.statementTimeout.max} step="1" bind:value={draft.statementTimeout} disabled={saving} />
  </label>
  <p class="notice">Timeout changes apply to new connections. Reconnect to update the current connection.</p>
  <label>Query/page row limit
    <input type="number" min={SETTING_LIMITS.maxRows.min} max={SETTING_LIMITS.maxRows.max} step="1" bind:value={draft.maxRows} disabled={saving} />
  </label>
  <p class="notice">Row limits apply to the next query or page fetch. Existing results remain unchanged.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !writable}<p class="notice">Settings cannot be saved until the stored settings can be read. Changes will apply only for this run.</p>{/if}
  <div class="toolbar">
    <button onclick={() => onsave(sanitizeSettings(draft))} disabled={saving}>{saving ? 'Saving…' : writable ? 'Apply and save' : 'Apply for this run'}</button>
    <button onclick={() => { draft = sanitizeSettings(null) }} disabled={saving}>Reset to defaults</button>
    <button onclick={onclose} disabled={saving}>Close</button>
  </div>
</dialog>

<style>
  dialog::backdrop { background: #0009; }
  dialog { width: min(540px, 90vw); padding: 20px; background: #222; color: #ddd; border: 1px solid #555; }
  label { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 12px 0; }
  input { width: 100px; }
</style>
