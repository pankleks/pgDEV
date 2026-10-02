import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import { createSqlCompletionProvider } from './completionProvider'

let registered = false
let devProvider: Monaco.languages.CompletionItemProvider | null = null

export function registerSqlCompletion(monaco: typeof Monaco): void {
  if (registered) return
  registered = true
  const provider = createSqlCompletionProvider(monaco, () => useSchema().state.data)
  monaco.languages.registerCompletionItemProvider('sql', provider)
  if (import.meta.env.DEV) devProvider = provider
}

/** Preserve the existing browser suite's synchronous provider probe. */
export function completionSuggestions(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  const result = devProvider?.provideCompletionItems(model, position, {} as never, {} as never)
  if (!result || Array.isArray(result) || !('suggestions' in result)) return []
  return result.suggestions
}
