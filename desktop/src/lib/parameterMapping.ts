import type * as Monaco from 'monaco-editor'
import { findParams, mapParams, parseParamValues } from '../../../web/src/lib/preparemap'
import type { SqlSubmission } from './sqlDiagnostics'

export interface ParameterTarget { tabKey: string; submission: SqlSubmission }
const INPUT_BYTES = 1024 * 1024
const SCRIPT_BYTES = 8 * 1024 * 1024
const MAX_PARAMETER = 65535

function checkValues(values: unknown[], depth = 0): void {
  if (depth > 32) throw new Error('Parameter values are nested too deeply')
  for (const value of values) {
    if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      throw new Error('Large integer values must be pasted as JSON strings to avoid precision loss')
    }
    if (Array.isArray(value)) checkValues(value, depth + 1)
    else if (value && typeof value === 'object') checkValues(Object.values(value), depth + 1)
  }
}

/** Reuse the original scanner/literal/script rules, with explicit resource and
 * numeric-safety checks before generating a review-only PREPARE template. */
export function parameterScript(sql: string, valuesText = ''): string {
  const encoder = new TextEncoder()
  if (encoder.encode(sql).length > INPUT_BYTES || encoder.encode(valuesText).length > INPUT_BYTES) {
    throw new Error('Parameter mapping inputs are limited to 1 MiB each')
  }
  const indices = findParams(sql)
  if (!indices?.length) throw new Error('No query parameters found')
  if (indices.some(index => !Number.isSafeInteger(index) || index > MAX_PARAMETER)) {
    throw new Error('Parameter numbers must be between $1 and $65535')
  }
  const values = valuesText.trim() ? parseParamValues(valuesText) : undefined
  if (values === null) throw new Error('Could not parse parameter values — expected JSON like [1, "text", false, null]')
  if (values) checkValues(values)
  const script = mapParams(sql, values)!
  if (encoder.encode(script).length > SCRIPT_BYTES) throw new Error('Generated parameter SQL exceeds the 8 MiB limit')
  return script
}

/** Apply only to the captured, unchanged editor and range. One undoable edit;
 * there is no database transport here, and generated SQL is never executed. */
export function applyParameterScript(
  editor: Monaco.editor.IStandaloneCodeEditor,
  currentTabKey: string | undefined,
  target: ParameterTarget,
  script: string,
): boolean {
  const model = editor.getModel(), source = target.submission
  if (!model || editor.getRawOptions().readOnly) throw new Error('The query editor is unavailable or read-only')
  if (currentTabKey !== target.tabKey || model.getValue() !== source.documentSql
    || !Number.isSafeInteger(source.startOffset) || source.startOffset < 0
    || source.documentSql.slice(source.startOffset, source.startOffset + source.sql.length) !== source.sql) {
    throw new Error('The query or active tab changed. Reopen parameter mapping before applying SQL.')
  }
  if (!script.trim()) return false
  const start = model.getPositionAt(source.startOffset), end = model.getPositionAt(source.startOffset + source.sql.length)
  editor.pushUndoStop()
  const applied = editor.executeEdits('pgdev-prepare', [{ range: {
    startLineNumber: start.lineNumber, startColumn: start.column,
    endLineNumber: end.lineNumber, endColumn: end.column,
  }, text: script }])
  editor.pushUndoStop()
  return applied
}
