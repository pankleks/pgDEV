<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { api, errorMessage, transactionFromError, type Connected, type QueryResult, type SchemaData, type DdlTarget } from './api'
  import QueryEditor from './QueryEditor.svelte'
  import ObjectBrowser from './ObjectBrowser.svelte'
  import RowEditor from './RowEditor.svelte'
  import TableEditor from './TableEditor.svelte'
  import type { DataResult, TableEditState, TableEditRequest } from './generated/contracts'

  let tableEditing = $state<TableEditState | null>(null)
  let tableLoading = $state(false)
  let tableGenerating = $state(false)
  let tableError = $state('')
  let tablePreview = $state<string | null | undefined>(undefined)
  let tableRequest = 0

  async function openTableEditor(oid: string) {
    if (!connection || disconnecting || editing || tableEditing) return
    const id = connection.id
    const request = ++tableRequest
    tableLoading = true; tableError = ''; tablePreview = undefined
    try {
      const state = await api.tableEditState(id, oid)
      if (connection?.id === id && request === tableRequest) tableEditing = state
    } catch (error) {
      if (connection?.id === id && request === tableRequest) tableError = errorMessage(error)
    } finally { if (request === tableRequest) tableLoading = false }
  }

  async function generateTableSql(request: TableEditRequest) {
    if (!connection || !tableEditing || tableGenerating || disconnecting) return
    const id = connection.id
    const oid = tableEditing.oid
    tableGenerating = true; tableError = ''; tablePreview = undefined
    try {
      const result = await api.tableEditDdl(id, oid, request)
      if (connection?.id === id && tableEditing?.oid === oid) tablePreview = result.ddl
    } catch (error) {
      if (connection?.id === id && tableEditing?.oid === oid) tableError = errorMessage(error)
    } finally { tableGenerating = false }
  }

  let editing = $state<{ result: DataResult; rowIndex: number } | null>(null)
  let editError = $state('')
  let saving = $state(false)

  async function saveRow(set: Record<string, string | null>) {
    if (!connection || !editing?.result.editable || saving || running || disconnecting) return
    const id = connection.id
    const { result, rowIndex } = editing
    const grid = result.editable!
    const key = Object.fromEntries(grid.pk.map(name => [name, result.rows[rowIndex][result.columns.indexOf(name)]]))
    saving = true
    editError = ''
    try {
      const response = await api.rowUpdate({ id, tabKey, transactionId, schema: grid.schema, table: grid.table, key, set })
      if (connection?.id !== id) return
      result.rows[rowIndex] = result.columns.map((name, index) => Object.hasOwn(response.row, name) ? response.row[name] : result.rows[rowIndex][index])
      transactionId = response.transactionId
      editing = null
    } catch (error) {
      if (connection?.id !== id) return
      editError = errorMessage(error)
      const state = transactionFromError(error)
      if (state !== undefined) transactionId = state
    } finally { saving = false }
  }

  let catalog = $state<SchemaData | null>(null)
  let catalogLoading = $state(false)
  let catalogError = $state('')
  let ddlPreview = $state<{ label: string; ddl: string; readOnly: boolean } | null>(null)
  let ddlLoading = $state(false)
  let ddlError = $state('')
  let catalogRequest = 0
  let ddlRequest = 0

  async function refreshCatalog() {
    if (!connection || disconnecting) return
    const id = connection.id
    const request = ++catalogRequest
    catalogLoading = true
    catalogError = ''
    try {
      const data = await api.schema(id)
      if (connection?.id === id && request === catalogRequest) catalog = data
    } catch (error) {
      if (connection?.id === id && request === catalogRequest) catalogError = errorMessage(error)
    } finally { if (request === catalogRequest) catalogLoading = false }
  }

  async function openDdl(target: DdlTarget, label: string) {
    if (!connection || disconnecting) return
    const id = connection.id
    const request = ++ddlRequest
    ddlLoading = true
    ddlError = ''
    try {
      const response = await api.ddl(id, target)
      if (connection?.id === id && request === ddlRequest) ddlPreview = { label, ddl: response.ddl, readOnly: response.readOnly }
    } catch (error) {
      if (connection?.id === id && request === ddlRequest) ddlError = errorMessage(error)
    } finally { if (request === ddlRequest) ddlLoading = false }
  }

  let uri = $state('')
  let connection = $state<Connected | null>(null)
  let sql = $state('SELECT current_database(), version();')
  let results = $state<QueryResult[]>([])
  let transactionId = $state<string | null>(null)
  let durationMs = $state<number | null>(null)
  let queryEditor: { getSql(): string } | undefined
  let message = $state('')
  let running = $state(false)
  let connecting = $state(false)
  let disconnecting = $state(false)
  const tabKey = crypto.randomUUID()
  const native = isTauri()

  async function connect() {
    if (connecting || connection || !uri.trim()) return
    connecting = true
    message = ''
    try { connection = await api.connect(uri); uri = ''; void refreshCatalog() }
    catch (error) { message = errorMessage(error) }
    finally { connecting = false }
  }

  async function run(sqlToRun: string) {
    if (!connection || running || disconnecting || saving || editing || tableEditing) return
    running = true
    message = ''
    results = []
    durationMs = null
    const id = connection.id
    try {
      const response = await api.query({ id, tabKey, sql: sqlToRun, transactionId, maxRows: 500 })
      if (connection?.id !== id) return
      results = response.results
      transactionId = response.transactionId
      durationMs = response.durationMs
    }
    catch (error) {
      if (connection?.id !== id) return
      message = errorMessage(error)
      const state = transactionFromError(error)
      if (state !== undefined) transactionId = state
    }
    finally { running = false }
  }

  async function more(index: number) {
    const result = results[index]
    if (!connection || running || disconnecting || result.kind !== 'data' || !result.truncated) return
    const id = connection.id
    running = true
    message = ''
    try {
      const page = await api.fetchMore(id, tabKey)
      if (connection?.id !== id) return
      result.rows.push(...page.rows)
      result.rowCount += page.rowCount
      result.truncated = page.truncated
    } catch (error) {
      if (connection?.id !== id) return
      message = errorMessage(error)
      result.truncated = false
    } finally { running = false }
  }

  async function cancel() {
    if (!connection) return
    try { await api.cancel(connection.id, tabKey) }
    catch (error) { message = errorMessage(error) }
  }

  async function disconnect() {
    if (!connection || disconnecting) return
    disconnecting = true
    try {
      await api.disconnect(connection.id)
      connection = null; results = []; transactionId = null; durationMs = null
      catalog = null; ddlPreview = null; catalogError = ''; ddlError = ''; editing = null; editError = ''
      tableEditing = null; tableError = ''; tablePreview = undefined; ++tableRequest; tableLoading = false
      ++catalogRequest; ++ddlRequest; catalogLoading = false; ddlLoading = false
    }
    catch (error) { message = errorMessage(error) }
    finally { disconnecting = false }
  }
</script>

<header><strong>pgDEV</strong><span>Desktop migration prototype</span></header>
<main>
  <p class="notice">Integration prototype — not the final 1:1 interface. Object catalog, DDL previews, row updates and table-change SQL generation are available alongside typed results, cursor paging and transactions.</p>
  {#if !native}<p class="error">Open this interface through Tauri. Browser operation is not supported.</p>{/if}
  <section class="toolbar">
    {#if connection}
       <span>Connected · PostgreSQL {connection.pgVersion}</span>
      <button onclick={disconnect} disabled={disconnecting || saving}>Disconnect</button>
    {:else}
      <label for="connection">Connection string</label>
      <input id="connection" type="password" bind:value={uri} placeholder="postgresql://user:password@localhost/database" autocomplete="off" />
      <button onclick={connect} disabled={!native || connecting || !uri.trim()}>{connecting ? 'Connecting…' : 'Connect'}</button>
    {/if}
  </section>
  <div class="workspace">
  <ObjectBrowser data={catalog} loading={catalogLoading} error={catalogError} onrefresh={refreshCatalog} onopen={openDdl} onedit={openTableEditor} />
  <div class="query-pane">
  <section class="toolbar">
    <span>Query</span>
    <button onclick={() => run(queryEditor?.getSql() ?? sql)} disabled={!connection || running || disconnecting}>Run · F5</button>
    <button onclick={cancel} disabled={!running || disconnecting}>Cancel</button>
    {#if transactionId}
      <span>Transaction open</span>
      <button onclick={() => run('COMMIT')} disabled={running || disconnecting}>Commit</button>
      <button onclick={() => run('ROLLBACK')} disabled={running || disconnecting}>Rollback</button>
    {/if}
  </section>
  <QueryEditor bind:this={queryEditor} bind:value={sql} onrun={run} />
  {#if tableLoading}<p class="notice">Loading table editor…</p>{/if}
  {#if tableError && !tableEditing}<pre class="error" role="alert">{tableError}</pre>{/if}
  {#if ddlLoading}<p class="notice">Loading DDL…</p>{/if}
  {#if ddlError}<pre class="error" role="alert">{ddlError}</pre>{/if}
  {#if ddlPreview}
    <section class="ddl-preview">
      <div class="toolbar"><strong>DDL · {ddlPreview.label}</strong><button onclick={() => { ++ddlRequest; ddlLoading = false; ddlPreview = null }}>Close preview</button></div>
      <p class="notice">Read-only preview{ddlPreview.readOnly ? ' · materialized view' : ''}. Your query and transaction remain unchanged.</p>
      <pre>{ddlPreview.ddl}</pre>
    </section>
  {/if}
  {#if message}<pre class="error" role="alert">{message}</pre>{/if}
  {#if durationMs !== null}<p class="notice">Completed in {durationMs} ms</p>{/if}
  {#each results as result, index}
    <section class="result">
      <h2>Result {index + 1} · {result.rowCount} row(s)</h2>
      {#if result.kind === 'command'}
        <p class="notice">{result.command}</p>
      {:else}
        {#if result.limited}<p class="notice">Showing {result.rowCount} of {result.totalRowCount} rows. This result is not pageable.</p>{/if}
        <div class="grid"><table>
           <thead><tr>{#each result.columns as column, col}<th>{column}<small>{result.columnTypes[col]}{result.columnTypeLengths[col] !== null ? `(${result.columnTypeLengths[col]})` : ''}</small></th>{/each}{#if result.editable}<th>Edit</th>{/if}</tr></thead>
           <tbody>{#each result.rows as row, rowIndex}<tr>{#each row as cell}<td class:null={cell === null}>{cell === null ? 'NULL' : String(cell)}</td>{/each}{#if result.editable}<td><button disabled={running || disconnecting || saving} onclick={() => { editError = ''; editing = { result, rowIndex } }}>Edit row</button></td>{/if}</tr>{/each}</tbody>
        </table></div>
        {#if result.truncated}<button onclick={() => more(index)} disabled={running || disconnecting}>Load next 500 rows</button>{/if}
      {/if}
    </section>
  {/each}
  </div>
  </div>
</main>
{#if editing}<RowEditor result={editing.result} rowIndex={editing.rowIndex} {saving} error={editError} onsave={saveRow} onclose={() => { editing = null; editError = '' }} />{/if}
{#if tableEditing}<TableEditor state={tableEditing} generating={tableGenerating} error={tableError} preview={tablePreview} ongenerate={generateTableSql} ondirty={() => { tablePreview = undefined; tableError = '' }} onclose={() => { tableEditing = null; tableError = ''; tablePreview = undefined }} />{/if}

<style>
  .workspace { display: flex; gap: 16px; }
  .query-pane { min-width: 0; flex: 1; }
  .ddl-preview { border: 1px solid #444; padding: 12px; margin-top: 12px; }
  .ddl-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 350px; overflow: auto; }
</style>
