<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { DataResult } from './generated/contracts'

  let { result, rowIndex, saving, error, onsave, onclose }: { result: DataResult; rowIndex: number; saving: boolean; error: string; onsave: (set: Record<string, string | null>) => void; onclose: () => void } = $props()
  let fields = $state(untrack(() => (result.editable?.columns ?? []).map(column => {
    const index = result.columns.indexOf(column.name)
    const initial = result.rows[rowIndex][index]
    return { ...column, locked: column.pk || column.generated || result.columnTypes[index] === 'bytea', text: initial === null ? '' : String(initial), isNull: initial === null, initial: initial === null ? null : String(initial) }
  })))
  const changes = $derived(Object.fromEntries(fields.filter(field => !field.locked && (field.isNull ? null : field.text) !== field.initial).map(field => [field.name, field.isNull ? null : field.text])))
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal() })
</script>

  <dialog bind:this={dialog} aria-label="Edit row" oncancel={(event) => { event.preventDefault(); if (!saving) onclose() }}>
    <h2>Edit row · {result.editable?.schema}.{result.editable?.table}</h2>
    <p class="notice">Primary keys, generated columns and binary data are read-only. Only changed fields will be saved.</p>
    <form onsubmit={(event) => { event.preventDefault(); onsave(changes) }}>
      {#each fields as field}
        <div class="field">
          <label for={`row-field-${field.name}`}>{field.name}{field.pk ? ' · key' : field.generated ? ' · generated' : ''}</label>
          <textarea id={`row-field-${field.name}`} bind:value={field.text} disabled={saving || field.locked || field.isNull} rows="2"></textarea>
          {#if field.nullable && !field.locked}<label class="null-option"><input type="checkbox" bind:checked={field.isNull} disabled={saving} /> NULL</label>{/if}
        </div>
      {/each}
      {#if error}<pre class="error" role="alert">{error}</pre>{/if}
      <div class="toolbar">
        <button type="submit" disabled={saving || !Object.keys(changes).length}>{saving ? 'Saving…' : 'Save row'}</button>
        <button type="button" onclick={onclose} disabled={saving}>Cancel</button>
      </div>
    </form>
  </dialog>

<style>
  dialog::backdrop { background: #0009; }
  dialog { width: min(650px, 90vw); max-height: 85vh; overflow: auto; padding: 20px; background: #222; color: #ddd; border: 1px solid #555; }
  .field { margin: 12px 0; }
  .field > label:first-child { display: block; margin-bottom: 4px; }
  textarea { width: 100%; box-sizing: border-box; background: #181818; color: #ddd; border: 1px solid #555; padding: 8px; font: inherit; resize: vertical; }
  .null-option { display: flex; gap: 6px; margin-top: 4px; }
  input { flex: none; }
</style>
