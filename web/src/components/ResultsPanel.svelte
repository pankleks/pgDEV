<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { Copy, Download, Pencil, Play, Square } from '@lucide/svelte'
  import { useResults, type GridResult } from '../composables/results'
  import { useConnection } from '../composables/connection'
  import { useTabs } from '../composables/tabs'
  import { useToast } from '../composables/toast'
  import { copyGrid, copyText, csvHeader, csvRows, formatCellForDisplay } from '../lib/gridio'
  import { createOutput } from '../lib/files'
  import { stateView } from '../lib/state.svelte'
  import type { CellValueTarget } from '../lib/valueTarget'
  import type { RowEditTarget } from '../lib/rowEditTarget'
  import ValueDialog from './ValueDialog.svelte'
  import RowEditDialog from './RowEditDialog.svelte'

  let { onrun }: { onrun: () => void } = $props()
  const results = useResults()
  const conn = useConnection()
  const tabs = useTabs()
  const toast = useToast()
  // Snapshot metadata, not every retained row. The results store owns the
  // cursor/transaction state; only the visible row window is copied for Svelte.
  function displayGrid(grid: GridResult) {
    return { ...grid, rowLength: grid.rows.length, exported: grid.exported ? { ...grid.exported } : undefined }
  }
  const snapshot = stateView(() => {
    const result = results.state.byTab[tabs.state.activeKey]
    return {
      activeKey: tabs.state.activeKey, connectionId: conn.state.id,
      readOnly: tabs.state.tabs.find((tab) => tab.key === tabs.state.activeKey)?.readOnly,
      tabKeys: tabs.state.tabs.map((tab) => tab.key),
      gridKeys: Object.values(results.state.byTab).flatMap((result) => result.grids.map((grid) => grid.key)),
      result: result ? {
        ...result, grids: result.grids.map(displayGrid), grid: result.grid ? displayGrid(result.grid) : null,
        messages: result.messages.map((message) => ({ ...message })),
      } : null,
    }
  })
  const result = $derived(snapshot.current.result)
  const activeGrid = $derived(result && !result.showMessages ? result.grid : null)
  const activeGridKey = $derived(activeGrid?.key ?? '')
  const gridColumns = $derived(activeGrid?.columns)
  const rowEditable = $derived(!!activeGrid?.editable && snapshot.current.readOnly !== true)
  function showMessagesView() {
    const current = results.state.byTab[tabs.state.activeKey]
    if (current) current.showMessages = true
  }
  const ROW_H = 24
  const HEADER_H = 24
  const COL_W = 180
  const ACTION_W = 30
  let bodyEl = $state<HTMLElement | null>(null)
  let scrollTop = $state(0)
  let bodyH = $state(300)
  const widthsByKey = new SvelteMap<string, number[]>()
  const columnsByKey = new Map<string, string[]>()
  let dragCol = -1
  let dragStartX = 0
  let dragStartW = 0
  function colWidth(index: number) { return widthsByKey.get(activeGridKey)?.[index] ?? COL_W }
  function ensureWidths(key: string, columns: string[]) {
    const widths = widthsByKey.get(key)
    const previous = columnsByKey.get(key)
    if (!widths || !previous || widths.length !== columns.length || previous.length !== columns.length || !previous.every((column, index) => column === columns[index])) {
      widthsByKey.set(key, Array.from({ length: columns.length }, () => COL_W))
      columnsByKey.set(key, [...columns])
    }
  }
  const innerWidth = $derived(activeGrid ? activeGrid.columns.reduce((sum, _column, index) => sum + colWidth(index), 0) + (rowEditable ? ACTION_W : 0) : 0)
  function startResize(index: number, event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    dragCol = index
    dragStartX = event.clientX
    dragStartW = colWidth(index)
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', endResize)
  }
  function onResizeMove(event: MouseEvent) {
    if (dragCol < 0) return
    const widths = widthsByKey.get(activeGridKey)
    if (!widths) return
    const next = [...widths]
    next[dragCol] = Math.max(60, Math.min(1200, dragStartW + event.clientX - dragStartX))
    widthsByKey.set(activeGridKey, next)
  }
  function endResize() {
    dragCol = -1
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', endResize)
  }
  $effect(() => {
    const element = bodyEl
    if (!element) return
    bodyH = element.clientHeight
    const observer = new ResizeObserver((entries) => { bodyH = entries[0]?.contentRect.height ?? 300 })
    observer.observe(element)
    return () => observer.disconnect()
  })
  $effect(() => {
    const key = activeGridKey
    const columns = gridColumns
    untrack(() => {
      endResize()
      scrollTop = 0
      if (bodyEl) bodyEl.scrollTop = 0
      if (key && columns) ensureWidths(key, columns)
    })
  })
  $effect(() => {
    const keys = snapshot.current.tabKeys
    untrack(() => {
      const live = new Set(keys)
      for (const key of Object.keys(results.state.byTab)) if (!live.has(key)) results.drop(key)
    })
  })
  $effect(() => {
    const keys = snapshot.current.gridKeys
    untrack(() => {
      const live = new Set(keys)
      for (const key of widthsByKey.keys()) if (!live.has(key)) { widthsByKey.delete(key); columnsByKey.delete(key) }
    })
  })
  onDestroy(endResize)
  let rowRevision = $state(0)
  const grid = $derived.by(() => {
    const current = activeGrid
    if (!current) return null
    void rowRevision
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5)
    const visible = Math.ceil(bodyH / ROW_H) + 10
    return { g: current, start, rows: current.rows.slice(start, start + visible).map((row) => [...row]) }
  })
  let cellValue = $state<CellValueTarget | null>(null)
  let rowEdit = $state.raw<RowEditTarget | null>(null)
  function rowKeyComplete(row: unknown[]) {
    if (!rowEditable || !activeGrid?.editable) return false
    for (const key of activeGrid.editable.pk) {
      const index = activeGrid.columns.indexOf(key)
      if (index < 0 || row[index] === null || row[index] === undefined) return false
    }
    return true
  }
  function openRowEdit(index: number) {
    const current = results.state.byTab[tabs.state.activeKey]
    const grid = current?.grid
    if (!rowEditable || !grid?.editable || !conn.state.id || !grid.rows[index]) return
    rowEdit = { grid, row: grid.rows[index], connectionId: conn.state.id, tabKey: tabs.state.activeKey, transactionId: current.transactionId ?? null }
  }
  function onRowSaved(row: Record<string, unknown>) {
    if (!rowEdit) return
    for (let index = 0; index < rowEdit.grid.columns.length; index++) {
      const name = rowEdit.grid.columns[index] ?? ''
      if (Object.prototype.hasOwnProperty.call(row, name)) rowEdit.row[index] = row[name]
    }
    rowRevision++
  }
  function isJsonColumn(index: number) { return activeGrid?.columnTypes[index] === 'json' || activeGrid?.columnTypes[index] === 'jsonb' }
  function openCell(value: unknown, index: number) {
    if (value === null || value === undefined || !activeGrid) return
    if (isJsonColumn(index)) {
      cellValue = { column: activeGrid.columns[index] ?? '', type: activeGrid.columnTypes[index], value: typeof value === 'string' ? value : String(value) }
    } else void copyCell(value)
  }
  async function copyCell(value: unknown) {
    const ok = await copyText(typeof value === 'string' ? value : String(value))
    toast.show(ok ? 'Value copied.' : 'Copy to clipboard failed')
  }
  function cancelRun() {
    if (!conn.state.id || (!result?.running && !result?.loadingMore)) return
    void results.cancel(tabs.state.activeKey, conn.state.id)
    toast.show(result.loadingMore ? 'Canceling row load…' : 'Canceling query…')
  }
  function loadMoreRows() {
    if (conn.state.id && result?.grid?.truncated) void results.loadMore(tabs.state.activeKey, conn.state.id)
  }
  function runControl(sql: 'COMMIT' | 'ROLLBACK') {
    if (!conn.state.id || result?.running || result?.loadingMore) return
    void results.run(tabs.state.activeKey, conn.state.id, sql)
  }
  async function copyResult() {
    if (!activeGrid) return
    const current = activeGrid
    const ok = await copyGrid(current.columns, current.rows)
    toast.show(ok ? `Copied ${current.rows.length} row(s) to clipboard` : 'Copy to clipboard failed')
  }
  async function exportCsv() {
    const connectionId = conn.state.id
    if (!connectionId) return
    const tabKey = tabs.state.activeKey
    // Export the owning store's captured grid, never the display snapshot.
    const current = results.state.byTab[tabKey]?.grid
    if (!current) return
    const priorExport = current.exported
    if (priorExport?.incomplete) { toast.show('Export interrupted — re-run the query to export again'); return }
    if (priorExport) { toast.show('Already exported — re-run the query to export again'); return }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const filename = `pgDEV-statement-${current.statementNumber}-${stamp}${current.limited ? '-partial' : ''}.csv`
    let output
    try { output = await createOutput(filename, undefined, true) }
    catch (cause) { if ((cause as Error).name !== 'AbortError') toast.show(`Export failed: ${(cause as Error).message}`); return }
    if (!output) return
    const writable = output.writable
    let rows = 0
    try {
      await writable.write(csvHeader(current.columns))
      const complete = await results.exportAll(tabKey, connectionId, current, async (page) => {
        rows += page.length
        await writable.write(csvRows(page))
      }, false)
      if (!complete) {
        await writable.abort()
        toast.show(current.exported?.incomplete ? 'Export interrupted — re-run the query to export again' : 'Export canceled because the connection or result changed')
        return
      }
      await writable.close()
      toast.show(current.limited ? `Exported first ${rows} of ${current.totalRowCount} rows to CSV (partial result)` : `Exported ${rows} row(s) to CSV`)
    } catch (cause) {
      await writable.abort().catch(() => undefined)
      toast.show(`Export failed: ${(cause as Error).message}`)
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="results" data-component="svelte-results-panel">
  <div class="results-head">
    <div class="subtabs">
      {#each result?.grids ?? [] as current, index (current.key)}
        <button class="subtab" class:active={!result?.showMessages && result?.grid?.key === current.key} aria-pressed={!result?.showMessages && result?.grid?.key === current.key}
          title={`Statement ${current.statementNumber} · ${current.rows.length} loaded row(s)${current.limited ? ' · partial result' : ''}`} onclick={() => results.selectGrid(tabs.state.activeKey, current.key)}>Result {index + 1}</button>
      {/each}
      <button class="subtab" class:active={!result || result.showMessages} onclick={showMessagesView}>Messages</button>
    </div>
    <span class="spacer"></span>
    {#if result?.transactionOpen}
      <span class="txn-badge" title="A manual transaction is open for this tab">TXN</span>
      <button class="btn-sm commit" disabled={result.running || result.loadingMore} title="Commit the open transaction" onclick={() => runControl('COMMIT')}>COMMIT</button>
      <button class="btn-sm danger" disabled={result.running || result.loadingMore} title="Roll back the open transaction" onclick={() => runControl('ROLLBACK')}>ROLLBACK</button>
    {/if}
    {#if activeGrid}
      <button class="btn-sm" title="Copy loaded rows to clipboard (TSV)" disabled={result?.loadingMore} onclick={copyResult}><Copy size={13} /> COPY</button>
      <button class="btn-sm" title={activeGrid.limited ? 'Export only the retained rows to CSV (partial result)' : 'Export all rows to CSV'} disabled={result?.loadingMore} onclick={exportCsv}><Download size={13} /> {activeGrid.limited ? 'CSV (partial)' : 'CSV'}</button>
    {/if}
    {#if result?.running || result?.loadingMore}
      <button class="danger" disabled={result.cancelling} title="Cancel running query or row load" onclick={cancelRun}><Square size={11} /> {result.cancelling ? 'Canceling…' : result.loadingMore ? 'Cancel load' : 'Cancel'}</button>
    {:else}
      <button class="primary run-btn" disabled={!snapshot.current.connectionId || result?.loadingMore || snapshot.current.readOnly} title="Run (F5 or Ctrl+Enter)" onclick={onrun}><Play size={13} /> Run</button>
    {/if}
  </div>
  {#if !result || result.showMessages || !result.grid}
    <div class="messages">
      {#if !result || !result.messages.length}<div class="msg dim">Run a query to see results (F5 or Ctrl+Enter in the editor).</div>{/if}
      {#each result?.messages ?? [] as message, index (index)}<div class={`msg ${message.level}`}>{message.text}</div>{/each}
    </div>
  {:else if grid}
    <div class="grid">
      <div bind:this={bodyEl} class="grid-body" onscroll={() => { if (bodyEl) scrollTop = bodyEl.scrollTop }}>
        <div class="grid-inner" style:width={`${innerWidth}px`}>
          <div class="grid-head">
            {#if rowEditable}<div class="grid-cell head actions" style:width={`${ACTION_W}px`} title="Edit a row in a dialog (needs the full primary key in the result)"></div>{/if}
            {#each grid.g.columns as column, index (`${index}-${column}`)}
              <div class="grid-cell head" style:width={`${colWidth(index)}px`}>
                <span class="col-name">{column}</span>{#if grid.g.columnTypes[index]}<span class="col-type"> ({grid.g.columnTypes[index]})</span>{/if}
                <span class="col-resize-handle" title="Resize column" onmousedown={(event) => startResize(index, event)} onclick={(event) => event.stopPropagation()}></span>
              </div>
            {/each}
          </div>
          <div class="grid-spacer" style:height={`${grid.g.rows.length * ROW_H}px`}></div>
          {#each grid.rows as row, index (grid.start + index)}
            <div class="grid-row" style:top={`${HEADER_H + (grid.start + index) * ROW_H}px`}>
              {#if rowEditable}
                <div class="grid-cell actions" style:width={`${ACTION_W}px`}><button class="icon rowedit-open" title={rowKeyComplete(row) ? 'Edit row' : 'Row key is not available'} disabled={!rowKeyComplete(row)} onclick={() => { if (grid) openRowEdit(grid.start + index) }}><Pencil size={12} /></button></div>
              {/if}
              {#each row as cell, column (column)}
                <div class="grid-cell" class:nul={cell === null || cell === undefined} style:width={`${colWidth(column)}px`} title={isJsonColumn(column) ? 'Double-click to open value' : 'Double-click to copy'} ondblclick={() => openCell(cell, column)}>
                  {#if cell === null || cell === undefined}<span class="null-badge">null</span>
                  {:else if grid.g.columnTypes[column] === 'boolean'}<span class={`bool-badge ${cell === true || cell === 'true' ? 'true' : 'false'}`}>{cell === true || cell === 'true' ? 'true' : 'false'}</span>
                  {:else}{formatCellForDisplay(cell)}{/if}
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>
      <div class="grid-foot">
        {result.grid?.rowCount ?? 0} row(s)
        {#if grid.g.truncated}<span>· more available</span>
        {:else if grid.g.limited}<span>· first {grid.g.rows.length}{#if grid.g.totalRowCount} of {grid.g.totalRowCount}{/if} · row limit reached; remaining rows were not retained</span>
        {:else if grid.g.exported?.incomplete}<span>· export interrupted — re-run the query</span>
        {:else if grid.g.exported}<span>· first {grid.g.rows.length} shown · {grid.g.exported.rows} row(s) exported to CSV</span>{/if}
        {#if grid.g.truncated}<button class="btn-sm" disabled={result.loadingMore} title="Fetch the next page of rows" onclick={loadMoreRows}>{result.loadingMore ? 'Loading…' : 'Load more'}</button>{/if}
      </div>
    </div>
  {/if}
  {#if cellValue}<ValueDialog target={cellValue} onclose={() => { cellValue = null }} />{/if}
  {#if rowEdit}<RowEditDialog target={rowEdit} onsaved={onRowSaved} onclose={() => { rowEdit = null }} />{/if}
</div>
