<script lang="ts">
  import { onMount } from 'svelte'
  import { parameterScript, type ParameterTarget } from './lib/parameterMapping'
  import { errorMessage } from './lib/errors'
  let { target, onapply, onclose }: { target: ParameterTarget; onapply: (script: string) => boolean; onclose: () => void } = $props()
  let dialog: HTMLDialogElement
  let values = $state('')
  let preview = $state<string | null>(null)
  let error = $state('')
  function generate() {
    preview = null; error = ''
    try { preview = parameterScript(target.submission.sql, values) }
    catch (failure) { error = errorMessage(failure) }
  }
  function apply() {
    if (preview === null) return
    try { if (onapply(preview)) onclose(); else error = 'Could not apply SQL to the editor' }
    catch (failure) { error = errorMessage(failure) }
  }
  onMount(() => { dialog.showModal(); generate() })
</script>

<dialog bind:this={dialog} aria-label="Map SQL parameters" oncancel={(event) => { event.preventDefault(); onclose() }}>
  <h2>Map SQL parameters</h2>
  <p class="notice">Generate a PREPARE / EXECUTE / DEALLOCATE script for review. Missing values become NULL; PostgreSQL infers parameter types.</p>
  <label for="parameter-values">Optional JSON values ($1, $2, …)</label>
  <textarea id="parameter-values" bind:value={values} oninput={() => { preview = null; error = '' }} placeholder='[1, "text", false, null]' spellcheck="false"></textarea>
  <p class="notice">For large integers, use JSON strings. Applied scripts become part of the locally saved SQL tabs. Nothing is executed automatically.</p>
  {#if error}<pre class="error" role="alert">{error}</pre>{/if}
  {#if preview !== null}<pre class="preview">{preview}</pre>{/if}
  <div class="toolbar">
    <button onclick={generate}>Generate preview</button>
    <button onclick={apply} disabled={preview === null}>Apply to editor</button>
    <button onclick={onclose}>Cancel</button>
  </div>
</dialog>

<style>
  dialog::backdrop { background: #0009; }
  dialog { width: min(760px, 90vw); max-height: 85vh; padding: 20px; background: #222; color: #ddd; border: 1px solid #555; }
  textarea { box-sizing: border-box; width: 100%; min-height: 80px; margin-top: 8px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .preview { max-height: 350px; overflow: auto; border: 1px solid #444; padding: 12px; }
</style>
