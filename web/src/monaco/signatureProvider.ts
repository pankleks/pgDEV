import type * as Monaco from 'monaco-editor'
import type { SchemaData } from '../types'
import { computeSignatureHelp } from '../lib/signature'

export function createSqlSignatureProvider(
  getSchema: () => SchemaData | null,
): Monaco.languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    provideSignatureHelp(model, position) {
      const data = getSchema()
      if (!data) return null
      const help = computeSignatureHelp(data, model.getValue(), model.getOffsetAt(position))
      return help ? { value: help, dispose() {} } : null
    },
  }
}
