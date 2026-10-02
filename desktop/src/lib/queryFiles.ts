import type { api } from '../api'
import { errorMessage } from './errors'
import { tabIsDirty, type QueryWorkspace, type createQueryController } from './queryWorkspace'

type FileApi = Pick<typeof api, 'openSqlFile' | 'saveSqlFile' | 'releaseSqlFile'>
export function createFileController(
  workspace: QueryWorkspace,
  queries: ReturnType<typeof createQueryController>,
  transport: FileApi,
  disabled = () => false,
) {
  let opening = false
  async function release(token: string | undefined) { if (token) await transport.releaseSqlFile(token) }
  async function open() {
    if (opening || disabled()) return false
    opening = true
    try {
      const opened = await transport.openSqlFile()
      if (!opened) return false
      if (disabled()) { await release(opened.file.token); return false }
      const existing = workspace.tabs.find(tab => tab.file?.displayPath === opened.file.displayPath && !tabIsDirty(tab) && !tab.fileSaving && !tab.closing)
      const tab = existing ?? queries.addTab()
      const oldToken = tab.file?.token
      queries.setSql(tab.key, opened.content)
      tab.title = opened.file.fileName; tab.file = opened.file; tab.savedSql = opened.content
      queries.activateTab(tab.key)
      await release(oldToken)
      return true
    } finally { opening = false }
  }
  async function save(key: string, saveAs = false) {
    const tab = workspace.tabs.find(tab => tab.key === key)
    if (!tab || disabled() || tab.closing || tab.fileSaving) return false
    const content = tab.sql, oldToken = tab.file?.token
    tab.fileSaving = true; tab.editorError = ''
    try {
      const saved = await transport.saveSqlFile(content, saveAs ? null : oldToken ?? null)
      if (!saved) return false
      if (!workspace.tabs.includes(tab)) { await release(saved.token); return false }
      tab.title = saved.fileName; tab.file = saved; tab.savedSql = content
      // Edits made while the native dialog/write runs stay dirty against the
      // captured text that actually reached the disk, never the latest text.
      if (oldToken !== saved.token) await release(oldToken)
      return true
    } catch (error) { tab.editorError = errorMessage(error); return false }
    finally { tab.fileSaving = false }
  }
  return { open, save, release }
}
