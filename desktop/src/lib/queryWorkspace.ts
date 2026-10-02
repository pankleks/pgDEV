import type { api, Connected } from '../api'
import type { QueryResult } from '../generated/contracts'
import { appendNoticeOutput, errorNotices, type NoticeOutput } from './notices'
import { errorMessage, transactionFromError } from './errors'

export interface QueryTab {
  key: string
  title: string
  sql: string
  results: QueryResult[]
  transactionId: string | null
  durationMs: number | null
  message: string
  running: boolean
  cancelling: boolean
  saving: boolean
  closing: boolean
  operation: number
  notices: NoticeOutput
}
export interface QueryWorkspace { tabs: QueryTab[]; activeKey: string; nextTitle: number }
type QueryApi = Pick<typeof api, 'query' | 'fetchMore' | 'cancel' | 'closeSession' | 'rowUpdate'>
const emptyNotices = (): NoticeOutput => ({ notices: [], noticesTruncated: false })

function createTab(key: string, title: string, sql = ''): QueryTab {
  return { key, title, sql, results: [], transactionId: null, durationMs: null, message: '', running: false, cancelling: false, saving: false, closing: false, operation: 0, notices: emptyNotices() }
}
export function createQueryWorkspace(takeKey: () => string = () => crypto.randomUUID()): QueryWorkspace {
  const tab = createTab(takeKey(), 'Query 1', 'SELECT current_database(), version();')
  return { tabs: [tab], activeKey: tab.key, nextTitle: 2 }
}
export function tabNeedsConfirmation(tab: QueryTab): boolean {
  return tab.sql.length > 0 || tab.running || tab.transactionId !== null
}

/** Plain objects are supplied by the Svelte caller as reactive proxies.
 * Every async operation captures its original tab, connection and generation;
 * switching tabs never redirects results, and stale replies are discarded. */
export function createQueryController(
  workspace: QueryWorkspace,
  transport: QueryApi,
  getConnection: () => Connected | null,
  disabled = () => false,
  takeKey: () => string = () => crypto.randomUUID(),
) {
  const find = (key: string) => workspace.tabs.find(tab => tab.key === key)
  const busy = (tab: QueryTab) => tab.running || tab.cancelling || tab.saving || tab.closing
  const current = (tab: QueryTab, id: string, operation: number) => getConnection()?.id === id && workspace.tabs.includes(tab) && tab.operation === operation
  function failure(tab: QueryTab, error: unknown, append = false) {
    tab.message = errorMessage(error)
    tab.notices = append ? appendNoticeOutput(tab.notices, errorNotices(error)) : errorNotices(error)
    const transaction = transactionFromError(error)
    if (transaction !== undefined) tab.transactionId = transaction
  }
  function addTab() {
    const tab = createTab(takeKey(), `Query ${workspace.nextTitle++}`)
    workspace.tabs.push(tab)
    workspace.activeKey = tab.key
    return find(tab.key)!
  }
  function activateTab(key: string) {
    if (!find(key)) return false
    workspace.activeKey = key
    return true
  }
  function setSql(key: string, sql: string) { const tab = find(key); if (tab) tab.sql = sql }
  function resetConnection() {
    for (const tab of workspace.tabs) {
      ++tab.operation
      tab.results = []; tab.transactionId = null; tab.durationMs = null; tab.message = ''
      tab.running = false; tab.cancelling = false; tab.saving = false; tab.closing = false; tab.notices = emptyNotices()
    }
  }
  async function run(key: string, sql: string) {
    const tab = find(key), connection = getConnection()
    if (!tab || !connection || disabled() || busy(tab)) return false
    const id = connection.id, operation = ++tab.operation
    tab.running = true; tab.message = ''; tab.results = []; tab.durationMs = null; tab.notices = emptyNotices()
    try {
      const response = await transport.query({ id, tabKey: key, sql, transactionId: tab.transactionId, maxRows: 500 })
      if (!current(tab, id, operation)) return false
      tab.results = response.results; tab.transactionId = response.transactionId; tab.durationMs = response.durationMs
      tab.notices = appendNoticeOutput(tab.notices, response)
      return true
    } catch (error) {
      if (current(tab, id, operation)) failure(tab, error)
      return false
    } finally { if (current(tab, id, operation)) tab.running = false }
  }
  async function more(key: string, index: number) {
    const tab = find(key), connection = getConnection(), result = tab?.results[index]
    if (!tab || !connection || !result || result.kind !== 'data' || !result.truncated || disabled() || busy(tab)) return false
    const id = connection.id, operation = ++tab.operation
    tab.running = true; tab.message = ''
    try {
      const page = await transport.fetchMore(id, key)
      if (!current(tab, id, operation) || tab.results[index] !== result) return false
      result.rows.push(...page.rows); result.rowCount += page.rowCount; result.truncated = page.truncated
      tab.notices = appendNoticeOutput(tab.notices, page)
      return true
    } catch (error) {
      if (current(tab, id, operation)) { failure(tab, error, true); result.truncated = false }
      return false
    } finally { if (current(tab, id, operation)) tab.running = false }
  }
  async function cancel(key: string) {
    const tab = find(key), connection = getConnection()
    if (!tab || !connection || !tab.running || tab.cancelling || tab.closing || disabled()) return
    const id = connection.id, operation = tab.operation
    tab.cancelling = true
    try { await transport.cancel(id, key) }
    catch (error) { if (current(tab, id, operation)) tab.message = errorMessage(error) }
    finally { if (current(tab, id, operation)) tab.cancelling = false }
  }
  async function rowUpdate(key: string, index: number, rowIndex: number, set: Record<string, string | null>) {
    const tab = find(key), connection = getConnection(), result = tab?.results[index]
    if (!tab || !connection || !result || result.kind !== 'data' || !result.editable || !result.rows[rowIndex] || disabled() || busy(tab)) return false
    const id = connection.id, operation = ++tab.operation, grid = result.editable
    const rowKey = Object.fromEntries(grid.pk.map(name => [name, result.rows[rowIndex][result.columns.indexOf(name)]]))
    tab.saving = true; tab.message = ''; tab.notices = emptyNotices()
    try {
      const response = await transport.rowUpdate({ id, tabKey: key, transactionId: tab.transactionId, schema: grid.schema, table: grid.table, key: rowKey, set })
      if (!current(tab, id, operation) || tab.results[index] !== result) return false
      result.rows[rowIndex] = result.columns.map((name, column) => Object.hasOwn(response.row, name) ? response.row[name] : result.rows[rowIndex][column])
      tab.transactionId = response.transactionId; tab.notices = appendNoticeOutput(tab.notices, response)
      return true
    } catch (error) { if (current(tab, id, operation)) failure(tab, error); return false }
    finally { if (current(tab, id, operation)) tab.saving = false }
  }
  async function closeTab(key: string) {
    const tab = find(key), connection = getConnection()
    // An autocommit row write uses another socket: do not close its UI while
    // the write is still in flight. Running SQL may be explicitly abandoned.
    if (!tab || tab.closing || tab.saving || tab.cancelling || disabled()) return false
    const operation = tab.operation
    const stillCurrent = () => workspace.tabs.includes(tab) && tab.operation === operation && getConnection()?.id === connection?.id
    tab.closing = true
    try { if (connection) await transport.closeSession(connection.id, key) }
    catch (error) { if (stillCurrent()) { tab.closing = false; tab.message = errorMessage(error) }; return false }
    if (!stillCurrent()) return false
    const index = workspace.tabs.indexOf(tab)
    if (index < 0) return false
    ++tab.operation
    workspace.tabs.splice(index, 1)
    if (!workspace.tabs.length) addTab()
    else if (workspace.activeKey === key) workspace.activeKey = workspace.tabs[Math.min(index, workspace.tabs.length - 1)]!.key
    return true
  }
  return { addTab, activateTab, setSql, resetConnection, run, more, cancel, rowUpdate, closeTab }
}
