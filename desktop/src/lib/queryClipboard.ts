import type { api } from '../api'
import type { QueryWorkspace } from './queryWorkspace'
import { toDelimited } from '../../../web/src/lib/gridio'
import { errorMessage } from './errors'

export const CLIPBOARD_BYTES = 8 * 1024 * 1024

/** Use the existing TSV rules without building an unbounded whole-grid string.
 * No cursor fetching: this is an explicit copy of already loaded rows only. */
export function gridClipboardText(columns: string[], rows: unknown[][]): string {
  const encoder = new TextEncoder(), parts = [toDelimited(columns, [], '\t')]
  let bytes = encoder.encode(parts[0]).length
  if (bytes > CLIPBOARD_BYTES) throw new Error('Clipboard text exceeds 8 MiB; use CSV export instead')
  for (const row of rows) {
    // The empty header contributes one newline before this row.
    const line = toDelimited([], [row], '\t')
    bytes += encoder.encode(line).length
    if (bytes > CLIPBOARD_BYTES) throw new Error('Clipboard text exceeds 8 MiB; use CSV export instead')
    parts.push(line)
  }
  return parts.join('')
}

export function createClipboardController(workspace: QueryWorkspace, transport: Pick<typeof api, 'writeClipboardText'>, disabled = () => false) {
  let copying = false
  async function copy(key: string, index: number): Promise<boolean> {
    const tab = workspace.tabs.find(tab => tab.key === key), result = tab?.results[index]
    if (copying || disabled() || !tab || !result || result.kind !== 'data') return false
    const operation = tab.operation
    const current = () => workspace.tabs.includes(tab) && tab.operation === operation && tab.results[index] === result
    copying = true; tab.clipboardMessage = ''; tab.clipboardError = ''
    try {
      const text = gridClipboardText(result.columns, result.rows)
      const rows = result.rows.length, partial = result.truncated || result.limited || !!tab.exports[index]
      await transport.writeClipboardText(text)
      if (current()) tab.clipboardMessage = `${rows} loaded row(s) copied as TSV.${partial ? ' This copy does not include rows that are not retained in the grid.' : ''}`
      return true
    } catch (error) { if (current()) tab.clipboardError = errorMessage(error); return false }
    finally { copying = false }
  }
  return { copy }
}
