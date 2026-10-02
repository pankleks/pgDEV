import type * as Monaco from 'monaco-editor'
import { formatSql } from '../../../web/src/lib/sqlformat'

/** Shared PostgreSQL formatter, applied as one undoable edit, never setValue.
 * Parse failures propagate before any edit or undo boundary is applied. */
export function formatEditor(editor: Monaco.editor.IStandaloneCodeEditor, format = formatSql): boolean {
  const model = editor.getModel()
  if (!model || editor.getRawOptions().readOnly) return false
  const selection = editor.getSelection()
  const selected = selection && !selection.isEmpty() ? model.getValueInRange(selection) : ''
  const range = selected.trim() ? selection! : model.getFullModelRange()
  const current = selected.trim() ? selected : model.getValue()
  if (!current.trim()) return false
  let formatted = format(current)
  formatted = selected.trim() ? formatted.replace(/\s+$/, '') : formatted.endsWith('\n') ? formatted : `${formatted}\n`
  if (!formatted || formatted === current) return false
  editor.pushUndoStop()
  const applied = editor.executeEdits('pgdev-format', [{ range, text: formatted }])
  editor.pushUndoStop()
  return applied
}
