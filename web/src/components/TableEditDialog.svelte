<script lang="ts">
  import { onMount } from 'svelte'
  import { KeyRound, Lock, Plus, RotateCcw, Table2, Trash2, X } from '@lucide/svelte'
  import { useConnection } from '../composables/connection'
  import { useTabs } from '../composables/tabs'
  import { useToast } from '../composables/toast'
  import { api } from '../api'
  import type { TableEditColumnState, TableEditKeyRef, TableEditState } from '../types'
  import { buildColumnType, parseColumnType, SIZE_BASES } from '../lib/tabletype'
  import type { TableEditTarget } from '../lib/tableEditTarget'

  interface EditRow {
    id: string
    name: string
    catalogName: string
    type: string
    base: string
    len: string
    scale: string
    nullable: boolean
    defaultValue: string
    description: string
    pk: boolean
    fks: TableEditKeyRef[]
    uks: TableEditKeyRef[]
    locked: boolean
    lockKind: TableEditColumnState['lockKind']
    added: boolean
    deleted: boolean
  }

  let { target, onclose }: { target: TableEditTarget; onclose: () => void } = $props()
  const conn = useConnection()
  const tabs = useTabs()
  const toast = useToast()
  // The parent closes this dialog on connection changes. All requests retain
  // the captured connection, never the replacement database's ID.
  const connectionId = conn.state.id
  let loading = $state(true)
  let loadError = $state('')
  let table = $state.raw<TableEditState | null>(null)
  let tableDescription = $state('')
  let fingerprint = $state('')
  const rows = $state<EditRow[]>([])
  let submitting = $state(false)
  let submitError = $state('')
  let newCounter = 0

  function rowOf(state: TableEditColumnState): EditRow {
    const parsed = parseColumnType(state.type)
    return {
      id: state.id, name: state.name, catalogName: state.name, type: state.type,
      base: parsed.base, len: parsed.len, scale: parsed.scale,
      nullable: state.nullable, defaultValue: state.defaultValue ?? '', description: state.description ?? '',
      pk: state.pk, fks: state.fks ?? [], uks: state.uks ?? [],
      locked: state.locked, lockKind: state.lockKind, added: false, deleted: false,
    }
  }

  function addRow() {
    rows.push({
      id: `new:${++newCounter}`, name: '', catalogName: '', type: '', base: '', len: '', scale: '',
      nullable: true, defaultValue: '', description: '', pk: false, fks: [], uks: [],
      locked: false, lockKind: undefined, added: true, deleted: false,
    })
  }

  function toggleDelete(row: EditRow) { if (!row.pk) row.deleted = !row.deleted }
  function removeRow(row: EditRow) {
    const index = rows.indexOf(row)
    if (index !== -1) rows.splice(index, 1)
  }
  function nullableDisabled(row: EditRow): boolean {
    return row.pk || (row.locked && row.lockKind !== 'serial')
  }
  const lockLabel: Record<string, string> = {
    identity: 'identity column', generated: 'generated column', serial: 'serial column',
  }
  const TYPE_SUGGESTIONS = [
    'boolean', 'smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision',
    'money', 'text', 'varchar', 'char', 'date', 'time', 'timestamp', 'timestamptz',
    'interval', 'uuid', 'json', 'jsonb', 'bytea', 'inet', 'cidr', 'xml',
    'serial', 'bigserial', 'smallserial',
  ]
  // Rebuild only after user interaction: untouched catalog spelling stays exact.
  function rebuildType(row: EditRow) { row.type = buildColumnType(row.base, row.len, row.scale) }
  function lenDisabled(row: EditRow) { return !SIZE_BASES.has(row.base) || row.locked || row.deleted }
  function scaleDisabled(row: EditRow) { return row.base !== 'numeric' || row.locked || row.deleted }
  function fkTooltip(row: EditRow) { return row.fks.map((key) => `${key.name}: ${key.definition}`).join('\n') }
  function ukTooltip(row: EditRow) { return row.uks.map((key) => `${key.name}: ${key.definition}`).join('\n') }
  function chipIndex(label: string) {
    const number = Number.parseInt(label.replace(/\D/g, ''), 10) || 0
    return ((number - 1) % 8) + 1
  }
  function typeChoices(row: EditRow) {
    return row.base && !TYPE_SUGGESTIONS.includes(row.base) ? [row.base, ...TYPE_SUGGESTIONS] : TYPE_SUGGESTIONS
  }

  async function load() {
    if (!connectionId) return
    loading = true
    loadError = ''
    try {
      const state = await api.tableEditState(connectionId, target.oid)
      table = state
      tableDescription = state.description ?? ''
      fingerprint = state.fingerprint
      const loaded = state.columns.map(rowOf)
      const meta = (row: EditRow) => row.name.startsWith('_')
      rows.splice(0, rows.length, ...loaded.filter((row) => !meta(row)), ...loaded.filter(meta))
    } catch (cause) {
      loadError = (cause as Error).message
    } finally {
      loading = false
    }
  }

  onMount(() => {
    if (!connectionId) onclose()
    else void load()
  })

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onclose()
    }
  }
  function validate(): string {
    for (const row of rows) {
      if (row.deleted) continue
      if (!row.name.trim()) return 'Every column needs a name'
      if (!row.type.trim()) return `Column "${row.name.trim()}" needs a type`
    }
    const names = new Set<string>()
    for (const row of rows) {
      if (row.deleted) continue
      const name = row.name.trim()
      if (names.has(name)) return `Column name "${name}" is used more than once`
      names.add(name)
    }
    return ''
  }

  async function submit() {
    if (!connectionId || !table || submitting) return
    const invalid = validate()
    if (invalid) { submitError = invalid; return }
    submitError = ''
    submitting = true
    try {
      const { ddl } = await api.tableEditSubmit(connectionId, target.oid, {
        description: tableDescription, fingerprint,
        columns: rows.filter((row) => !row.deleted).map((row) => ({
          id: row.id, added: row.added, name: row.name.trim(), type: row.type.trim(),
          nullable: row.nullable, defaultValue: row.defaultValue, description: row.description,
        })),
      })
      if (ddl === null) {
        toast.show('No changes — the table already matches')
        onclose()
        return
      }
      tabs.openSqlTab(`Edit ${table.name}`, ddl, connectionId)
      onclose()
    } catch (cause) {
      submitError = (cause as Error).message
    } finally {
      submitting = false
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onmousedown={(event) => { if (event.target === event.currentTarget && !submitting) onclose() }}>
  <div class="modal tableedit-modal" role="dialog" aria-modal="true" aria-label="Edit table" tabindex="-1">
    <button class="icon tableedit-close" title="Close" onclick={onclose}><X size={16} /></button>
    <h2><Table2 size={16} /> Edit table</h2>
    {#if loading}<div class="tableedit-status">Loading…</div>
    {:else if loadError}<div class="tableedit-status error-text">{loadError}</div>
    {:else if table}
      <div class="tableedit-body">
        <div class="tableedit-name"><label class="tableedit-label" for="tableedit-name">Table</label><input id="tableedit-name" value={`${table.schema}.${table.name}`} readonly /></div>
        <label class="tableedit-label" for="tableedit-desc">Description</label>
        <input id="tableedit-desc" bind:value={tableDescription} class="tableedit-desc" placeholder="Table comment (empty removes it)" />
        <div class="tableedit-grid">
          <div class="tableedit-grid-head">
            <span>Name</span><span>Type</span><span title="Length for varchar/char, precision for numeric">Length</span>
            <span title="Scale (numeric only)">Scale</span><span class="center" title="Nullable">Null</span>
            <span class="center" title="Primary key (read-only)">PK</span><span class="center" title="Unique key (read-only)">UK</span>
            <span class="center" title="Foreign key (read-only)">FK</span><span title="Default value">Default</span>
            <span title="Column description">Comment</span><span class="row-tools"></span>
          </div>
          {#each rows as row (row.id)}
            <div class="tableedit-row" class:deleted={row.deleted} class:meta={row.name.startsWith('_')}>
              <input bind:value={row.name} readonly={row.deleted} placeholder={row.added ? 'new column' : row.catalogName} spellcheck="false" aria-label="Column name" />
              <select value={row.base} disabled={row.locked || row.deleted} title={row.locked ? lockLabel[row.lockKind ?? ''] : 'Column type'} aria-label="Column type" onchange={(event) => { row.base = event.currentTarget.value; rebuildType(row) }}>
                {#if !row.base}<option value="" disabled>— select type —</option>{/if}
                {#each typeChoices(row) as type (type)}<option value={type}>{type}</option>{/each}
              </select>
              <!-- Keep length/scale as strings, and rebuild after updating the draft. -->
              <input value={row.len} type="number" min="1" class="len" disabled={lenDisabled(row)} title="Length (varchar, char) or precision (numeric)"
                oninput={(event) => { row.len = event.currentTarget.value; rebuildType(row) }} />
              <input value={row.scale} type="number" min="0" class="len" disabled={scaleDisabled(row)} title="Scale (numeric only)"
                oninput={(event) => { row.scale = event.currentTarget.value; rebuildType(row) }} />
              <input bind:checked={row.nullable} type="checkbox" disabled={nullableDisabled(row) || row.deleted}
                title={nullableDisabled(row) ? (row.pk ? 'Primary key columns are NOT NULL' : lockLabel[row.lockKind ?? '']) : 'Nullable'} aria-label="Nullable" />
              <span class="flag" class:on={row.pk} title={row.pk ? 'Primary key (read-only)' : ''}>{#if row.pk}<KeyRound size={13} />{/if}</span>
              <span class="fk-chips" title={ukTooltip(row)}>{#each row.uks as key (key.label)}<span class="fk-chip" data-idx={chipIndex(key.label)}>{key.label}</span>{/each}</span>
              <span class="fk-chips" title={fkTooltip(row)}>{#each row.fks as key (key.label)}<span class="fk-chip" data-idx={chipIndex(key.label)}>{key.label}</span>{/each}</span>
              <input bind:value={row.defaultValue} disabled={row.locked || row.deleted} spellcheck="false" placeholder={row.locked && row.lockKind === 'generated' ? '(generated)' : ''} aria-label="Default value" />
              <input bind:value={row.description} readonly={row.deleted} spellcheck="false" aria-label="Column comment" />
              <span class="row-tools">
                {#if row.locked}<span class="lock" title={`Read-only: ${lockLabel[row.lockKind ?? '']}`}><Lock size={12} /></span>{/if}
                {#if !row.added}
                  <button class="tool" disabled={row.pk} title={row.deleted ? 'Restore column' : row.pk ? 'Primary key columns cannot be dropped' : 'Delete column'} onclick={() => toggleDelete(row)}>
                    {#if row.deleted}<RotateCcw size={13} />{:else}<Trash2 size={13} />{/if}
                  </button>
                {:else}
                  <span class="added-badge">new</span><button class="tool" title="Remove column" onclick={() => removeRow(row)}><Trash2 size={13} /></button>
                {/if}
              </span>
            </div>
          {/each}
        </div>
        <button class="link tableedit-add" onclick={addRow}><Plus size={14} /> Add column</button>
        {#if submitError}<div class="error-text">{submitError}</div>{/if}
        <div class="tableedit-foot">
          <button class="primary" disabled={submitting} onclick={submit}>{submitting ? 'Generating…' : 'Generate DDL'}</button>
          <button class="ghost" disabled={submitting} onclick={onclose}>Cancel</button>
        </div>
      </div>
    {/if}
  </div>
</div>
