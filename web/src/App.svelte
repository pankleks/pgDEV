<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte'
  import { Database, FileOutput, FilePlus2, FolderOpen, PanelLeftClose, PanelLeftOpen, Save, Settings, SlidersHorizontal, Wand2, X } from '@lucide/svelte'
  import ConnectDialog from './components/ConnectDialog.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import ObjectBrowser from './components/ObjectBrowser.svelte'
  import EditorTabs from './components/EditorTabs.svelte'
  import ResultsPanel from './components/ResultsPanel.svelte'
  import { useConnection } from './composables/connection'
  import { useTabs, type EditorTab } from './composables/tabs'
  import { useResults } from './composables/results'
  import { useSettings } from './composables/settings'
  import { useToast } from './composables/toast'
  import { useAi } from './composables/ai'
  import { api } from './api'
  import { getActiveSelection, triggerFormat, triggerParamMap } from './lib/formatbridge'
  import { isPickerCancelled, openTextFiles, saveTextFile } from './lib/files'
  import { confirmAction, desktop } from './lib/desktop'
  import { flushStorage, storageReady } from './lib/storage'

  const conn = useConnection()
  const tabs = useTabs()
  const results = useResults()
  const settings = useSettings()
  const toast = useToast()
  const ai = useAi()
  let settingsOpen = $state(false)
  let paramBar = $state(false)
  let paramValuesText = $state('')
  let paramInput = $state<HTMLInputElement>()
  let saving = $state(false)
  let version = $state('')
  const activeTab = $derived(tabs.state.tabs.find((tab) => tab.key === tabs.state.activeKey) ?? null)

  function suggestedFileName(tab: EditorTab) {
    const base = (tab.fileName ?? tab.title).trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/, '') || 'query'
    return /\.[^./\\]+$/.test(base) ? base : `${base}.sql`
  }
  async function openFiles() {
    try {
      const picked = await openTextFiles()
      for (const { fileName, content, handle } of picked) tabs.openFile(fileName, content, handle)
    } catch (cause) {
      if (!isPickerCancelled(cause)) toast.show(`Open failed: ${(cause as Error).message}`)
    }
  }
  async function saveActive(saveAs = false) {
    const tab = activeTab
    if (!tab || saving) return
    const key = tab.key
    const pinnedId = tab.pinnedId
    const content = tab.content
    const fileName = suggestedFileName(tab)
    const handle = tabs.fileHandle(key)
    const pickName = saveAs || tab.source === 'untitled'
    saving = true
    try {
      const saved = await saveTextFile(content, fileName, handle, pickName)
      if (saved) {
        if (tabs.state.tabs.some((entry) => entry.key === key)) tabs.markSaved(key, saved.fileName, saved.handle, content)
        else if (pinnedId) tabs.markPinnedSaved(pinnedId, saved.fileName, content, saved.handle)
      }
    } catch (cause) {
      if (!isPickerCancelled(cause)) toast.show(`Save failed: ${(cause as Error).message}`)
    } finally { saving = false }
  }
  let sideW = $state(336)
  let resultsH = $state(240)
  let sideCollapsed = $state(false)
  let sizesReady = $state(false)
  let dragKind: 'side' | 'results' | null = null
  let sizesTimer = 0
  function toggleSide() { sideCollapsed = !sideCollapsed; settings.setSideCollapsed(sideCollapsed) }
  $effect(() => {
    const width = sideW
    const height = resultsH
    if (!sizesReady) return
    untrack(() => {
      window.clearTimeout(sizesTimer)
      sizesTimer = window.setTimeout(() => settings.setPanelSizes(width, height), 300)
    })
  })
  $effect(() => { if (paramBar) void tick().then(() => paramInput?.focus()) })
  function flushSizes() { window.clearTimeout(sizesTimer); settings.setPanelSizes(sideW, resultsH) }
  function startDrag(event: PointerEvent, kind: 'side' | 'results') {
    event.preventDefault()
    dragKind = kind
    try { (event.target as HTMLElement).setPointerCapture(event.pointerId) } catch { /* window listeners suffice */ }
    document.body.classList.add(kind === 'side' ? 'dragging-side' : 'dragging-results')
  }
  function onMouseUp() { dragKind = null; document.body.classList.remove('dragging-side', 'dragging-results') }
  function onMouseMove(event: PointerEvent) {
    if (dragKind === 'side') sideW = Math.min(640, Math.max(180, event.clientX))
    else if (dragKind === 'results') resultsH = Math.min(window.innerHeight - 220, Math.max(80, window.innerHeight - event.clientY))
  }
  function onKeyDown(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
    if (event.code === 'KeyS') { event.preventDefault(); void saveActive() }
    else if (event.code === 'KeyO') { event.preventDefault(); void openFiles() }
    else if (event.code === 'KeyN') { event.preventDefault(); tabs.newQuery() }
  }
  const desktopSubscriptions: (() => void)[] = []
  onMount(() => {
    void api.version().then((value) => { version = value }).catch(() => undefined)
    void settings.ready.then(() => {
      sideW = settings.state.panelSizes.sideW
      resultsH = settings.state.panelSizes.resultsH
      sideCollapsed = settings.state.sideCollapsed
      sizesReady = true
    })
    desktopSubscriptions.push(desktop().onBeforeClose(async () => {
      const busy = Object.values(results.state.byTab).some((result) => result.running || result.loadingMore || result.transactionOpen)
      if (busy && !await confirmAction('Quit pgDEV? Running queries will stop and open transactions will roll back. Editor text will be kept in the session.')) throw new Error('Close canceled')
      flushSizes()
      await tabs.saveSession()
      await flushStorage()
      ai.stop()
    }))
    desktopSubscriptions.push(desktop().onBackendFailure(() => {
      conn.state.id = null
      for (const key of Object.keys(results.state.byTab)) results.drop(key)
      toast.show('Database service stopped. Save your work and restart pgDEV; open transactions have ended.')
    }))
    const warned = new Set<string>()
    const warning = (message: string) => { if (!warned.has(message)) { warned.add(message); toast.show(message) } }
    desktopSubscriptions.push(desktop().onStorageWarning(warning))
    void storageReady.then((stored) => stored.warnings?.forEach(warning))
    window.addEventListener('pointermove', onMouseMove)
    window.addEventListener('pointerup', onMouseUp)
    window.addEventListener('pointercancel', onMouseUp)
    window.addEventListener('pagehide', flushSizes)
    window.addEventListener('keydown', onKeyDown, true)
    void ai.start()
    void tabs.sessionsReady.then(() => {
      if (!tabs.state.tabs.length) tabs.newQuery()
      return Promise.all([conn.ready, settings.ready, tabs.pinsReady])
    }).then(() => conn.autoConnect())
  })
  onDestroy(() => {
    desktopSubscriptions.forEach((unsubscribe) => unsubscribe())
    ai.stop()
    window.clearTimeout(sizesTimer)
    onMouseUp()
    window.removeEventListener('pointermove', onMouseMove)
    window.removeEventListener('pointerup', onMouseUp)
    window.removeEventListener('pointercancel', onMouseUp)
    window.removeEventListener('pagehide', flushSizes)
    window.removeEventListener('keydown', onKeyDown, true)
  })
  function toggleParamBar() { paramBar = !paramBar; if (paramBar) paramValuesText = '' }
  function applyParamValues() {
    const text = paramValuesText.trim()
    paramBar = false
    paramValuesText = ''
    triggerParamMap(text || undefined)
  }
  function runActive() {
    if (!conn.state.id) { toast.show('Connect to a database first'); conn.state.dialog = true; return }
    const tab = tabs.state.tabs.find((tab) => tab.key === tabs.state.activeKey)
    if (!tab) { toast.show('No active tab'); return }
    if (tab.readOnly) { toast.show('DDL preview is read-only'); return }
    if (tab.connectionId && tab.connectionId !== conn.state.id) {
      toast.show('This SQL belongs to another connection — re-open it to run against the current database')
      return
    }
    const existing = results.state.byTab[tab.key]
    if (existing?.running || existing?.loadingMore) {
      toast.show(existing.loadingMore ? 'Rows are still loading…' : existing.cancelling ? 'Query is being canceled…' : 'Query already running')
      return
    }
    const selected = getActiveSelection()
    const sql = selected?.trim() ? selected : tab.content
    if (!sql.trim()) { toast.show('Nothing to run'); return }
    void results.run(tab.key, conn.state.id, sql)
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="app" data-renderer="svelte-5">
  <header class="topbar">
    <span class="logo"><Database size={15} /> pgDEV</span>
    <button class="icon" title={sideCollapsed ? 'Expand navigation panel' : 'Collapse navigation panel'} onclick={toggleSide}>
      {#if sideCollapsed}<PanelLeftOpen size={15} />{:else}<PanelLeftClose size={15} />{/if}
    </button>
    {#if conn.state.id}<button class="conn-badge" title="Connection details, disconnect, or switch" onclick={() => { conn.state.dialog = true }}>{conn.state.label}</button>
    {:else}<button class="conn-badge off" title="Open the connection dialog" onclick={() => { conn.state.dialog = true }}>Not connected</button>{/if}
    <span class="spacer"></span>
    <button class="icon" title="Format SQL or selection (Ctrl+Shift+F)" disabled={!activeTab || activeTab.readOnly} onclick={triggerFormat}><Wand2 size={15} /></button>
    <button class="icon" title="Generate call of parameterized query." disabled={!activeTab || activeTab.readOnly} onclick={toggleParamBar}><SlidersHorizontal size={15} /></button>
    <button class="icon" title="New query tab (Ctrl+N)" onclick={() => tabs.newQuery()}><FilePlus2 size={15} /></button>
    <button class="icon" title="Open .sql file (Ctrl+O)" onclick={openFiles}><FolderOpen size={15} /></button>
    <button class="icon" disabled={!activeTab || saving} title={saving ? 'Saving…' : 'Save active tab (Ctrl+S)'} aria-label={saving ? 'Saving' : 'Save active tab'} onclick={() => saveActive()}><Save size={15} /></button>
    <button class="icon" disabled={!activeTab || saving} title="Save active tab as a new SQL file" aria-label="Save active tab as a new SQL file" onclick={() => saveActive(true)}><FileOutput size={15} /></button>
    <button class="icon" title="Settings" onclick={() => { settingsOpen = true }}><Settings size={15} /></button>
    {#if version}<a class="app-version" href="https://github.com/pankleks/pgdev" target="_blank" rel="noopener noreferrer" title="Open the pgDEV project page on GitHub">{version}</a>{/if}
  </header>
  {#if paramBar}
    <div class="param-bar">
      <SlidersHorizontal size={13} class="param-bar-icon" />
      <input bind:this={paramInput} bind:value={paramValuesText} type="text" spellcheck="false" placeholder='Optional values as a JSON array — e.g. [1, "text", [10, 12], false, null] · Enter to apply'
        onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyParamValues() } else if (event.key === 'Escape') { event.preventDefault(); paramBar = false } }} />
      <button class="btn-sm primary" title="Apply values to the generated script" onclick={applyParamValues}>Apply</button>
      <button class="icon" title="Close" onclick={() => { paramBar = false }}><X size={14} /></button>
    </div>
  {/if}
  <div class="body">
    <aside class="sidebar" style:display={sideCollapsed ? 'none' : undefined} style:width={`${sideW}px`}><ObjectBrowser /></aside>
    {#if !sideCollapsed}<div class="drag-v" onpointerdown={(event) => startDrag(event, 'side')}></div>{/if}
    <main class="pgdev-main">
      <section class="editor-area"><EditorTabs onrun={runActive} /></section>
      <div class="drag-h" onpointerdown={(event) => startDrag(event, 'results')}></div>
      <section class="results-area" style:height={`${resultsH}px`}><ResultsPanel onrun={runActive} /></section>
    </main>
  </div>
  {#if conn.state.dialog}<ConnectDialog />{/if}
  {#if settingsOpen}<SettingsDialog onclose={() => { settingsOpen = false }} />{/if}
  {#if toast.state.visible}<div class="toast">{toast.state.text}</div>{/if}
</div>
