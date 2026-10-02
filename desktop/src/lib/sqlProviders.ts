import type * as Monaco from 'monaco-editor'
import type { SchemaData } from '../generated/contracts'
import { createSqlCompletionProvider } from '../../../web/src/monaco/completionProvider'
import { createSqlHoverProvider } from '../../../web/src/monaco/hoverProvider'
import { createSqlSignatureProvider } from '../../../web/src/monaco/signatureProvider'

/** Each provider is scoped to its owning model. Multiple editors must not
 * duplicate suggestions or read each other's catalog state. */
export function registerSqlProviders(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  getSchema: () => SchemaData | null,
): Monaco.IDisposable {
  const completion = createSqlCompletionProvider(monaco, getSchema)
  const hover = createSqlHoverProvider(monaco, getSchema)
  const signature = createSqlSignatureProvider(getSchema)
  const registrations = [
    monaco.languages.registerCompletionItemProvider('sql', {
      ...completion,
      provideCompletionItems: (candidate, ...args) => candidate === model ? completion.provideCompletionItems(candidate, ...args) : { suggestions: [] },
    }),
    monaco.languages.registerHoverProvider('sql', {
      provideHover: (candidate, ...args) => candidate === model ? hover.provideHover(candidate, ...args) : null,
    }),
    monaco.languages.registerSignatureHelpProvider('sql', {
      ...signature,
      provideSignatureHelp: (candidate, ...args) => candidate === model ? signature.provideSignatureHelp(candidate, ...args) : null,
    }),
  ]
  return { dispose: () => registrations.forEach(registration => registration.dispose()) }
}
