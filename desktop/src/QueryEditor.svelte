<script lang="ts">
  import { onMount } from 'svelte'
  import monaco from './monaco'
  import { QueryModels } from './lib/queryModels'
  import type { QueryTab } from './lib/queryWorkspace'
  import type { SchemaData } from './generated/contracts'
  import type { SqlSubmission } from './lib/sqlDiagnostics'
  import { formatEditor } from './lib/sqlEditing'
  import { errorMessage } from './lib/errors'
  import { applyParameterScript as applyScript, type ParameterTarget } from './lib/parameterMapping'

  let { tabs, activeKey, catalog = null, fontSize = 14, onchange, onerror, onparameters, onrun }: { tabs: QueryTab[]; activeKey: string; catalog?: SchemaData | null; fontSize?: number; onchange: (key: string, sql: string) => void; onerror: (key: string, message: string) => void; onparameters: (target: ParameterTarget) => void; onrun: (submission: SqlSubmission) => void } = $props()
  let host: HTMLDivElement
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  let models: QueryModels | undefined

  export function getSql(): string {
    return models?.getSql() ?? tabs.find(tab => tab.key === activeKey)?.sql ?? ''
  }
  export function getSubmission(): SqlSubmission {
    return models?.getSubmission() ?? { sql: getSql(), documentSql: getSql(), startOffset: 0 }
  }
  export function formatSql(): void {
    if (!editor || !models) return
    const key = models.keyFor(editor.getModel())
    if (!key) return
    try { formatEditor(editor); onerror(key, '') }
    catch (error) { onerror(key, `Format failed: ${errorMessage(error)}`) }
  }
  export function mapParameters(): void {
    const tabKey = models?.keyFor(editor?.getModel() ?? null), submission = models?.getSubmission()
    if (tabKey && submission) onparameters({ tabKey, submission })
  }
  export function applyParameterScript(target: ParameterTarget, script: string): boolean {
    if (!editor || !models) throw new Error('The query editor is unavailable')
    return applyScript(editor, models.keyFor(editor.getModel()), target, script)
  }

  onMount(() => {
    editor = monaco.editor.create(host, {
      model: null, theme: 'pgdev-dark', automaticLayout: true,
      minimap: { enabled: false }, fontSize,
      tabSize: 4, insertSpaces: false, detectIndentation: false,
      scrollBeyondLastLine: false, wordWrap: 'on', renderWhitespace: 'selection',
      wordBasedSuggestions: 'off',
    })
    models = new QueryModels(monaco, editor, () => catalog)
    models.sync(tabs, activeKey)
    const changes = editor.onDidChangeModelContent(() => {
      const model = editor?.getModel(), key = models?.keyFor(model ?? null)
      if (key && model) onchange(key, model.getValue())
    })
    editor.addAction({ id: 'pgdev.run', label: 'Run SQL', keybindings: [monaco.KeyCode.F5, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => onrun(getSubmission()) })
    editor.addAction({ id: 'pgdev.format', label: 'Format SQL', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF], contextMenuGroupId: '1_modification', run: formatSql })
    editor.addAction({ id: 'pgdev.parameters', label: 'Map SQL parameters', contextMenuGroupId: '1_modification', run: mapParameters })
    return () => {
      changes.dispose()
      editor?.dispose()
      models?.dispose()
      models = undefined
      editor = undefined
    }
  })

  $effect(() => {
    const snapshot = tabs.map(tab => ({ key: tab.key, sql: tab.sql, sqlError: tab.sqlError }))
    const key = activeKey
    const font = fontSize
    editor?.updateOptions({ fontSize: font })
    models?.sync(snapshot, key)
  })
</script>

<div class="editor" bind:this={host}></div>

<style>.editor { height: 320px; min-height: 160px; }</style>
