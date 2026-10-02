import type * as Monaco from 'monaco-editor'
import { useSchema } from '../composables/schema'
import { createSqlHoverProvider } from './hoverProvider'

let registered = false
let devProvider: Monaco.languages.HoverProvider | null = null

export function registerSqlHover(monaco: typeof Monaco): void {
  if (registered) return
  registered = true
  const provider = createSqlHoverProvider(monaco, () => useSchema().state.data)
  monaco.languages.registerHoverProvider('sql', provider)
  if (import.meta.env.DEV) devProvider = provider
}

export function hoverContents(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): { markdown: string } | null {
  const result = devProvider?.provideHover(model, position, {} as never)
  if (!result || typeof (result as PromiseLike<unknown>).then === 'function') return null
  const hover = result as Monaco.languages.Hover
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  return { markdown: contents.map((c) => typeof c === 'string' ? c : c.value).join('\n\n') }
}
