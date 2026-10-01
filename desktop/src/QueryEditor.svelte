<script lang="ts">
  import { onMount } from 'svelte'
  import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
  import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
  import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

  let { value = $bindable(''), onrun }: { value?: string; onrun: (sql: string) => void } = $props()
  let host: HTMLDivElement
  let editor: monaco.editor.IStandaloneCodeEditor | undefined

  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

  export function getSql(): string {
    const selection = editor?.getSelection()
    return selection && !selection.isEmpty() ? editor!.getModel()!.getValueInRange(selection) : value
  }

  onMount(() => {
    editor = monaco.editor.create(host, {
      value, language: 'sql', theme: 'vs-dark', automaticLayout: true,
      minimap: { enabled: false }, fontSize: 14,
    })
    const changes = editor.onDidChangeModelContent(() => { value = editor!.getValue() })
    editor.addAction({ id: 'pgdev.run', label: 'Run SQL', keybindings: [monaco.KeyCode.F5, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => onrun(getSql()) })
    return () => {
      changes.dispose()
      const model = editor?.getModel()
      editor?.dispose()
      model?.dispose()
      editor = undefined
    }
  })

  $effect(() => {
    if (editor && editor.getValue() !== value) editor.setValue(value)
  })
</script>

<div class="editor" bind:this={host}></div>

<style>.editor { height: 320px; min-height: 160px; }</style>
