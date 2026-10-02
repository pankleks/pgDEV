import type { api, Connected } from '../api'
import type { QueryWorkspace } from './queryWorkspace'
import { csvHeader, csvRows } from '../../../web/src/lib/gridio'
import { appendNoticeOutput, errorNotices } from './notices'
import { errorMessage } from './errors'
import { sanitizeSettings } from './settings'

/** Bound IPC chunks and avoid splitting UTF-16 surrogate pairs. CSV escaping,
 * BOM and spreadsheet-formula neutralization are shared with the old UI. */
export function* csvChunks(columns: string[] | null, rows: unknown[][]): Generator<string> {
  const limit = 64 * 1024
  let buffer = columns ? csvHeader(columns) : ''
  function* drain() {
    while (buffer.length >= limit) {
      let end = limit
      const last = buffer.charCodeAt(end - 1), next = buffer.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) --end
      yield buffer.slice(0, end)
      buffer = buffer.slice(end)
    }
  }
  yield* drain()
  for (const row of rows) { buffer += csvRows([row]); yield* drain() }
  if (buffer) yield buffer
}

type ExportApi = Pick<typeof api, 'startCsvExport' | 'appendCsvExport' | 'finishCsvExport' | 'abortCsvExport' | 'fetchMore' | 'cancel'>
export function createExportController(workspace: QueryWorkspace, transport: ExportApi, getConnection: () => Connected | null, getMaxRows = () => 500, disabled = () => false) {
  const pending = new Map<string, { fetching: boolean; cancel: Promise<void> }>()
  async function cancel(key: string) {
    const tab = workspace.tabs.find(tab => tab.key === key), state = pending.get(key), connection = getConnection()
    if (!tab?.exporting || !state || tab.exportCancelRequested) return
    tab.exportCancelRequested = true
    if (state.fetching && connection) {
      state.cancel = transport.cancel(connection.id, key).catch(error => { tab.message = errorMessage(error) })
      await state.cancel
    }
  }
  async function exportCsv(key: string, index: number): Promise<boolean> {
    const tab = workspace.tabs.find(tab => tab.key === key), connection = getConnection(), result = tab?.results[index]
    if (!tab || !connection || !result || result.kind !== 'data' || tab.exports[index] || disabled() || tab.running || tab.saving || tab.closing || tab.cancelling || tab.exporting) return false
    const id = connection.id, operation = tab.operation
    const current = () => workspace.tabs.includes(tab) && tab.operation === operation && getConnection()?.id === id && tab.results[index] === result
    const check = () => { if (!current() || tab.exportCancelRequested) throw new Error('CSV export cancelled') }
    const state = { fetching: false, cancel: Promise.resolve() }
    pending.set(key, state)
    tab.exporting = true; tab.exportCancelRequested = false; tab.message = ''; tab.exportMessage = ''
    let token: string | null = null, dispatched = false, exported = 0
    const write = async (columns: string[] | null, rows: unknown[][]) => {
      for (const chunk of csvChunks(columns, rows)) { check(); await transport.appendCsvExport(token!, chunk) }
      check(); exported += rows.length
    }
    try {
      token = await transport.startCsvExport()
      if (!token) return false
      check()
      await write(result.columns, result.rows)
      let more = result.truncated
      while (more) {
        check(); dispatched = true; state.fetching = true
        let page
        try { page = await transport.fetchMore(id, key, sanitizeSettings({ maxRows: getMaxRows() }).maxRows) }
        finally { state.fetching = false }
        check()
        tab.notices = appendNoticeOutput(tab.notices, page)
        await write(null, page.rows)
        more = page.truncated
      }
      check()
      const path = await transport.finishCsvExport(token)
      token = null
      if (!current()) return false
      if (dispatched) { result.truncated = false; tab.exports[index] = { rows: exported, incomplete: false, path } }
      tab.exportMessage = `${exported} row(s) exported to ${path}. The grid retains ${result.rows.length} loaded row(s).${result.limited ? ' This result was limited; omitted rows are not available for export.' : ''}`
      return true
    } catch (error) {
      if (current()) {
        if (dispatched) { result.truncated = false; tab.exports[index] = { rows: exported, incomplete: true } }
        tab.message = `${errorMessage(error)}${dispatched ? ' Re-run the query before exporting or paging again.' : ''}`
        tab.notices = appendNoticeOutput(tab.notices, errorNotices(error))
      }
      return false
    } finally {
      if (token) {
        try { await transport.abortCsvExport(token) }
        catch { if (current()) tab.message += ' Could not confirm export cleanup.' }
      }
      // A delayed CancelRequest must finish before the tab can run new SQL.
      await state.cancel
      pending.delete(key)
      tab.exporting = false; tab.exportCancelRequested = false
    }
  }
  return { exportCsv, cancel }
}
