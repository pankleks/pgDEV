<script lang="ts">
  import { ListX, PanelRightClose, PanelTopClose, Pin, PinOff, X } from '@lucide/svelte'
  import { useTabs, type EditorTab } from '../composables/tabs'
  import { useConnection } from '../composables/connection'
  import { confirmResultRelease, releaseTab } from '../composables/results'
  import { confirmAction } from '../lib/desktop'
  import { stateView } from '../lib/state.svelte'
  import QueryEditor from './QueryEditor.svelte'

  let { onrun }: { onrun: () => void } = $props()
  const tabs = useTabs()
  const conn = useConnection()
  const snapshot = stateView(() => ({
    tabs: tabs.state.tabs.map((tab) => ({ ...tab, displayTitle: tabs.displayTitle(tab), pinned: tabs.isPinned(tab.key) })),
    activeKey: tabs.state.activeKey, connectionId: conn.state.id,
  }))
  const active = $derived(snapshot.current.tabs.find((tab) => tab.key === snapshot.current.activeKey) ?? null)
  let menu = $state<{ x: number; y: number; tabKey: string } | null>(null)
  let dragKey = $state<string | null>(null)
  let dropIndex = $state<number | null>(null)
  let suppressClick = $state(false)

  function openMenu(event: MouseEvent, tabKey: string) {
    event.preventDefault()
    const tab = tabs.state.tabs.find((tab) => tab.key === tabKey)
    menu = { x: Math.min(event.clientX, window.innerWidth - 198), y: Math.min(event.clientY, window.innerHeight - (tab?.source === 'file' ? 150 : 120) - 8), tabKey }
  }
  function togglePin(key: string) {
    const tab = tabs.state.tabs.find((entry) => entry.key === key)
    if (!tab || tab.source !== 'file') return
    if (tab.pinnedId && tabs.isPinned(key)) void tabs.unpinFile(tab.pinnedId)
    else void tabs.pinTab(key)
  }
  function menuItem(action: () => void) { action(); menu = null }
  function onTabClick(key: string) { if (!suppressClick) tabs.activate(key) }
  function onDragStart(event: DragEvent, key: string) {
    dragKey = key
    dropIndex = null
    suppressClick = true
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', key)
    }
  }
  function onDragOverTab(event: DragEvent, index: number) {
    if (dragKey === null) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndex = event.clientX < rect.left + rect.width / 2 ? index : index + 1
  }
  function onDragOverStrip(event: DragEvent) {
    if (dragKey === null) return
    event.preventDefault()
    dropIndex = tabs.state.tabs.length
  }
  function onDragEnd() { dragKey = null; dropIndex = null }
  function onDrop(event: DragEvent) {
    event.preventDefault()
    if (dragKey !== null && dropIndex !== null) tabs.moveTabToIndex(dragKey, dropIndex)
    onDragEnd()
  }
  function closeSession(key: string) { releaseTab(key, conn.state.id) }
  async function canClose(tab: EditorTab) {
    if (!tabs.isDirty(tab)) return true
    const content = tab.content
    return await confirmAction(`Close unsaved changes in "${tab.title}"?`) && tab.content === content
  }
  async function canCloseTabs(openTabs: EditorTab[], action: string) {
    // Use the owning store's objects, not display snapshots, for stale approvals.
    const original = openTabs.map((tab) => ({ tab, content: tab.content }))
    for (const tab of openTabs) if (!await canClose(tab)) return false
    if (!await confirmResultRelease(action, openTabs.map((tab) => tab.key))) return false
    return original.every(({ tab, content }) => tabs.state.tabs.includes(tab) && tab.content === content)
  }
  async function closeTab(key: string) {
    const tab = tabs.state.tabs.find((tab) => tab.key === key)
    if (!tab || !await canCloseTabs([tab], 'Close this tab')) return
    closeSession(key)
    tabs.close(key)
  }
  async function closeAllTabs() {
    const openTabs = [...tabs.state.tabs]
    if (!await canCloseTabs(openTabs, 'Close all tabs')) return
    for (const tab of openTabs) { closeSession(tab.key); tabs.close(tab.key) }
  }
  async function closeOtherTabs(key: string) {
    const toClose = tabs.state.tabs.filter((tab) => tab.key !== key)
    if (!await canCloseTabs(toClose, 'Close other tabs')) return
    for (const tab of toClose) { closeSession(tab.key); tabs.close(tab.key) }
    tabs.activate(key)
  }
  async function closeRightTabs(key: string) {
    const index = tabs.state.tabs.findIndex((tab) => tab.key === key)
    if (index === -1) return
    const toClose = tabs.state.tabs.slice(index + 1)
    if (!await canCloseTabs(toClose, 'Close tabs to the right')) return
    for (const tab of toClose) { closeSession(tab.key); tabs.close(tab.key) }
  }
  const menuIndex = $derived(menu ? snapshot.current.tabs.findIndex((tab) => tab.key === menu!.tabKey) : -1)
  const menuTab = $derived(menu ? snapshot.current.tabs.find((tab) => tab.key === menu!.tabKey) ?? null : null)
  const staleDdl = $derived(!!active?.connectionId && !!snapshot.current.connectionId && active.connectionId !== snapshot.current.connectionId)
</script>

<svelte:window onclick={() => { menu = null }} />
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="editor-tabs" data-component="svelte-editor-tabs">
  <div class="tabstrip" ondblclick={(event) => { if (event.target === event.currentTarget) tabs.newQuery() }}
    ondragover={(event) => { if (event.target === event.currentTarget) onDragOverStrip(event) }} ondrop={onDrop}>
    {#each snapshot.current.tabs as tab, index (tab.key)}
      <div class="tab" class:active={tab.key === snapshot.current.activeKey} class:agent-tab={tab.agentOpened === true || tab.aiMirror === true}
        class:dragging={dragKey === tab.key} class:drop-before={dropIndex === index} class:drop-after={dropIndex === index + 1}
        draggable="true" onmousedown={() => { suppressClick = false }} onclick={() => onTabClick(tab.key)}
        oncontextmenu={(event) => openMenu(event, tab.key)} ondragstart={(event) => onDragStart(event, tab.key)}
        ondragover={(event) => onDragOverTab(event, index)} ondragend={onDragEnd}>
        <span class="tab-title" title={tab.displayTitle}>{tab.displayTitle}</span>
        <button class="tab-close" title="Close tab" draggable="false" onclick={(event) => { event.stopPropagation(); void closeTab(tab.key) }}><X size={14} /></button>
      </div>
    {/each}
  </div>
   {#if staleDdl}<div class="stale-ddl">This SQL is bound to an earlier or different connection session. Restarting the app also starts a new session, even for the same database. Re-open the object to refresh it; running it here is disabled.</div>{/if}
  {#if active}<QueryEditor tab={active} {onrun} />
  {:else}<div class="editor-empty"><p>No open tabs</p><button class="primary" onclick={() => tabs.newQuery()}>New query</button></div>{/if}
  {#if menu}
    <div class="tab-menu" style:left={`${menu.x}px`} style:top={`${menu.y}px`} onclick={(event) => event.stopPropagation()}>
      {#if menuTab?.source === 'file'}
        <button onclick={() => menuItem(() => togglePin(menu!.tabKey))}>
          {#if menuTab.pinnedId && menuTab.pinned}<PinOff size={14} />{:else}<Pin size={14} />{/if}
          {menuTab.pinnedId && menuTab.pinned ? 'Unpin' : 'Pin'}
        </button>
      {/if}
      <button onclick={() => menuItem(() => { void closeAllTabs() })}><ListX size={14} /> Close all</button>
      <button disabled={snapshot.current.tabs.length <= 1} onclick={() => menuItem(() => { void closeOtherTabs(menu!.tabKey) })}><PanelTopClose size={14} /> Close all except this</button>
      <button disabled={menuIndex >= snapshot.current.tabs.length - 1} onclick={() => menuItem(() => { void closeRightTabs(menu!.tabKey) })}><PanelRightClose size={14} /> Close all on the right</button>
    </div>
  {/if}
</div>
