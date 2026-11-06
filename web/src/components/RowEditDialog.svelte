<script lang="ts">
  import { dialogFocus } from '../lib/dialogfocus'
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
    /** Insert only: leave the column to the database (omitted from INSERT). */
    useDefault: boolean
    hasDefault: boolean
  }

  let { target, onclose, onsaved }: {
    target: RowEditTarget
    onclose: () => void
    onsaved: (row: Record<string, unknown>) => void
  } = $props()
  const toast = useToast()
  const results = useResults()

  /** What PostgreSQL's numeric input accepts, including NaN/Infinity. */
  const NUMBER_TEXT = /^\s*[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|nan|inf(?:inity)?)\s*$/i

  // The dialog is created per target, so its mode is fixed for its lifetime.
  // svelte-ignore state_referenced_locally
  const inserting = target.mode === 'insert'

  function buildFields(target: RowEditTarget): Field[] {
    const { grid, row } = target
    const meta = new Map((grid.editable?.columns ?? []).map((column) => [column.name, column]))
    const counts = new Map<string, number>()
    for (const name of grid.columns) counts.set(name, (counts.get(name) ?? 0) + 1)
    return grid.columns.map((name, index) => {
      // Ambiguous/non-column/binary/multidimensional values remain locked.
      const type = grid.columnTypes[index] ?? ''
      const info = counts.get(name) === 1 ? meta.get(name) : undefined
      const original = row?.[index] ?? null
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
      const hasDefault = info?.hasDefault === true
      // A new row may set its key; an existing row's key identifies it.
      const writable = info !== undefined && !info.generated && !isReadOnlyType(type) && !multiDimensional
      // Insert starts on DEFAULT where the database can fill the column in:
      // for a duplicate only a defaulted key (so the copy gets a fresh one),
      // for a blank row every column with a default or that allows NULL.
      const useDefault = inserting && writable &&
        (row ? info!.pk && hasDefault : hasDefault || info!.nullable)
      return {
        index, name, type, kind, tag,
        editable: writable && (inserting || !info!.pk),
        nullable: info?.nullable === true,
        maxLength: grid.columnTypeLengths?.[index] ?? null,
        original, wasNull, null: inserting && row ? wasNull : !inserting && wasNull,
        text: initialText, initialText,
        bool: toBool(original), initialBool: toBool(original),
        useDefault, hasDefault,
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
    // A new row sends every column that is not left to its default.
    if (inserting) return !field.useDefault
    if (field.null !== field.wasNull) return true
    if (field.null) return false
    if (field.kind === 'boolean') return field.bool !== field.initialBool
    return field.text !== field.initialText
  }

  const dirty = $derived(fields.filter(isDirty))
  const changeCount = $derived(dirty.length)
  const keyFields = $derived(fields.filter((field) => field.tag === 'primary key'))
  const tableLabel = $derived(target.grid.editable ? `${target.grid.editable.schema}.${target.grid.editable.table}` : '')
  // svelte-ignore state_referenced_locally
  const title = inserting ? (target.row ? 'Duplicate row' : 'New row') : 'Edit row'

  async function save() {
    const editable = target.grid.editable
    // A new row may be all defaults (INSERT … DEFAULT VALUES).
    if (saving || !editable || (!inserting && !changeCount)) return
    for (const field of dirty) {
      // A number input reports '' for a partial or invalid entry (`1e`, `-`);
      // sending that would fail with "invalid input syntax" on the server.
      if (field.kind === 'number' && !field.null && !NUMBER_TEXT.test(field.text)) {
        error = `"${field.name}" needs a number (or set it to NULL).`
        return
      }
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
      // A duplicated value left untouched is sent exactly as it was read: the
      // editor's display form (pretty JSON, local timestamps) is for typing.
      const untouched = inserting && !field.wasNull && field.text === field.initialText && field.kind !== 'boolean'
      set[field.name] = field.null ? null : field.kind === 'boolean' ? field.bool
        : untouched ? field.original
        : fromEditorValue(field.text, field.type, field.original != null ? String(field.original) : undefined)
    }
    saving = true
    error = null
    try {
      const request = { tabKey: target.tabKey, transactionId: target.transactionId, schema: editable.schema, table: editable.table }
      const response = inserting
        ? await api.insertRow(target.connectionId, { ...request, set })
        : await api.updateRow(target.connectionId, { ...request, key, set })
      results.updateTransaction(target.tabKey, response, target.transactionId)
      const verb = inserting ? 'inserted' : 'updated'
      toast.show(response.transactionOpen ? `Row ${verb} in the open transaction.` : `Row ${verb}.`)
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
    // A new row's DEFAULT-less fields are not "changes" until edited.
    const count = inserting ? 0 : changeCount
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
  <div class="modal rowedit-modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" use:dialogFocus>
    <button class="icon rowedit-close" title="Close" onclick={close}><X size={16} /></button>
    <h2>
      <span class="rowedit-title">{title}</span>
      {#if tableLabel}<span class="rowedit-table">{tableLabel}</span>{/if}
      {#if target.transactionId}<span class="txn-badge" title="SAVE joins the open transaction">TXN</span>{/if}
    </h2>
    <div class="rowedit-fields">
      <table class="rowedit-grid">
        <thead><tr><th>Column</th><th>Value</th>{#if inserting}<th class="rowedit-col-null">DEFAULT</th>{/if}<th class="rowedit-col-null">NULL</th></tr></thead>
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
                    {#if inserting}<span class="rowedit-default">{field.tag === 'generated' ? 'computed' : 'not set'}</span>
                    {:else if field.wasNull}<span class="null-badge">null</span>{:else}{formatCellForDisplay(field.original)}{/if}
                  </span>
                {:else if inserting && field.useDefault}
                  <span class="rowedit-locked"><span class="rowedit-default">{field.hasDefault ? 'database default' : 'NULL (no default)'}</span></span>
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
              {#if inserting}
                {#if field.editable}
                  <td class="rowedit-null"><input bind:checked={field.useDefault} type="checkbox" title={`Leave ${field.name} to its default`} aria-label={`Use the default for ${field.name}`} /></td>
                {:else}<td class="rowedit-null-empty"></td>{/if}
              {/if}
              {#if field.editable && field.nullable && !(inserting && field.useDefault)}
                <td class="rowedit-null"><input bind:checked={field.null} type="checkbox" title={`Set ${field.name} to NULL`} aria-label={`Set ${field.name} to NULL`} /></td>
              {:else}<td class="rowedit-null-empty"></td>{/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if error}<div class="rowedit-error">{error}</div>{/if}
    <div class="rowedit-foot">
      <span class="rowedit-count">{inserting ? `${changeCount} value(s) set, the rest default` : changeCount ? `${changeCount} change(s)` : 'No changes'}</span>
      <span class="rowedit-actions">
        <button disabled={saving} onclick={close}>CANCEL</button>
        <button class="primary" disabled={saving || (!inserting && !changeCount)} onclick={save}><Save size={14} /> {saving ? 'SAVING…' : inserting ? 'INSERT' : 'SAVE'}</button>
      </span>
    </div>
  </div>
</div>
