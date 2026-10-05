<script lang="ts">
  import { Save, X } from '@lucide/svelte'
  import { confirmAction } from '../lib/desktop'
  import { useToast } from '../composables/toast'
  import { useResults } from '../composables/results'
  import { api, type ApiError } from '../api'
  import { formatCellForDisplay } from '../lib/gridio'
  import {
    editorKind, fromEditorValue, isArrayType, isMultiDimensionalArray,
    isReadOnlyType, jsonSyntaxError, numberStep, toBool, toEditorValue,
    usesTextarea, type EditorKind,
  } from '../lib/celleditor'
  import type { RowEditTarget } from '../lib/rowEditTarget'

  interface Field {
    index: number
    name: string
    type: string
    kind: EditorKind
    tag: string | null
    editable: boolean
    nullable: boolean
    maxLength: number | null
    original: unknown
    wasNull: boolean
    null: boolean
    text: string
    initialText: string
    bool: boolean
    initialBool: boolean
  }

  let { target, onclose, onsaved }: {
    target: RowEditTarget
    onclose: () => void
    onsaved: (row: Record<string, unknown>) => void
  } = $props()
  const toast = useToast()
  const results = useResults()

  function buildFields(target: RowEditTarget): Field[] {
    const { grid, row } = target
    const meta = new Map((grid.editable?.columns ?? []).map((column) => [column.name, column]))
    const counts = new Map<string, number>()
    for (const name of grid.columns) counts.set(name, (counts.get(name) ?? 0) + 1)
    return grid.columns.map((name, index) => {
      // Ambiguous/non-column/binary/multidimensional values remain locked.
      const type = grid.columnTypes[index] ?? ''
      const info = counts.get(name) === 1 ? meta.get(name) : undefined
      const original = row[index] ?? null
      const wasNull = original === null || original === undefined
      const kind = editorKind(type)
      const multiDimensional = isArrayType(type) && !wasNull && isMultiDimensionalArray(String(original))
      let tag: string | null = null
      if (!info) tag = 'not a plain column'
      else if (info.pk) tag = 'primary key'
      else if (info.generated) tag = 'generated'
      else if (isReadOnlyType(type)) tag = 'binary'
      else if (multiDimensional) tag = 'multi-dimensional'
      const initialText = wasNull ? '' : toEditorValue(String(original), type)
      return {
        index, name, type, kind, tag,
        editable: info !== undefined && !info.pk && !info.generated && !isReadOnlyType(type) && !multiDimensional,
        nullable: info?.nullable === true,
        maxLength: grid.columnTypeLengths?.[index] ?? null,
        original, wasNull, null: wasNull, text: initialText, initialText,
        bool: toBool(original), initialBool: toBool(original),
      }
    })
  }

  function orderFields(list: Field[]): Field[] {
    const meta = (field: Field) => field.name.startsWith('_')
    return [...list.filter((field) => !meta(field)), ...list.filter(meta)]
  }

  // One draft per mounted dialog, not a derived value that resets while typing.
  // svelte-ignore state_referenced_locally
  const fields = $state(orderFields(buildFields(target)))
  let saving = $state(false)
  let error = $state<string | null>(null)

  function isDirty(field: Field): boolean {
    if (!field.editable) return false
    if (field.null !== field.wasNull) return true
    if (field.null) return false
    if (field.kind === 'boolean') return field.bool !== field.initialBool
    return field.text !== field.initialText
  }

  const dirty = $derived(fields.filter(isDirty))
  const changeCount = $derived(dirty.length)
  const keyFields = $derived(fields.filter((field) => field.tag === 'primary key'))
  const tableLabel = $derived(target.grid.editable ? `${target.grid.editable.schema}.${target.grid.editable.table}` : '')

  async function save() {
    const editable = target.grid.editable
    if (saving || !editable || !changeCount) return
    for (const field of dirty) {
      if (field.kind !== 'json' || field.null) continue
      const problem = jsonSyntaxError(field.text)
      if (problem) {
        error = `Invalid JSON in "${field.name}": ${problem}`
        return
      }
    }
    const key: Record<string, unknown> = {}
    for (const field of keyFields) key[field.name] = field.original
    const set: Record<string, unknown | null> = {}
    for (const field of dirty) {
      set[field.name] = field.null ? null : field.kind === 'boolean' ? field.bool
        : fromEditorValue(field.text, field.type, field.original != null ? String(field.original) : undefined)
    }
    saving = true
    error = null
    try {
      const response = await api.updateRow(target.connectionId, {
        tabKey: target.tabKey, transactionId: target.transactionId,
        schema: editable.schema, table: editable.table, key, set,
      })
      results.updateTransaction(target.tabKey, response, target.transactionId)
      toast.show(response.transactionOpen ? 'Row updated in the open transaction.' : 'Row updated.')
      onsaved(response.row)
      onclose()
    } catch (cause) {
      results.updateTransaction(target.tabKey, cause as ApiError, target.transactionId)
      error = (cause as Error).message
    } finally {
      saving = false
    }
  }

  async function close() {
    if (saving) return
    const count = changeCount
    if (count && !await confirmAction(`Discard ${count} unsaved change(s)?`)) return
    onclose()
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      void close()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onmousedown={(event) => { if (event.target === event.currentTarget) void close() }}>
  <div class="modal rowedit-modal" role="dialog" aria-modal="true" aria-label="Edit row" tabindex="-1">
    <button class="icon rowedit-close" title="Close" onclick={close}><X size={16} /></button>
    <h2>
      <span class="rowedit-title">Edit row</span>
      {#if tableLabel}<span class="rowedit-table">{tableLabel}</span>{/if}
      {#if target.transactionId}<span class="txn-badge" title="SAVE joins the open transaction">TXN</span>{/if}
    </h2>
    <div class="rowedit-fields">
      <table class="rowedit-grid">
        <thead><tr><th>Column</th><th>Value</th><th class="rowedit-col-null">NULL</th></tr></thead>
        <tbody>
          {#each fields as field (field.index)}
            <tr class="rowedit-field">
              <td class="rowedit-label">
                <div class="rowedit-name">{field.name}</div>
                <div class="rowedit-meta"><span class="rowedit-type">{field.type}</span>{#if field.tag}<span class="rowedit-tag">{field.tag}</span>{/if}</div>
              </td>
              <td class="rowedit-control">
                {#if !field.editable}
                  <span class="rowedit-locked" class:nul={field.wasNull}>
                    {#if field.wasNull}<span class="null-badge">null</span>{:else}{formatCellForDisplay(field.original)}{/if}
                  </span>
                {:else if field.kind === 'boolean'}
                  <input bind:checked={field.bool} type="checkbox" disabled={field.null} aria-label={field.name} />
                {:else if field.kind === 'number'}
                  <!-- Keep numeric input as text: binding a number loses precision and marks unchanged decimals dirty. -->
                  <input value={field.text} class="rowedit-input" type="number" step={numberStep(field.type)}
                    disabled={field.null} aria-label={field.name} oninput={(event) => { field.text = event.currentTarget.value }} />
                {:else if field.kind === 'date' || field.kind === 'time' || field.kind === 'datetime'}
                  <input bind:value={field.text} class="rowedit-input" type={field.kind === 'datetime' ? 'datetime-local' : field.kind}
                    step="any" disabled={field.null} aria-label={field.name} />
                {:else if usesTextarea(field.type)}
                  <textarea bind:value={field.text} class="rowedit-textarea" class:json={field.kind === 'json'} spellcheck="false"
                    maxlength={field.maxLength ?? undefined} disabled={field.null} aria-label={field.name}></textarea>
                {:else}
                  <input bind:value={field.text} class="rowedit-input" type="text" spellcheck="false"
                    maxlength={field.maxLength ?? undefined} disabled={field.null} aria-label={field.name} />
                {/if}
              </td>
              {#if field.editable && field.nullable}
                <td class="rowedit-null"><input bind:checked={field.null} type="checkbox" title={`Set ${field.name} to NULL`} aria-label={`Set ${field.name} to NULL`} /></td>
              {:else}<td class="rowedit-null-empty"></td>{/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if error}<div class="rowedit-error">{error}</div>{/if}
    <div class="rowedit-foot">
      <span class="rowedit-count">{changeCount ? `${changeCount} change(s)` : 'No changes'}</span>
      <span class="rowedit-actions">
        <button disabled={saving} onclick={close}>CANCEL</button>
        <button class="primary" disabled={saving || !changeCount} onclick={save}><Save size={14} /> {saving ? 'SAVING…' : 'SAVE'}</button>
      </span>
    </div>
  </div>
</div>
