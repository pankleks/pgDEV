<script lang="ts">
  import { onMount } from 'svelte'
  import monaco from './monaco'
  import { registerSqlProviders } from './lib/sqlProviders'
  import type { SchemaData } from './generated/contracts'

  let { value = $bindable(''), catalog = null, onrun }: { value?: string; catalog?: SchemaData | null; onrun: (sql: string) => void } = $props()
  let host: HTMLDivElement
  let editor: monaco.editor.IStandaloneCodeEditor | undefined

  export function getSql(): string {
    const selection = editor?.getSelection()
    return selection && !selection.isEmpty() ? editor!.getModel()!.getValueInRange(selection) : value
  }

  onMount(() => {
    editor = monaco.editor.create(host, {
      value, language: 'sql', theme: 'pgdev-dark', automaticLayout: true,
      minimap: { enabled: false }, fontSize: 14,
      tabSize: 4, insertSpaces: false, detectIndentation: false,
      scrollBeyondLastLine: false, wordWrap: 'on', renderWhitespace: 'selection',
      wordBasedSuggestions: 'off',
    })
    const model = editor.getModel()!
    const providers = registerSqlProviders(monaco, model, () => catalog)
    const changes = editor.onDidChangeModelContent(() => { value = editor!.getValue() })
    editor.addAction({ id: 'pgdev.run', label: 'Run SQL', keybindings: [monaco.KeyCode.F5, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => onrun(getSql()) })
    return () => {
      changes.dispose()
      providers.dispose()
      editor?.dispose()
      model.dispose()
      editor = undefined
    }
  })

  $effect(() => {
    if (editor && editor.getValue() !== value) editor.setValue(value)
  })
</script>

<div class="editor" bind:this={host}></div>

<style>.editor { height: 320px; min-height: 160px; }</style>
