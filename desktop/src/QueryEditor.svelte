<script lang="ts">
  import { onMount } from 'svelte'
  import monaco from './monaco'
  import { QueryModels } from './lib/queryModels'
  import type { QueryTab } from './lib/queryWorkspace'
  import type { SchemaData } from './generated/contracts'

  let { tabs, activeKey, catalog = null, fontSize = 14, onchange, onrun }: { tabs: QueryTab[]; activeKey: string; catalog?: SchemaData | null; fontSize?: number; onchange: (key: string, sql: string) => void; onrun: (sql: string) => void } = $props()
  let host: HTMLDivElement
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  let models: QueryModels | undefined

  export function getSql(): string {
    return models?.getSql() ?? tabs.find(tab => tab.key === activeKey)?.sql ?? ''
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
    editor.addAction({ id: 'pgdev.run', label: 'Run SQL', keybindings: [monaco.KeyCode.F5, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => onrun(getSql()) })
    return () => {
      changes.dispose()
      editor?.dispose()
      models?.dispose()
      models = undefined
      editor = undefined
    }
  })

  $effect(() => {
    const snapshot = tabs.map(tab => ({ key: tab.key, sql: tab.sql }))
    const key = activeKey
    const font = fontSize
    editor?.updateOptions({ fontSize: font })
    models?.sync(snapshot, key)
  })
</script>

<div class="editor" bind:this={host}></div>

<style>.editor { height: 320px; min-height: 160px; }</style>
