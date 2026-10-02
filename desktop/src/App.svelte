<script lang="ts">
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { isTauri } from '@tauri-apps/api/core'
  import { api, errorMessage, type Connected, type SchemaData, type DdlTarget } from './api'
  import QueryEditor from './QueryEditor.svelte'
  import ObjectBrowser from './ObjectBrowser.svelte'
  import RowEditor from './RowEditor.svelte'
  import TableEditor from './TableEditor.svelte'
  import NoticePanel from './NoticePanel.svelte'
  import CloseTabDialog from './CloseTabDialog.svelte'
  import CloseAppDialog from './CloseAppDialog.svelte'
  import { snapshotSession, restoreQuerySession, createSessionWriter } from './lib/querySession'
  import { loadQuerySession, saveQuerySession, loadSettings, saveSettings } from './lib/sessionStorage'
  import { sanitizeSettings, settingsRecord, type DesktopSettings } from './lib/settings'
  import { createSnapshotWriter } from './lib/snapshotWriter'
  import SettingsDialog from './SettingsDialog.svelte'
  import type { SqlSubmission } from './lib/sqlDiagnostics'
  import ParameterDialog from './ParameterDialog.svelte'
  import type { ParameterTarget } from './lib/parameterMapping'
  import { createQueryWorkspace, createQueryController, tabNeedsConfirmation, tabIsDirty } from './lib/queryWorkspace'
  import { createFileController } from './lib/queryFiles'
  import { createExportController } from './lib/queryExport'
  import { createClipboardController } from './lib/queryClipboard'
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

  let editing = $state<{ tabKey: string; resultIndex: number; result: DataResult; rowIndex: number } | null>(null)

  async function saveRow(set: Record<string, string | null>) {
    const target = editing
    if (!target) return
    const success = await queries.rowUpdate(target.tabKey, target.resultIndex, target.rowIndex, set)
    if (success && editing === target) editing = null
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
  let connectionTimeout = $state<number | null>(null)
  let settings = $state(sanitizeSettings(null))
  let settingsReady = $state(false)
  let settingsWritable = $state(false)
  let settingsSaving = $state(false)
  let settingsError = $state('')
  let settingsOpen = $state(false)
  const settingsWriter = createSnapshotWriter(saveSettings)
  const workspace = $state(createQueryWorkspace())
  const queries = createQueryController(workspace, api, () => connection, () => disconnecting || !sessionReady || !settingsReady || appClosing, undefined, () => settings.maxRows)
  const files = createFileController(workspace, queries, api, () => !native || !sessionReady || appClosing)
  const exports = createExportController(workspace, api, () => connection, () => settings.maxRows, () => !native || appClosing || disconnecting)
  const exportBusy = $derived(workspace.tabs.some(tab => tab.exporting))
  const clipboard = createClipboardController(workspace, api, () => !native || appClosing)
  let clipboardBusy = $state(false)
  async function copyResult(key: string, index: number) {
    if (clipboardBusy) return
    clipboardBusy = true
    try { await clipboard.copy(key, index) }
    finally { clipboardBusy = false }
  }
  let fileOpening = $state(false)
  const fileBusy = $derived(fileOpening || workspace.tabs.some(tab => tab.fileSaving))

  async function openFile() {
    if (fileBusy || appClosing) return
    fileOpening = true; message = ''
    try { await files.open() }
    catch (error) { message = errorMessage(error) }
    finally { fileOpening = false }
  }
  async function saveFile(key: string, saveAs = false) {
    if (!fileBusy && !appClosing) await files.save(key, saveAs)
  }

  async function closeQueryTab(key: string) {
    const token = workspace.tabs.find(tab => tab.key === key)?.file?.token
    if (!await queries.closeTab(key)) return false
    try { await files.release(token) }
    catch (error) { message = errorMessage(error) }
    return true
  }
  const activeTab = $derived(workspace.tabs.find(tab => tab.key === workspace.activeKey)!)
  const results = $derived(activeTab.results)
  const transactionId = $derived(activeTab.transactionId)
  const durationMs = $derived(activeTab.durationMs)
  const running = $derived(activeTab.running)
  const saving = $derived(activeTab.saving)
  const editingTab = $derived(workspace.tabs.find(tab => tab.key === editing?.tabKey) ?? null)
  const noticeOutput = $derived(activeTab.notices)
  const anySaving = $derived(workspace.tabs.some(tab => tab.saving || tab.exporting))
  let closingKey = $state<string | null>(null)
  const closingTab = $derived(workspace.tabs.find(tab => tab.key === closingKey) ?? null)
  let queryEditor = $state<{ getSql(): string; getSubmission(): SqlSubmission; formatSql(): void; mapParameters(): void; applyParameterScript(target: ParameterTarget, script: string): boolean } | undefined>(undefined)
  let parameterEditing = $state<ParameterTarget | null>(null)

  function openParameters(target: ParameterTarget) {
    if (appClosing || editing || tableEditing || closingTab || settingsOpen || exitDialog) return
    parameterEditing = target
  }
  let message = $state('')
  let connecting = $state(false)
  let disconnecting = $state(false)
  const native = isTauri()
  let sessionReady = $state(false)
  let sessionWritable = $state(false)
  let sessionError = $state('')
  let exitHandlerError = $state('')
  let appClosing = $state(false)
  let exitDialog = $state(false)
  let exitError = $state('')
  const workInFlight = $derived(workspace.tabs.some(tab => tab.running || tab.saving || tab.exporting || tab.cancelling || tab.closing || tab.transactionId !== null))
  const sessionWriter = createSessionWriter(saveQuerySession)

  async function saveSession() {
    if (!sessionReady || !sessionWritable) throw new Error('Saved session could not be read. Automatic saving is disabled to protect existing SQL.')
    try { await sessionWriter.save(snapshotSession(workspace)); sessionError = '' }
    catch { sessionError = 'Could not save SQL tabs. Keep the application open and retry, or copy your SQL before exiting.'; throw new Error(sessionError) }
  }

  async function persistSettings() {
    if (!settingsReady || !settingsWritable) return
    try { await settingsWriter.save(settingsRecord(settings)); settingsError = '' }
    catch { settingsError = 'Could not save settings. Changes apply for this run; retry saving before exiting.'; throw new Error(settingsError) }
  }

  async function applySettings(value: DesktopSettings) {
    if (settingsSaving || appClosing || !settingsReady) return
    settings = sanitizeSettings(value)
    settingsSaving = true
    try { await persistSettings(); settingsOpen = false }
    catch { /* Keep the dialog open for retry; the error is visible. */ }
    finally { settingsSaving = false }
  }

  async function exitApplication(discard = false) {
    if (appClosing) return
    if (fileBusy || exportBusy || clipboardBusy) { exitError = 'Wait for file/clipboard operations to finish, or cancel the export before exiting.'; exitDialog = true; return }
    exitDialog = true; appClosing = true; exitError = ''
    try {
      if (!discard) { await saveSession(); await persistSettings() }
      await getCurrentWindow().destroy()
    } catch (error) { exitError = errorMessage(error); exitDialog = true }
    finally { appClosing = false }
  }

  onMount(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    if (native) {
      void getCurrentWindow().onCloseRequested(event => {
        event.preventDefault()
        if (appClosing) return
        if (workInFlight || fileBusy || editing || tableEditing || settingsOpen || settingsSaving || parameterEditing) exitDialog = true
        else void exitApplication()
      }).then(stop => { if (disposed) stop(); else unlisten = stop }).catch(() => {
        exitHandlerError = 'Could not install the exit-save handler. Save tabs manually before closing.'
      })
    }
    void (async () => {
      try {
        const stored = await loadQuerySession()
        if (disposed) return
        if (stored) {
          const restored = restoreQuerySession(stored)
          workspace.tabs = restored.tabs; workspace.activeKey = restored.activeKey; workspace.nextTitle = restored.nextTitle
          sessionWriter.markLoaded(stored)
        }
        sessionWritable = true
      } catch {
        if (!disposed) sessionError = 'Could not read saved SQL tabs. Automatic saving is disabled to protect the existing session. You can still work, but copy your SQL before exiting.'
      } finally { if (!disposed) sessionReady = true }
    })()
    void (async () => {
      try {
        const stored = await loadSettings()
        if (disposed) return
        if (stored) { settings = stored.settings; settingsWriter.markLoaded(stored) }
        settingsWritable = true
      } catch {
        if (!disposed) settingsError = 'Could not read saved settings. Defaults are in use; saving settings is disabled to protect the stored record.'
      } finally { if (!disposed) settingsReady = true }
    })()
    const interval = window.setInterval(() => {
      if (sessionReady && sessionWritable && !appClosing) void saveSession().catch(() => {})
      if (settingsReady && settingsWritable && !appClosing) void persistSettings().catch(() => {})
    }, 10_000)
    return () => { disposed = true; unlisten?.(); window.clearInterval(interval) }
  })

  async function connect() {
    if (connecting || connection || !uri.trim() || !sessionReady || !settingsReady || appClosing) return
    connecting = true
    message = ''
    const timeout = settings.statementTimeout
    try { connection = await api.connect(uri, timeout); connectionTimeout = timeout; uri = ''; void refreshCatalog() }
    catch (error) { message = errorMessage(error) }
    finally { connecting = false }
  }

  async function run(sqlToRun: string | SqlSubmission) {
    if (editing || tableEditing || closingTab || parameterEditing) return
    await queries.run(workspace.activeKey, typeof sqlToRun === 'string' ? sqlToRun : sqlToRun.sql, typeof sqlToRun === 'string' ? undefined : sqlToRun)
  }

  async function more(index: number) {
    if (!editing && !closingTab) await queries.more(workspace.activeKey, index)
  }

  async function cancel() {
    if (activeTab.exporting) await exports.cancel(activeTab.key)
    else await queries.cancel(workspace.activeKey)
  }

  async function requestCloseTab(key: string) {
    const tab = workspace.tabs.find(tab => tab.key === key)
    if (!tab || tab.saving || tab.fileSaving || tab.exporting || tab.cancelling || tab.closing || disconnecting || editing || tableEditing) return
    if (tabNeedsConfirmation(tab)) closingKey = key
    else await closeQueryTab(key)
  }

  async function confirmCloseTab() {
    if (closingKey && await closeQueryTab(closingKey)) closingKey = null
  }

  async function disconnect() {
    if (!connection || disconnecting || anySaving) return
    disconnecting = true
    try {
      await api.disconnect(connection.id)
      connection = null; connectionTimeout = null; queries.resetConnection(); closingKey = null
      catalog = null; ddlPreview = null; catalogError = ''; ddlError = ''; editing = null
      tableEditing = null; tableError = ''; tablePreview = undefined; ++tableRequest; tableLoading = false
      ++catalogRequest; ++ddlRequest; catalogLoading = false; ddlLoading = false
    }
    catch (error) { message = errorMessage(error) }
    finally { disconnecting = false }
  }
</script>

<header><strong>pgDEV</strong><span>Desktop migration prototype</span><button onclick={() => { settingsOpen = true }} disabled={!settingsReady || appClosing}>Settings</button></header>
<main>
  <p class="notice">Integration prototype — not the final 1:1 interface. Object catalog, DDL previews, row updates and table-change SQL generation are available alongside typed results, cursor paging and transactions.</p>
  {#if !native}<p class="error">Open this interface through Tauri. Browser operation is not supported.</p>{/if}
  <section class="toolbar">
    {#if connection}
       <span>Connected · PostgreSQL {connection.pgVersion} · timeout {connectionTimeout}s</span>
      <button onclick={disconnect} disabled={disconnecting || anySaving}>Disconnect</button>
    {:else}
      <label for="connection">Connection string</label>
      <input id="connection" type="password" bind:value={uri} placeholder="postgresql://user:password@localhost/database" autocomplete="off" />
      <button onclick={connect} disabled={!native || !sessionReady || !settingsReady || appClosing || connecting || !uri.trim()}>{connecting ? 'Connecting…' : 'Connect'}</button>
    {/if}
  </section>
  <div class="workspace">
  <ObjectBrowser data={catalog} loading={catalogLoading} error={catalogError} onrefresh={refreshCatalog} onopen={openDdl} onedit={openTableEditor} />
  <div class="query-pane">
  {#if !sessionReady}<p class="notice">Restoring SQL tabs…</p>{/if}
  {#if sessionError}<p class="error" role="alert">{sessionError}</p>{/if}
  {#if settingsError}<p class="error" role="alert">{settingsError}</p>{/if}
  {#if exitHandlerError}<p class="error" role="alert">{exitHandlerError}</p>{/if}
  <button onclick={() => { void saveSession().catch(() => {}) }} disabled={!sessionReady || !sessionWritable || appClosing}>Save SQL tabs</button>
  <div class="tabs" aria-label="SQL tabs">
    {#each workspace.tabs as tab (tab.key)}
      <div class:active={tab.key === workspace.activeKey} class="tab">
        <button aria-pressed={tab.key === workspace.activeKey} disabled={!sessionReady || appClosing} onclick={() => queries.activateTab(tab.key)}>{tab.title}{tabIsDirty(tab) ? ' *' : ''}{tab.fileSaving ? ' · saving file' : ''}{tab.exporting ? ' · exporting' : ''}{tab.running ? ' · running' : ''}{tab.transactionId ? ' · transaction' : ''}</button>
        <button aria-label={`Close ${tab.title}`} onclick={() => requestCloseTab(tab.key)} disabled={!sessionReady || appClosing || tab.saving || tab.fileSaving || tab.exporting || tab.cancelling || tab.closing || disconnecting}>×</button>
      </div>
    {/each}
    <button onclick={() => queries.addTab()} disabled={!sessionReady || appClosing || disconnecting}>+ New query</button>
  </div>
  <section class="toolbar">
    <span>Query</span>
    <button onclick={openFile} disabled={!native || !sessionReady || appClosing || fileBusy}>Open SQL</button>
    <button onclick={() => saveFile(activeTab.key)} disabled={!native || !sessionReady || appClosing || fileBusy || activeTab.closing}>Save file</button>
    <button onclick={() => saveFile(activeTab.key, true)} disabled={!native || !sessionReady || appClosing || fileBusy || activeTab.closing}>Save as…</button>
    <button onclick={() => run(queryEditor?.getSubmission() ?? activeTab.sql)} disabled={!connection || running || saving || activeTab.exporting || activeTab.cancelling || activeTab.closing || disconnecting}>Run · F5</button>
    <button onclick={() => queryEditor?.formatSql()} disabled={!sessionReady || appClosing}>Format · Ctrl/Cmd+Shift+F</button>
    <button onclick={() => queryEditor?.mapParameters()} disabled={!sessionReady || appClosing}>Map parameters</button>
    <button onclick={cancel} disabled={(!running && !activeTab.exporting) || activeTab.exportCancelRequested || activeTab.cancelling || activeTab.closing || disconnecting}>Cancel</button>
    {#if transactionId}
      <span>Transaction open</span>
      <button onclick={() => run('COMMIT')} disabled={running || saving || activeTab.exporting || activeTab.cancelling || activeTab.closing || disconnecting}>Commit</button>
      <button onclick={() => run('ROLLBACK')} disabled={running || saving || activeTab.exporting || activeTab.cancelling || activeTab.closing || disconnecting}>Rollback</button>
    {/if}
  </section>
  {#if sessionReady}<QueryEditor bind:this={queryEditor} tabs={workspace.tabs} activeKey={workspace.activeKey} {catalog} fontSize={settings.editorFontSize} onchange={queries.setSql} onerror={queries.setEditorError} onparameters={openParameters} onopenfile={openFile} onsavefile={saveFile} onrun={run} />{/if}
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
  {#if activeTab.message}<pre class="error" role="alert">{activeTab.message}</pre>{/if}
  {#if activeTab.editorError}<pre class="error" role="alert">{activeTab.editorError}</pre>{/if}
  {#if activeTab.exportMessage}<p class="notice">{activeTab.exportMessage}</p>{/if}
  {#if activeTab.clipboardMessage}<p class="notice" role="status">{activeTab.clipboardMessage}</p>{/if}
  {#if activeTab.clipboardError}<pre class="error" role="alert">{activeTab.clipboardError}</pre>{/if}
  {#if activeTab.file}<p class="notice">File: {activeTab.file.displayPath}</p>{/if}
  <NoticePanel output={noticeOutput} />
  {#if durationMs !== null}<p class="notice">Completed in {durationMs} ms</p>{/if}
  {#each results as result, index}
    <section class="result">
      <h2>Result {index + 1} · {result.rowCount} row(s)</h2>
      {#if result.kind === 'command'}
        <p class="notice">{result.command}</p>
      {:else}
        <button onclick={() => copyResult(activeTab.key, index)} disabled={!native || clipboardBusy || appClosing}>Copy loaded rows · TSV</button>
        <button onclick={() => exports.exportCsv(activeTab.key, index)} disabled={!native || running || saving || activeTab.exporting || activeTab.cancelling || activeTab.closing || disconnecting || appClosing || !!activeTab.exports[index]}>{result.limited ? 'Export loaded rows CSV' : 'Export CSV'}</button>
        {#if activeTab.exports[index]}<p class="notice">{activeTab.exports[index].incomplete ? 'Export interrupted. Re-run the query to obtain all rows.' : `${activeTab.exports[index].rows} rows exported; this cursor has been consumed.`}</p>{/if}
        {#if result.limited}<p class="notice">Showing {result.rowCount} of {result.totalRowCount} rows. This result is not pageable.</p>{/if}
        <div class="grid"><table>
           <thead><tr>{#each result.columns as column, col}<th>{column}<small>{result.columnTypes[col]}{result.columnTypeLengths[col] !== null ? `(${result.columnTypeLengths[col]})` : ''}</small></th>{/each}{#if result.editable}<th>Edit</th>{/if}</tr></thead>
            <tbody>{#each result.rows as row, rowIndex}<tr>{#each row as cell}<td class:null={cell === null}>{cell === null ? 'NULL' : String(cell)}</td>{/each}{#if result.editable}<td><button disabled={running || disconnecting || saving || activeTab.exporting || activeTab.closing} onclick={() => { activeTab.message = ''; editing = { tabKey: activeTab.key, resultIndex: index, result, rowIndex } }}>Edit row</button></td>{/if}</tr>{/each}</tbody>
        </table></div>
         {#if result.truncated}<button onclick={() => more(index)} disabled={running || saving || activeTab.exporting || activeTab.cancelling || activeTab.closing || disconnecting}>Load next {settings.maxRows} rows</button>{/if}
      {/if}
    </section>
  {/each}
  </div>
  </div>
</main>
{#if editing && editingTab}<RowEditor result={editing.result} rowIndex={editing.rowIndex} saving={editingTab.saving} error={editingTab.message} output={editingTab.notices} onsave={saveRow} onclose={() => { editing = null }} />{/if}
{#if closingTab}<CloseTabDialog tab={closingTab} onconfirm={confirmCloseTab} oncancel={() => { closingKey = null }} />{/if}
{#if tableEditing}<TableEditor state={tableEditing} generating={tableGenerating} error={tableError} preview={tablePreview} ongenerate={generateTableSql} ondirty={() => { tablePreview = undefined; tableError = '' }} onclose={() => { tableEditing = null; tableError = ''; tablePreview = undefined }} />{/if}
{#if settingsOpen}<SettingsDialog {settings} saving={settingsSaving} error={settingsError} writable={settingsWritable} onsave={applySettings} onclose={() => { settingsOpen = false }} />{/if}
{#if parameterEditing}<ParameterDialog target={parameterEditing} onapply={script => queryEditor?.applyParameterScript(parameterEditing!, script) ?? false} onclose={() => { parameterEditing = null }} />{/if}
{#if exitDialog}<CloseAppDialog busy={workInFlight || !!editing || !!tableEditing || settingsOpen || !!parameterEditing} error={exitError} saving={appClosing} onconfirm={() => { void exitApplication() }} ondiscard={() => { void exitApplication(true) }} oncancel={() => { exitDialog = false; exitError = '' }} />{/if}

<style>
  .workspace { display: flex; gap: 16px; }
  .query-pane { min-width: 0; flex: 1; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
  .tab { display: flex; border: 1px solid #444; }
  .tab.active { border-color: #679bc6; }
  .tab button { border: 0; background: transparent; }
  .ddl-preview { border: 1px solid #444; padding: 12px; margin-top: 12px; }
  .ddl-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 350px; overflow: auto; }
</style>
