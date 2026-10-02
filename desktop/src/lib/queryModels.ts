import type * as Monaco from 'monaco-editor'
import type { QueryTab } from './queryWorkspace'
import type { SchemaData } from '../generated/contracts'
import { modelUri } from '../../../web/src/lib/modeluri'
import { registerSqlProviders } from './sqlProviders'

type Entry = { model: Monaco.editor.ITextModel; providers: Monaco.IDisposable; view: Monaco.editor.ICodeEditorViewState | null }

/** Retain a model (and its undo stack) per tab; switching never calls setValue
 * on the destination just to show it. Removed models dispose their providers. */
export class QueryModels {
  private entries = new Map<string, Entry>()
  private activeKey: string | null = null
  constructor(private monaco: typeof Monaco, private editor: Monaco.editor.IStandaloneCodeEditor, private getSchema: () => SchemaData | null) {}

  keyFor(model: Monaco.editor.ITextModel | null): string | undefined {
    for (const [key, entry] of this.entries) if (entry.model === model) return key
    return undefined
  }
  sync(tabs: readonly Pick<QueryTab, 'key' | 'sql'>[], activeKey: string) {
    for (const tab of tabs) {
      let entry = this.entries.get(tab.key)
      if (!entry) {
        const model = this.monaco.editor.createModel(tab.sql, 'sql', this.monaco.Uri.parse(modelUri(tab.key)))
        entry = { model, providers: registerSqlProviders(this.monaco, model, this.getSchema), view: null }
        this.entries.set(tab.key, entry)
      } else if (entry.model.getValue() !== tab.sql) entry.model.setValue(tab.sql)
    }
    if (this.activeKey !== activeKey) {
      const previous = this.activeKey ? this.entries.get(this.activeKey) : undefined
      if (previous) previous.view = this.editor.saveViewState()
      const next = this.entries.get(activeKey)
      if (next) {
        this.editor.setModel(next.model)
        if (next.view) this.editor.restoreViewState(next.view)
        this.activeKey = activeKey
      }
    }
    const keys = new Set(tabs.map(tab => tab.key))
    for (const [key, entry] of this.entries) {
      if (keys.has(key)) continue
      entry.providers.dispose(); entry.model.dispose(); this.entries.delete(key)
    }
  }
  getSql(): string {
    const model = this.editor.getModel(), selection = this.editor.getSelection()
    if (!model) return ''
    return selection && !selection.isEmpty() ? model.getValueInRange(selection) : model.getValue()
  }
  dispose() {
    for (const entry of this.entries.values()) { entry.providers.dispose(); entry.model.dispose() }
    this.entries.clear(); this.activeKey = null
  }
}
