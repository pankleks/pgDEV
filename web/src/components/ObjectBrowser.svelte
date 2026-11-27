<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import {
    ArrowLeft, ArrowLeftRight, ArrowRight, ChevronDown, ChevronRight, ChevronsUp,
    CircleAlert, CircleCheck, CircleSlash, Columns3, CornerDownRight, Ellipsis,
    Eye, FileText, Folder, FolderOpen, Grid2x2, KeyRound, Layers, Link, ListTree,
    LoaderCircle, Pencil, Pin, PinOff, RotateCw, ShieldCheck, Shapes, Sigma,
    Hash, SquareFunction, SquareTerminal, Table2, X, Zap,
  } from '@lucide/svelte'
  import { useConnection } from '../composables/connection'
  import { useSchema } from '../composables/schema'
  import { useSettings } from '../composables/settings'
  import { useTabs } from '../composables/tabs'
  import { useToast } from '../composables/toast'
  import { openObjectDdl, type DdlObjectType } from '../composables/ddl'
  import type { FunctionInfo, SequenceInfo, TableInfo, TypeInfo, ViewInfo } from '../types'
  import { entriesWithin, entryRows, groupKeysOf, groupNamedObjects, type NamedObjectEntry } from '../lib/objectgroups'
  import {
    autoExpandFunction, autoExpandRelation, columnsMatch, matchesTerms, nameMatches,
    paramRows, paramsMatch, parseSearch, scopedHighlight, searchTerms, type SearchType,
  } from '../lib/browserSearch'
  import { stateView } from '../lib/state.svelte'
  import type { TableEditTarget } from '../lib/tableEditTarget'
  import { treeNav } from '../lib/treenav'
  import TableEditDialog from './TableEditDialog.svelte'

  const conn = useConnection()
  const schema = useSchema()
  const settings = useSettings()
  const tabs = useTabs()
  const toast = useToast()
  const snapshot = stateView(() => ({
    id: conn.state.id, label: conn.state.label, data: schema.state.data,
    loading: schema.state.loading, error: schema.state.error,
    groupObjects: settings.state.groupObjects,
    pinnedFiles: tabs.state.pinnedFiles.map((pin) => ({ ...pin })),
  }))

  type BrowserSection = 'tables' | 'views' | 'types' | 'functions' | 'sequences'
  type BrowserNodeType =
    | 'section' | 'table-group' | 'table' | 'table-category' | 'table-column'
    | 'table-index' | 'table-constraint' | 'table-trigger' | 'view-group' | 'view'
    | 'view-column' | 'type-group' | 'type' | 'type-detail' | 'function-group'
    | 'function' | 'function-parameter' | 'sequence-group' | 'sequence' | 'sequence-detail'
  interface BrowserNode {
    type: BrowserNodeType
    key: string
    collapseKeys: string[]
    section?: BrowserSection
    groupKeys?: string[]
    groupState?: Set<string>
  }
  type BrowserEntry = NamedObjectEntry<TableInfo | ViewInfo | TypeInfo | FunctionInfo | SequenceInfo>
  const SECTION_META: Record<BrowserSection, { noun: string; scope: SearchType; groupType: BrowserNodeType; keyPrefix: string }> = {
    tables: { noun: 'tables', scope: 'table', groupType: 'table-group', keyPrefix: 't' },
    views: { noun: 'views', scope: 'view', groupType: 'view-group', keyPrefix: 'v' },
    types: { noun: 'types', scope: 'type', groupType: 'type-group', keyPrefix: 'ty' },
    functions: { noun: 'functions', scope: 'function', groupType: 'function-group', keyPrefix: 'f' },
    sequences: { noun: 'sequences', scope: 'sequence', groupType: 'sequence-group', keyPrefix: 's' },
  }
  interface BrowserContextMenu { x: number; y: number; node: BrowserNode }
  interface PinnedContextMenu { x: number; y: number; id: string }

  const open = $state({ tables: false, views: false, functions: false, types: false, sequences: false })
  const expanded = new SvelteSet<string>()
  const expandedTableGroups = new SvelteSet<string>()
  const expandedViewGroups = new SvelteSet<string>()
  const expandedFunctionGroups = new SvelteSet<string>()
  const expandedTypeGroups = new SvelteSet<string>()
  const expandedSequenceGroups = new SvelteSet<string>()
  let contextMenu = $state.raw<BrowserContextMenu | null>(null)
  let pinnedContextMenu = $state.raw<PinnedContextMenu | null>(null)
  let tableEditTarget = $state<TableEditTarget | null>(null)
  let treeElement = $state<HTMLElement | null>(null)
  /** The row a keyboard-opened menu returns focus to. */
  let menuOrigin: HTMLElement | null = null
  // What the user types; `filter` follows it after a short pause, so a fast
  // typist does not re-filter (and re-render) every list on each key.
  let filterInput = $state('')
  let filter = $state('')
  $effect(() => {
    const value = filterInput
    if (!value.trim()) {
      filter = value
      return
    }
    const timer = setTimeout(() => { filter = value }, 150)
    return () => clearTimeout(timer)
  })
  const parsed = $derived(parseSearch(filter))
  const queryTerms = $derived(searchTerms(parsed.term))
  const searchType = $derived(parsed.type)
  const isFiltering = $derived(filter.trim().length > 0)
  const tables = $derived(snapshot.current.data?.tables ?? [])
  const views = $derived(snapshot.current.data?.views ?? [])
  const functions = $derived(snapshot.current.data?.functions ?? [])
  const types = $derived(snapshot.current.data?.types ?? [])
  const sequences = $derived(snapshot.current.data?.sequences ?? [])
  const showTables = $derived(!isFiltering || searchType === null || searchType === 'table' || searchType === 'column')
  const showViews = $derived(!isFiltering || searchType === null || searchType === 'view' || searchType === 'column')
  const showFunctions = $derived(!isFiltering || searchType === null || searchType === 'function' || searchType === 'parameter')
  const showTypes = $derived(!isFiltering || searchType === null || searchType === 'type')
  const showSequences = $derived(!isFiltering || searchType === null || searchType === 'sequence')

  function highlightIn(value: string, ...scopes: SearchType[]) { return scopedHighlight(value, queryTerms, searchType, scopes) }
  function highlightText(value: string) { return highlightIn(value) }
  function nameMatched(name: string, schemaName: string) { return nameMatches(name, schemaName, queryTerms) }
  function colsMatched(cols: { name: string }[]) { return columnsMatch(cols, queryTerms) }
  function autoExpandRel(name: string, schemaName: string, cols: { name: string }[]) {
    return autoExpandRelation(name, schemaName, cols, isFiltering, queryTerms)
  }
  function autoExpandFunc(name: string, schemaName: string, args: string) {
    return autoExpandFunction(name, schemaName, args, isFiltering, queryTerms)
  }
  const filteredTables = $derived(showTables ? tables.filter((t) => !isFiltering || (
    searchType === 'column' ? colsMatched(t.columns) : searchType === 'table' ? nameMatched(t.name, t.schema)
      : nameMatched(t.name, t.schema) || colsMatched(t.columns)
  )) : [])
  const filteredViews = $derived(showViews ? views.filter((v) => !isFiltering || (
    searchType === 'column' ? colsMatched(v.columns) : searchType === 'view' ? nameMatched(v.name, v.schema)
      : nameMatched(v.name, v.schema) || colsMatched(v.columns)
  )) : [])
  const filteredFunctions = $derived(showFunctions ? functions.filter((f) => !isFiltering || (
    searchType === 'parameter' ? paramsMatch(f.args, queryTerms)
      : nameMatched(f.name, f.schema) || (searchType === null && paramsMatch(f.args, queryTerms))
  )) : [])
  const filteredTypes = $derived(showTypes ? types.filter((t) => !isFiltering || nameMatched(t.name, t.schema) || matchesTerms(t.detail, queryTerms)) : [])
  const filteredSequences = $derived(showSequences ? sequences.filter((s) => !isFiltering || nameMatched(s.name, s.schema) || matchesTerms(s.detail, queryTerms)) : [])
  const totalMatches = $derived(filteredTables.length + filteredViews.length + filteredFunctions.length + filteredTypes.length + filteredSequences.length)
  const overloadCounts = $derived.by(() => {
    const counts = new Map<string, number>()
    for (const f of functions) counts.set(`${f.schema}.${f.name}`, (counts.get(`${f.schema}.${f.name}`) ?? 0) + 1)
    return counts
  })
  const tableEntries = $derived(groupNamedObjects(filteredTables, snapshot.current.groupObjects, 'table'))
  const viewEntries = $derived(groupNamedObjects(filteredViews, snapshot.current.groupObjects, 'view'))
  const functionEntries = $derived(groupNamedObjects(filteredFunctions, snapshot.current.groupObjects, 'function'))
  const typeEntries = $derived(groupNamedObjects(filteredTypes, snapshot.current.groupObjects, 'type'))
  const sequenceEntries = $derived(groupNamedObjects(filteredSequences, snapshot.current.groupObjects, 'sequence'))

  // Rendering budget: each section shows entries until about PAGE rows (a
  // group header is one row, plus its objects while open), then a "Show more"
  // row adds another page. Keeps a schema with thousands of objects, or a
  // broad search, from building the whole tree in the DOM at once.
  const PAGE = 300
  const shown = $state({ tables: PAGE, views: PAGE, functions: PAGE, types: PAGE, sequences: PAGE })
  $effect(() => {
    void filter
    untrack(() => { for (const key of Object.keys(shown) as (keyof typeof shown)[]) shown[key] = PAGE })
  })
  function sectionRows<T extends BrowserEntry['objects'][number]>(entries: NamedObjectEntry<T>[], groups: Set<string>, limit: number) {
    return entriesWithin(entries, (entry) => entryRows(entry, (group) => objectGroupOpen(group, groups)), limit)
  }
  const tableCount = $derived(sectionRows(tableEntries, expandedTableGroups, shown.tables))
  const viewCount = $derived(sectionRows(viewEntries, expandedViewGroups, shown.views))
  const functionCount = $derived(sectionRows(functionEntries, expandedFunctionGroups, shown.functions))
  const typeCount = $derived(sectionRows(typeEntries, expandedTypeGroups, shown.types))
  const sequenceCount = $derived(sectionRows(sequenceEntries, expandedSequenceGroups, shown.sequences))

  function browserNode(type: BrowserNodeType, key: string, collapseKeys = [key], groupState?: Set<string>): BrowserNode {
    return { type, key, collapseKeys, groupState }
  }
  function nodeHasChildren(node: BrowserNode): boolean {
    if (node.type === 'section' && node.section) return true
    if ((node.groupKeys?.length ?? 0) > 0) return true
    return node.collapseKeys.some((root) => [...expanded].some((key) => key === root || key.startsWith(`${root}-`)))
  }
  function openNodeMenu(event: MouseEvent, node: BrowserNode, openable = true) {
    event.preventDefault()
    event.stopPropagation()
    cancelPendingToggle()
    pinnedContextMenu = null
    const tableNode = node.type === 'table'
    if (!openable || (!nodeHasChildren(node) && !tableNode)) { contextMenu = null; return }
    const height = tableNode && nodeHasChildren(node) ? 64 : 36
    contextMenu = {
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 178)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - height - 8)), node,
    }
    focusMenu(event, '.browser-node-menu')
  }
  function openPinnedMenu(event: MouseEvent, id: string) {
    event.preventDefault()
    event.stopPropagation()
    cancelPendingToggle()
    contextMenu = null
    pinnedContextMenu = {
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 178)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 44)), id,
    }
    focusMenu(event, '.pinned-menu')
  }
  // A menu opened from the keyboard (treeNav's synthetic event, or the
  // browser's own for the Menu key; only a right-click has button 2) takes
  // focus, and gives it back to its row on close.
  function focusMenu(event: MouseEvent, selector: string) {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-nav]') ?? event.currentTarget as HTMLElement
    menuOrigin = event.isTrusted && event.button === 2 ? null : row
    if (menuOrigin) void tick().then(() => document.querySelector<HTMLElement>(`${selector} button`)?.focus())
  }
  function restoreMenuFocus() {
    const origin = menuOrigin
    menuOrigin = null
    if (origin?.isConnected) origin.focus()
  }
  function menuKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }
  function collapseNode(node: BrowserNode) {
    node.groupState?.delete(node.key)
    if (node.type === 'section' && node.section) open[node.section] = false
    for (const key of node.groupKeys ?? []) node.groupState?.delete(key)
    for (const root of node.collapseKeys) for (const key of [...expanded]) {
      if (key === root || key.startsWith(`${root}-`)) expanded.delete(key)
    }
  }
  function collapseContextNode() { if (contextMenu) collapseNode(contextMenu.node); contextMenu = null; restoreMenuFocus() }
  function tableEditable(t: TableInfo) { return !t.isPartition && (t.relkind === 'r' || t.relkind === 'p') }
  function contextTable(node: BrowserNode) { return node.type === 'table' ? tables.find((t) => `t-${t.oid}` === node.key) ?? null : null }
  const contextCanEdit = $derived.by(() => {
    const t = contextMenu ? contextTable(contextMenu.node) : null
    return !!t && tableEditable(t)
  })
  const contextCanCollapse = $derived(!!contextMenu && nodeHasChildren(contextMenu.node))
  function editContextTable() {
    const node = contextMenu?.node
    contextMenu = null
    // Back on the row first, so the dialog returns focus there when it closes.
    restoreMenuFocus()
    const t = node ? contextTable(node) : null
    if (t && tableEditable(t)) tableEditTarget = { oid: t.oid, schema: t.schema, name: t.name }
  }
  function unpinContextFile() {
    const id = pinnedContextMenu?.id
    pinnedContextMenu = null
    if (id) void tabs.unpinFile(id)
  }
  async function openPinnedFile(id: string) {
    if (await tabs.openPinned(id) === 'fallback') {
      const pin = tabs.state.pinnedFiles.find((entry) => entry.id === id)
      toast.show(`Could not read "${pin?.fileName ?? 'pinned file'}"; opened its last saved copy`)
    }
  }
  function closeContextMenus() { contextMenu = null; pinnedContextMenu = null; menuOrigin = null }
  function onGlobalKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    contextMenu = null
    pinnedContextMenu = null
    restoreMenuFocus()
  }
  function flip(key: string) { if (expanded.has(key)) expanded.delete(key); else expanded.add(key) }
  function toggleChildren(key: string) { window.clearTimeout(clickTimer); pendingToggle = null; flip(key) }
  let clickTimer = 0
  let pendingToggle: { key: string; fired: boolean; at: number } | null = null
  function queueToggle(event: MouseEvent, key: string) {
    if (event.detail !== 1) return
    window.clearTimeout(clickTimer)
    pendingToggle = { key, fired: false, at: Date.now() }
    clickTimer = window.setTimeout(() => {
      flip(key)
      if (pendingToggle?.key === key) pendingToggle.fired = true
    }, 300)
  }
  function cancelPendingToggle() {
    window.clearTimeout(clickTimer)
    if (pendingToggle && Date.now() - pendingToggle.at < 600 && pendingToggle.fired) flip(pendingToggle.key)
    pendingToggle = null
  }
  function sectionNode(section: BrowserSection): BrowserNode {
    const collapseKeys = section === 'tables' ? tables.map((t) => `t-${t.oid}`)
      : section === 'views' ? views.map((v) => `v-${v.oid}`)
      : section === 'types' ? types.map((t) => `ty-${t.oid}`)
      : section === 'sequences' ? sequences.map((s) => `s-${s.oid}`) : functions.map((f) => `f-${f.oid}`)
    const entries: BrowserEntry[] = section === 'tables' ? groupNamedObjects(tables, snapshot.current.groupObjects, 'table')
      : section === 'views' ? viewEntries : section === 'types' ? typeEntries
      : section === 'sequences' ? sequenceEntries : functionEntries
    const groupKeys = groupKeysOf(entries)
    const groupState = section === 'tables' ? expandedTableGroups : section === 'views' ? expandedViewGroups
      : section === 'types' ? expandedTypeGroups : section === 'sequences' ? expandedSequenceGroups : expandedFunctionGroups
    return { ...browserNode('section', `section-${section}`, collapseKeys, groupState), section, groupKeys }
  }
  function objectGroupOpen(entry: { kind: 'group' | 'item'; key: string }, groups: Set<string>) {
    return entry.kind === 'item' || groups.has(entry.key) || (isFiltering && entry.kind === 'group')
  }
  function toggleObjectGroup(key: string, groups: Set<string>) { if (groups.has(key)) groups.delete(key); else groups.add(key) }
  function displayName(schemaName: string, name: string) { return schemaName === 'public' ? name : `${schemaName}.${name}` }
  function isTbd(name: string) { return name.includes('_tbd') }
  const PARAM_ICONS = { in: ArrowRight, out: ArrowLeft, inout: ArrowLeftRight, variadic: Ellipsis, returns: CornerDownRight }
  const INDEX_ICONS = { primary: KeyRound, unique: ShieldCheck, exclusion: CircleSlash, normal: ListTree }
  const FUNCTION_ICONS = { function: SquareFunction, procedure: SquareTerminal, window: Sigma, trigger: Zap, aggregate: Layers }
  type FunctionKind = keyof typeof FUNCTION_ICONS
  const FUNCTION_LABELS = { function: 'function', procedure: 'procedure', window: 'window function', trigger: 'trigger function', aggregate: 'aggregate' }
  function functionIcon(kind: string | undefined) { return FUNCTION_ICONS[(kind ?? 'function') as FunctionKind] ?? SquareFunction }
  const CONSTRAINT_META = {
    p: { icon: KeyRound, label: 'PRIMARY KEY', cls: 'primary' }, u: { icon: ShieldCheck, label: 'UNIQUE', cls: 'unique' },
    f: { icon: Link, label: 'FOREIGN KEY', cls: 'fk' }, c: { icon: CircleCheck, label: 'CHECK', cls: 'check' },
    x: { icon: CircleSlash, label: 'EXCLUSION', cls: 'exclusion' }, n: { icon: CircleAlert, label: 'NOT NULL', cls: 'notnull' },
  }
  function constraintMeta(type: string) { return CONSTRAINT_META[type as keyof typeof CONSTRAINT_META] ?? { icon: CircleAlert, label: type, cls: 'notnull' } }
  function tableTooltip(t: TableInfo) {
    const base = 'Click to expand/collapse · double-click to open DDL'
    return t.isPartition ? `Partition of ${t.parents} · ${base}` : t.parents ? `Inherits: ${t.parents} · ${base}`
      : t.isPartitioned ? `Partitioned table · ${base}` : base
  }
  function tableBadge(t: TableInfo) { return t.isPartition || t.parents ? CornerDownRight : t.isPartitioned ? Grid2x2 : null }
  type TableCategory = 'cols' | 'idx' | 'con' | 'trg'
  function tableOpen(t: TableInfo) { return expanded.has(`t-${t.oid}`) || autoExpandRel(t.name, t.schema, t.columns) }
  function catOpen(t: TableInfo, cat: TableCategory) { return expanded.has(`t-${t.oid}-${cat}`) || (cat === 'cols' && autoExpandRel(t.name, t.schema, t.columns)) }
  const categories = [
    { key: 'cols', name: 'Columns', icon: Columns3 }, { key: 'idx', name: 'Indexes', icon: ListTree },
    { key: 'con', name: 'Constraints', icon: KeyRound }, { key: 'trg', name: 'Triggers', icon: Zap },
  ] as const
  function categoryCount(t: TableInfo, cat: TableCategory) {
    return cat === 'cols' ? t.columns.length : cat === 'idx' ? t.indexes.length : cat === 'con' ? t.constraints.length : t.triggers.length
  }

  let previousId: string | null = null
  let appliedLabel = ''
  // Do not track tree state here: only connection/schema changes may reset or
  // restore it. OIDs and request tokens belong to a single database.
  $effect(() => {
    const { id, data, label } = snapshot.current
    untrack(() => {
      if (id !== previousId) {
        expanded.clear()
        for (const groups of [expandedTableGroups, expandedViewGroups, expandedFunctionGroups, expandedTypeGroups, expandedSequenceGroups]) groups.clear()
        window.clearTimeout(clickTimer)
        pendingToggle = null
        appliedLabel = ''
        tableEditTarget = null
        previousId = id
      }
      if (!id || !data || appliedLabel === label) return
      appliedLabel = label
      const saved = settings.browserStateFor(label)
      if (!saved) return
      Object.assign(open, saved.sections)
      for (const key of saved.expanded) expanded.add(key)
      for (const [section, groups] of [
        ['tables', expandedTableGroups], ['views', expandedViewGroups], ['functions', expandedFunctionGroups],
        ['types', expandedTypeGroups], ['sequences', expandedSequenceGroups],
      ] as const) for (const key of saved.groups[section]) groups.add(key)
    })
  })
  let uiSaveTimer = 0
  function flushUiSave() {
    window.clearTimeout(uiSaveTimer)
    if (!conn.state.id) return
    settings.setBrowserState(conn.state.label, {
      sections: { ...open }, expanded: [...expanded], groups: {
        tables: [...expandedTableGroups], views: [...expandedViewGroups], functions: [...expandedFunctionGroups],
        types: [...expandedTypeGroups], sequences: [...expandedSequenceGroups],
      },
    })
  }
  $effect(() => {
    // Read each collection so additions/deletions schedule persistence.
    const state = { ...open, expanded: [...expanded], tables: [...expandedTableGroups], views: [...expandedViewGroups],
      functions: [...expandedFunctionGroups], types: [...expandedTypeGroups], sequences: [...expandedSequenceGroups] }
    void state
    untrack(() => {
      if (!conn.state.id) return
      window.clearTimeout(uiSaveTimer)
      uiSaveTimer = window.setTimeout(flushUiSave, 400)
    })
  })
  onDestroy(() => { window.clearTimeout(uiSaveTimer); window.clearTimeout(clickTimer) })
  function openObject(type: DdlObjectType, schemaName: string, name: string, oid?: string, identitySuffix = '', parent?: string) {
    cancelPendingToggle()
    void openObjectDdl(type, schemaName, name, oid, identitySuffix, parent)
  }
  async function refresh() { if (conn.state.id) await schema.load(conn.state.id) }
</script>

<svelte:window onclick={closeContextMenus} onkeydown={onGlobalKeydown} onpagehide={flushUiSave} />

<!-- The tree retains its pointer interaction contracts during migration.
     Keyboard controls and ARIA can be improved separately without changing layout. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_element_interactions -->
<div class="browser" data-component="svelte-object-browser">
  <!-- Folders nest to any depth: each level adds one aria-level and one indent. -->
  {#snippet entryTree(entries: BrowserEntry[], depth: number, groups: Set<string>, section: BrowserSection)}
    {@const meta = SECTION_META[section]}
    {#each entries as entry (entry.key)}
      {#if entry.kind === 'group'}
        {@const isOpen = objectGroupOpen(entry, groups)}
        <div class="node object-group-node" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-toggle aria-level={depth + 2} aria-expanded={isOpen} title={`${displayName(entry.schema, entry.name)} · ${entry.objects.length} ${meta.noun}`}
          onclick={() => { if (!isFiltering) toggleObjectGroup(entry.key, groups) }}
          oncontextmenu={(event) => openNodeMenu(event, browserNode(meta.groupType, entry.key, entry.objects.map((o) => `${meta.keyPrefix}-${o.oid}`), groups), false)}>
          <span class="caret" class:open={isOpen}>{#if !isFiltering}<ChevronRight size={12} />{/if}</span>
          <span class="obj-icon">{#if isOpen}<FolderOpen size={14} />{:else}<Folder size={14} />{/if}</span>
          <span class="obj-name">{@html highlightIn(displayName(entry.schema, entry.name), meta.scope)}</span><span class="node-badges"></span><span class="count">{entry.objects.length}</span>
        </div>
        {#if isOpen}
          <div class="object-entry-children object-group-children">{@render entryTree(entry.children, depth + 1, groups, section)}</div>
        {/if}
      {:else}
        {@const object = entry.objects[0]}
        {#if section === 'tables'}{@render tableRow(object as TableInfo, depth + 2)}
        {:else if section === 'views'}{@render viewRow(object as ViewInfo, depth + 2)}
        {:else if section === 'types'}{@render typeRow(object as TypeInfo, depth + 2)}
        {:else if section === 'functions'}{@render functionRow(object as FunctionInfo, depth + 2)}
        {:else}{@render sequenceRow(object as SequenceInfo, depth + 2)}{/if}
      {/if}
    {/each}
  {/snippet}

  {#snippet tableRow(t: TableInfo, level: number)}
    <div class="tree">
      <div class="node" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level} aria-expanded={tableOpen(t)} title={tableTooltip(t)} onclick={(event) => queueToggle(event, `t-${t.oid}`)}
        ondblclick={() => openObject('table', t.schema, t.name, t.oid)} oncontextmenu={(event) => openNodeMenu(event, browserNode('table', `t-${t.oid}`))}>
        <span class="caret" data-toggle class:open={tableOpen(t)} title="Expand" ondblclick={(event) => event.stopPropagation()}
          onclick={(event) => { event.stopPropagation(); toggleChildren(`t-${t.oid}`) }}><ChevronRight size={12} /></span>
        <span class="obj-icon"><Table2 size={14} />{#if tableBadge(t)}{@const Badge = tableBadge(t)!}<Badge class={`obj-badge ${t.isPartition || t.parents ? 'child' : 'parent'}`} size={12} />{/if}</span>
        <span class="obj-name">{@html highlightIn(displayName(t.schema, t.name), 'table')}</span><span class="node-badges">{#if isTbd(t.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
      </div>
      {#if tableOpen(t)}
        {#each categories as category (category.key)}
          <div class="node cat" data-nav role="treeitem" aria-selected="false" tabindex="-1" aria-level={level + 1} aria-expanded={catOpen(t, category.key)} onclick={() => toggleChildren(`t-${t.oid}-${category.key}`)} oncontextmenu={(event) => openNodeMenu(event, browserNode('table-category', `t-${t.oid}-${category.key}`))}>
            <span class="caret" data-toggle class:open={catOpen(t, category.key)} ondblclick={(event) => event.stopPropagation()}
              onclick={(event) => { event.stopPropagation(); toggleChildren(`t-${t.oid}-${category.key}`) }}><ChevronRight size={11} /></span>
            <span class="obj-icon"><category.icon size={13} /></span><span class="obj-name">{category.name}</span><span class="node-badges"></span><span class="count">{categoryCount(t, category.key)}</span>
          </div>
          {#if catOpen(t, category.key)}
            {#if category.key === 'cols'}
              {#each t.columns as c (c.name)}
                <div class="node cat-child typed-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" aria-level={level + 2} title={`${c.name} · ${c.type}`} oncontextmenu={(event) => openNodeMenu(event, browserNode('table-column', `t-${t.oid}-cols-${c.name}`, []), false)}>
                  <span class="obj-name">{@html highlightIn(c.name, 'column')}</span><span class="node-badges">{#if isTbd(c.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span><span class="dim">{c.type}</span>
                </div>
              {/each}
            {:else if category.key === 'idx'}
              {#each t.indexes as ix (ix.name)}
                {@const Icon = INDEX_ICONS[ix.type]}
                <div class="node cat-child typed-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level + 2} title={`${ix.type} index · ${ix.method} · double-click to open DDL`} ondblclick={() => openObject('index', t.schema, ix.name, undefined, '', t.name)}
                  oncontextmenu={(event) => openNodeMenu(event, browserNode('table-index', `t-${t.oid}-idx-${ix.name}`, []), false)}>
                  <span class={`idx-icon ${ix.type}`}><Icon size={13} /></span><span class="obj-name">{@html highlightText(ix.name)}</span><span class="node-badges">{#if isTbd(ix.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span><span class="dim">{ix.method}</span>
                </div>
              {/each}
            {:else if category.key === 'con'}
              {#each t.constraints as con (con.name)}
                {@const meta = constraintMeta(con.type)}
                <div class="node cat-child" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level + 2} title={`${meta.label}: ${con.definition} · double-click to open DDL`} ondblclick={() => openObject('constraint', t.schema, con.name, undefined, '', t.name)}
                  oncontextmenu={(event) => openNodeMenu(event, browserNode('table-constraint', `t-${t.oid}-con-${con.name}`, []), false)}>
                  <span class={`con-icon ${meta.cls}`}><meta.icon size={13} /></span><span class="obj-name">{@html highlightText(con.name)}</span><span class="node-badges">{#if isTbd(con.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
                </div>
              {/each}
            {:else}
              {#each t.triggers as trg (trg.name)}
                <div class="node cat-child" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level + 2} title="Double-click to open DDL" ondblclick={() => openObject('trigger', t.schema, trg.name, undefined, '', t.name)}
                  oncontextmenu={(event) => openNodeMenu(event, browserNode('table-trigger', `t-${t.oid}-trg-${trg.name}`, []), false)}>
                  <span class="obj-name">{@html highlightText(trg.name)}</span><span class="node-badges">{#if isTbd(trg.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
                </div>
              {/each}
            {/if}
            {#if !categoryCount(t, category.key)}<div class="empty">None</div>{/if}
          {/if}
        {/each}
      {/if}
    </div>
  {/snippet}

  {#snippet viewRow(v: ViewInfo, level: number)}
    <div class="tree">
      <div class="node" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level} aria-expanded={expanded.has(`v-${v.oid}`) || autoExpandRel(v.name, v.schema, v.columns)} title="Click to expand/collapse · double-click to open DDL" onclick={(event) => queueToggle(event, `v-${v.oid}`)} ondblclick={() => openObject('view', v.schema, v.name, v.oid)} oncontextmenu={(event) => openNodeMenu(event, browserNode('view', `v-${v.oid}`))}>
        <span class="caret" class:open={expanded.has(`v-${v.oid}`) || autoExpandRel(v.name, v.schema, v.columns)} data-toggle title="Toggle columns" ondblclick={(event) => event.stopPropagation()} onclick={(event) => { event.stopPropagation(); toggleChildren(`v-${v.oid}`) }}><ChevronRight size={12} /></span>
        <span class="obj-icon"><Eye size={14} /></span><span class="obj-name">{@html highlightIn(displayName(v.schema, v.name), 'view')}</span><span class="node-badges">{#if v.materialized}<span class="void-badge">mat</span>{/if}{#if isTbd(v.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
      </div>
      {#if expanded.has(`v-${v.oid}`) || autoExpandRel(v.name, v.schema, v.columns)}
        {#each v.columns as c (c.name)}
          <div class="node child typed-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" aria-level={level + 1} title={`${c.name} · ${c.type}`} oncontextmenu={(event) => openNodeMenu(event, browserNode('view-column', `v-${v.oid}-${c.name}`, []), false)}><span class="obj-name">{@html highlightIn(c.name, 'column')}</span><span class="node-badges"></span><span class="dim">{c.type}</span></div>
        {/each}
      {/if}
    </div>
  {/snippet}

  {#snippet typeRow(t: TypeInfo, level: number)}
    <div class="tree">
      <div class="node" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level} aria-expanded={expanded.has(`ty-${t.oid}`)} title={`${t.kind} · ${t.detail} · Click to expand/collapse · double-click to open DDL`} onclick={(event) => queueToggle(event, `ty-${t.oid}`)} ondblclick={() => openObject('type', t.schema, t.name, t.oid)} oncontextmenu={(event) => openNodeMenu(event, browserNode('type', `ty-${t.oid}`))}>
        <span class="caret" class:open={expanded.has(`ty-${t.oid}`)} data-toggle title="Toggle detail" ondblclick={(event) => event.stopPropagation()} onclick={(event) => { event.stopPropagation(); toggleChildren(`ty-${t.oid}`) }}><ChevronRight size={12} /></span>
        <span class="obj-icon"><Shapes size={14} /></span><span class="obj-name">{@html highlightIn(displayName(t.schema, t.name), 'type')}</span><span class="node-badges"><span class="void-badge">{t.kind}</span>{#if isTbd(t.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
      </div>
      {#if expanded.has(`ty-${t.oid}`)}<div class="node child" data-nav role="treeitem" aria-selected="false" tabindex="-1" aria-level={level + 1} title={t.detail} oncontextmenu={(event) => openNodeMenu(event, browserNode('type-detail', `ty-${t.oid}-detail`, []), false)}><span class="obj-name">{@html highlightText(t.detail || '—')}</span><span class="node-badges"></span></div>{/if}
    </div>
  {/snippet}

  {#snippet functionRow(f: FunctionInfo, level: number)}
    {@const Icon = functionIcon(f.kind)}
    <div class="tree">
      <div class="node" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level} aria-expanded={expanded.has(`f-${f.oid}`) || autoExpandFunc(f.name, f.schema, f.args)} title={`${FUNCTION_LABELS[(f.kind ?? 'function') as FunctionKind] ?? 'function'} · args: (${f.args}) · returns: ${f.returns} · Click to expand/collapse · double-click to open DDL`}
        onclick={(event) => queueToggle(event, `f-${f.oid}`)} ondblclick={() => openObject('function', f.schema, f.name, f.oid, f.typeSig ? `(${f.typeSig})` : '')} oncontextmenu={(event) => openNodeMenu(event, browserNode('function', `f-${f.oid}`))}>
        <span class="caret" class:open={expanded.has(`f-${f.oid}`) || autoExpandFunc(f.name, f.schema, f.args)} data-toggle title="Toggle signature" ondblclick={(event) => event.stopPropagation()} onclick={(event) => { event.stopPropagation(); toggleChildren(`f-${f.oid}`) }}><ChevronRight size={12} /></span>
        <span class="obj-icon"><Icon size={14} /></span><span class="obj-name">{@html highlightIn(displayName(f.schema, f.name), 'function')}</span><span class="node-badges">{#if f.returns === 'void'}<span class="void-badge">void</span>{/if}{#if (overloadCounts.get(`${f.schema}.${f.name}`) ?? 0) > 1}<span class="void-badge overload-badge">overload</span>{/if}{#if isTbd(f.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
      </div>
      {#if expanded.has(`f-${f.oid}`) || autoExpandFunc(f.name, f.schema, f.args)}
        {#each paramRows(f.args, f.returns) as p, i (i)}
          {@const ParamIcon = PARAM_ICONS[p.kind]}
          <div class="node child typed-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" aria-level={level + 1} title={p.rest ? `${p.name} ${p.rest}` : p.name} oncontextmenu={(event) => openNodeMenu(event, browserNode('function-parameter', `f-${f.oid}-param-${i}`), false)}><span class={`param-icon ${p.kind}`}><ParamIcon size={14} /></span><span class="obj-name">{@html highlightIn(p.name, 'parameter')}</span><span class="node-badges"></span>{#if p.rest}<span class="dim">{p.rest}</span>{/if}</div>
        {/each}
      {/if}
    </div>
  {/snippet}

  {#snippet sequenceRow(s: SequenceInfo, level: number)}
    <div class="tree">
      <div class="node" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-open aria-level={level} aria-expanded={expanded.has(`s-${s.oid}`)} title={`${s.dataType} · ${s.detail} · Click to expand/collapse · double-click to open DDL`} onclick={(event) => queueToggle(event, `s-${s.oid}`)} ondblclick={() => openObject('sequence', s.schema, s.name, s.oid)} oncontextmenu={(event) => openNodeMenu(event, browserNode('sequence', `s-${s.oid}`))}>
        <span class="caret" class:open={expanded.has(`s-${s.oid}`)} data-toggle title="Toggle detail" ondblclick={(event) => event.stopPropagation()} onclick={(event) => { event.stopPropagation(); toggleChildren(`s-${s.oid}`) }}><ChevronRight size={12} /></span>
        <span class="obj-icon"><Hash size={14} /></span><span class="obj-name">{@html highlightIn(displayName(s.schema, s.name), 'sequence')}</span><span class="node-badges"><span class="void-badge">{s.dataType}</span>{#if s.detail.includes('owned by')}<span class="void-badge">owned</span>{/if}{#if isTbd(s.name)}<span class="void-badge tbd-badge">tbd</span>{/if}</span>
      </div>
      {#if expanded.has(`s-${s.oid}`)}<div class="node child" data-nav role="treeitem" aria-selected="false" tabindex="-1" aria-level={level + 1} title={s.detail} oncontextmenu={(event) => openNodeMenu(event, browserNode('sequence-detail', `s-${s.oid}-detail`, []), false)}><span class="obj-name">{@html highlightText(s.detail || '—')}</span><span class="node-badges"></span></div>{/if}
    </div>
  {/snippet}
  <div class="browser-main">
    {#if !snapshot.current.id}
      <div class="browser-empty">Not connected.<br />Click the connection badge in the top bar.</div>
    {:else}
      <div class="browser-search">
        <input bind:value={filterInput} placeholder='Search… "employee labor" any, "employee+labor" all, "id col"' aria-label="Search objects"
          onkeydown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); treeElement?.querySelector<HTMLElement>('[data-nav]')?.focus() } }} />
        {#if filterInput}<button class="icon" title="Clear search" aria-label="Clear search" onclick={() => { filterInput = '' }}><X size={14} /></button>{/if}
        <button class="icon" disabled={!snapshot.current.id || snapshot.current.loading} title="Refresh schema" aria-label="Refresh schema" onclick={refresh}>
          {#if snapshot.current.loading}<LoaderCircle size={14} class="spin" />{:else}<RotateCw size={14} />{/if}
        </button>
      </div>
      {#if snapshot.current.error}<div class="browser-error">{snapshot.current.error}</div>{/if}
      <div class="browser-tree" role="tree" aria-label="Database objects" bind:this={treeElement} use:treeNav>
      {#if showTables}
        <section class="group">
          <h3 onclick={() => { open.tables = !open.tables }} oncontextmenu={(event) => openNodeMenu(event, sectionNode('tables'))}><span class="section-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-toggle aria-level="1" aria-expanded={open.tables || isFiltering}>{#if open.tables || isFiltering}<ChevronDown class="arrow" size={11} />{:else}<ChevronRight class="arrow" size={11} />{/if}
            Tables <span class="count">{isFiltering ? `${filteredTables.length}/${tables.length}` : tables.length}</span></span></h3>
          {#if open.tables || isFiltering}
            {@render entryTree(tableEntries.slice(0, tableCount), 0, expandedTableGroups, 'tables')}
            {#if tableCount < tableEntries.length}<button class="show-more" data-nav tabindex="-1" onclick={() => { shown.tables += PAGE }}>Show more · {tableEntries.length - tableCount} more {tableEntries.length - tableCount === 1 ? 'entry' : 'entries'}</button>{/if}
            {#if !filteredTables.length}<div class="empty">No tables</div>{/if}
          {/if}
        </section>
      {/if}
      {#if showViews}
        <section class="group">
          <h3 onclick={() => { open.views = !open.views }} oncontextmenu={(event) => openNodeMenu(event, sectionNode('views'))}><span class="section-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-toggle aria-level="1" aria-expanded={open.views || isFiltering}>{#if open.views || isFiltering}<ChevronDown class="arrow" size={11} />{:else}<ChevronRight class="arrow" size={11} />{/if} Views <span class="count">{isFiltering ? `${filteredViews.length}/${views.length}` : views.length}</span></span></h3>
          {#if open.views || isFiltering}
            {@render entryTree(viewEntries.slice(0, viewCount), 0, expandedViewGroups, 'views')}
            {#if viewCount < viewEntries.length}<button class="show-more" data-nav tabindex="-1" onclick={() => { shown.views += PAGE }}>Show more · {viewEntries.length - viewCount} more {viewEntries.length - viewCount === 1 ? 'entry' : 'entries'}</button>{/if}
            {#if !filteredViews.length}<div class="empty">No views</div>{/if}
          {/if}
        </section>
      {/if}
      {#if showTypes}
        <section class="group">
          <h3 onclick={() => { open.types = !open.types }} oncontextmenu={(event) => openNodeMenu(event, sectionNode('types'))}><span class="section-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-toggle aria-level="1" aria-expanded={open.types || isFiltering}>{#if open.types || isFiltering}<ChevronDown class="arrow" size={11} />{:else}<ChevronRight class="arrow" size={11} />{/if} Types <span class="count">{isFiltering ? `${filteredTypes.length}/${types.length}` : types.length}</span></span></h3>
          {#if open.types || isFiltering}
            {@render entryTree(typeEntries.slice(0, typeCount), 0, expandedTypeGroups, 'types')}
            {#if typeCount < typeEntries.length}<button class="show-more" data-nav tabindex="-1" onclick={() => { shown.types += PAGE }}>Show more · {typeEntries.length - typeCount} more {typeEntries.length - typeCount === 1 ? 'entry' : 'entries'}</button>{/if}
            {#if !filteredTypes.length}<div class="empty">No types</div>{/if}
          {/if}
        </section>
      {/if}
      {#if showFunctions}
        <section class="group">
          <h3 onclick={() => { open.functions = !open.functions }} oncontextmenu={(event) => openNodeMenu(event, sectionNode('functions'))}><span class="section-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-toggle aria-level="1" aria-expanded={open.functions || isFiltering}>{#if open.functions || isFiltering}<ChevronDown class="arrow" size={11} />{:else}<ChevronRight class="arrow" size={11} />{/if} Functions <span class="count">{isFiltering ? `${filteredFunctions.length}/${functions.length}` : functions.length}</span></span></h3>
          {#if open.functions || isFiltering}
            {@render entryTree(functionEntries.slice(0, functionCount), 0, expandedFunctionGroups, 'functions')}
            {#if functionCount < functionEntries.length}<button class="show-more" data-nav tabindex="-1" onclick={() => { shown.functions += PAGE }}>Show more · {functionEntries.length - functionCount} more {functionEntries.length - functionCount === 1 ? 'entry' : 'entries'}</button>{/if}
            {#if !filteredFunctions.length}<div class="empty">No functions</div>{/if}
          {/if}
        </section>
      {/if}
      {#if showSequences}
        <section class="group">
          <h3 onclick={() => { open.sequences = !open.sequences }} oncontextmenu={(event) => openNodeMenu(event, sectionNode('sequences'))}><span class="section-row" data-nav role="treeitem" aria-selected="false" tabindex="-1" data-toggle aria-level="1" aria-expanded={open.sequences || isFiltering}>{#if open.sequences || isFiltering}<ChevronDown class="arrow" size={11} />{:else}<ChevronRight class="arrow" size={11} />{/if} Sequences <span class="count">{isFiltering ? `${filteredSequences.length}/${sequences.length}` : sequences.length}</span></span></h3>
          {#if open.sequences || isFiltering}
            {@render entryTree(sequenceEntries.slice(0, sequenceCount), 0, expandedSequenceGroups, 'sequences')}
            {#if sequenceCount < sequenceEntries.length}<button class="show-more" data-nav tabindex="-1" onclick={() => { shown.sequences += PAGE }}>Show more · {sequenceEntries.length - sequenceCount} more {sequenceEntries.length - sequenceCount === 1 ? 'entry' : 'entries'}</button>{/if}
            {#if !filteredSequences.length}<div class="empty">No sequences</div>{/if}
          {/if}
        </section>
      {/if}
      {#if isFiltering && !totalMatches}<div class="empty no-match">No objects match “{filter}”</div>{/if}
      </div>
      {#if contextMenu}
        <div class="browser-node-menu" style:left={`${contextMenu.x}px`} style:top={`${contextMenu.y}px`} onclick={(event) => event.stopPropagation()} onkeydown={menuKeydown}>
          {#if contextCanEdit}<button onclick={editContextTable}><Pencil size={14} /> Edit…</button>{/if}
          {#if contextCanCollapse}<button onclick={collapseContextNode}><ChevronsUp size={14} /> Collapse</button>{/if}
        </div>
      {/if}
    {/if}
  </div>
  {#if tableEditTarget}<TableEditDialog target={tableEditTarget} onclose={() => { tableEditTarget = null }} />{/if}
  <section class="pinned-files">
    <h3><Pin size={13} /> Pinned files <span class="count">{snapshot.current.pinnedFiles.length}</span></h3>
    <div role="tree" aria-label="Pinned files" use:treeNav>
    {#each snapshot.current.pinnedFiles as pin (pin.id)}
      <div class="pinned-file" data-nav data-open role="treeitem" aria-selected="false" aria-level="1" tabindex="-1" title={`${pin.fileName} · double-click to focus an unchanged tab or open a new one`} ondblclick={() => openPinnedFile(pin.id)} oncontextmenu={(event) => openPinnedMenu(event, pin.id)}><span class="obj-icon"><FileText size={14} /></span><span class="obj-name">{pin.fileName}</span></div>
    {/each}
    </div>
  </section>
  {#if pinnedContextMenu}
    <div class="browser-node-menu pinned-menu" style:left={`${pinnedContextMenu.x}px`} style:top={`${pinnedContextMenu.y}px`} onclick={(event) => event.stopPropagation()} onkeydown={menuKeydown}><button onclick={unpinContextFile}><PinOff size={14} /> Unpin</button></div>
  {/if}
</div>
