<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { TableEditState, TableEditRequest, TableEditColumnInput, TableEditColumnState } from './generated/contracts'

  let { state: tableState, generating, error, preview, ongenerate, onclose, ondirty }: { state: TableEditState; generating: boolean; error: string; preview: string | null | undefined; ongenerate: (request: TableEditRequest) => void; onclose: () => void; ondirty: () => void } = $props()
  type Draft = TableEditColumnInput & Partial<TableEditColumnState>
  let columns = $state<Draft[]>(untrack(() => tableState.columns.map(column => ({ ...column }))))
  let description = $state(untrack(() => tableState.description ?? ''))
  let dialog: HTMLDialogElement
  onMount(() => { dialog.showModal() })

  function addColumn() {
    columns.push({ id: crypto.randomUUID(), added: true, name: '', type: 'text', nullable: true, defaultValue: null, description: null })
    ondirty()
  }
</script>

<dialog bind:this={dialog} aria-label="Edit table" oncancel={(event) => { event.preventDefault(); if (!generating) onclose() }}>
  <h2>Edit table · {tableState.schema}.{tableState.name}</h2>
  <p class="notice">Generate a change-only SQL script for review. Nothing is executed automatically, and your query remains unchanged.</p>
  <form oninput={ondirty} onsubmit={(event) => { event.preventDefault(); ongenerate({ description, fingerprint: tableState.fingerprint, columns }) }}>
    <label for="table-description">Table description</label>
    <textarea id="table-description" bind:value={description} disabled={generating} rows="2"></textarea>
    <div class="table-scroll"><table>
      <thead><tr><th>Name / keys</th><th>Type</th><th>Nullable</th><th>Default expression</th><th>Description</th><th>Drop</th></tr></thead>
      <tbody>
        {#each columns as column (column.id)}
          <tr>
            <td><input aria-label={`Column ${column.id} name`} bind:value={column.name} disabled={generating} />
              {#if column.pk}<small>PK</small>{/if}
              {#each [...(column.fks ?? []), ...(column.uks ?? [])] as key}<small title={`${key.name}: ${key.definition}`}>{key.label}</small>{/each}
              {#if column.lockKind}<small>{column.lockKind}</small>{/if}
              {#if column.added}<small>new</small>{/if}
            </td>
            <td><input aria-label={`Column ${column.id} type`} bind:value={column.type} disabled={generating || column.locked} /></td>
            <td><input type="checkbox" aria-label={`Column ${column.id} nullable`} bind:checked={column.nullable} disabled={generating || column.pk || (column.locked && column.lockKind !== 'serial')} /></td>
            <td><textarea aria-label={`Column ${column.id} default`} bind:value={column.defaultValue} disabled={generating || column.locked} rows="2"></textarea></td>
            <td><textarea aria-label={`Column ${column.id} description`} bind:value={column.description} disabled={generating} rows="2"></textarea></td>
            <td><button type="button" disabled={generating || column.pk} onclick={() => { columns = columns.filter(c => c.id !== column.id); ondirty() }}>Drop</button></td>
          </tr>
        {/each}
      </tbody>
    </table></div>
    <div class="toolbar">
      <button type="button" onclick={addColumn} disabled={generating}>Add column</button>
      <button type="submit" disabled={generating}>{generating ? 'Generating…' : 'Generate SQL'}</button>
      <button type="button" onclick={onclose} disabled={generating}>Close</button>
    </div>
  </form>
  {#if error}<pre class="error" role="alert">{error}</pre>{/if}
  {#if preview !== undefined}
    {#if preview === null}<p class="notice">No changes.</p>{:else}<h3>Generated SQL · review before executing</h3><pre>{preview}</pre>{/if}
  {/if}
</dialog>

<style>
  dialog::backdrop { background: #0009; }
  dialog { width: min(1200px, 94vw); max-height: 88vh; overflow: auto; padding: 20px; background: #222; color: #ddd; border: 1px solid #555; }
  label { display: block; margin-bottom: 4px; }
  textarea { width: 100%; box-sizing: border-box; background: #181818; color: #ddd; border: 1px solid #555; padding: 6px; resize: vertical; font: inherit; }
  .table-scroll { overflow: auto; margin: 12px 0; }
  table { width: 100%; }
  td { vertical-align: top; min-width: 130px; }
  td:nth-child(3), td:last-child { min-width: 65px; }
  input:not([type='checkbox']) { width: 100%; box-sizing: border-box; }
  small { display: inline-block; margin: 4px 6px 0 0; color: #aaa; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
