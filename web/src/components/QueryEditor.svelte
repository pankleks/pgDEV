<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte'
  import monaco from '../monaco'
  import { registerSqlCompletion, completionSuggestions } from '../monaco/completions'
  import { registerSqlHover, hoverContents } from '../monaco/hover'
  import { registerSqlSignature, signatureHelp as signatureHelpAt } from '../monaco/signature'
  import { useTabs, type EditorTab } from '../composables/tabs'
  import { useResults } from '../composables/results'
  import { useSettings } from '../composables/settings'
  import { useToast } from '../composables/toast'
  import { formatSql } from '../lib/sqlformat'
  import { modelUri } from '../lib/modeluri'
  import { mapParams, parseParamValues } from '../lib/preparemap'
  import { setFormatHandler, setInsertHandler, setParamsHandler, setSelectionGetter } from '../lib/formatbridge'
  import { stateView } from '../lib/state.svelte'

  let { tab, onrun }: { tab: EditorTab; onrun: () => void } = $props()
  let el: HTMLDivElement
  const tabs = useTabs()
  const results = useResults()
  const settings = useSettings()
  const toast = useToast()
  const snapshot = stateView(() => ({
    fontSize: settings.state.editorFontSize,
    keys: tabs.state.tabs.map((tab) => tab.key),
    errors: Object.fromEntries(tabs.state.tabs.map((tab) => {
      const result = results.state.byTab[tab.key]
      const last = result?.messages.at(-1)
      return [tab.key, result ? `${result.operation}:${result.messages.length}:${last?.position ?? ''}:${last?.text ?? ''}` : 'none']
    })),
  }))
  let editor: monaco.editor.IStandaloneCodeEditor | null = null
  let mounted = $state(false)
  const models = new Map<string, monaco.editor.ITextModel>()
  const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()
  const activeKey = $derived(tab.key)
  const errorSignature = $derived(snapshot.current.errors[activeKey])

  onMount(() => {
    editor = monaco.editor.create(el, {
      model: null, language: 'sql', theme: 'pgdev-dark', automaticLayout: true, minimap: { enabled: false },
      fontSize: settings.state.editorFontSize, tabSize: 4, insertSpaces: false, detectIndentation: false,
      scrollBeyondLastLine: false, wordWrap: 'on', renderWhitespace: 'selection', wordBasedSuggestions: 'off',
    })
    registerSqlCompletion(monaco)
    registerSqlHover(monaco)
    registerSqlSignature(monaco)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onrun())
    editor.addCommand(monaco.KeyCode.F5, () => onrun())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF, formatActive)
    setFormatHandler(formatActive)
    setParamsHandler(mapParamsActive)
    setInsertHandler((text) => {
      if (!editor || tab.readOnly) return false
      const model = editor.getModel()
      if (!model) return false
      const selection = editor.getSelection() ?? model.getFullModelRange()
      editor.executeEdits('pgdev-ai', [{ range: selection, text, forceMoveMarkers: true }])
      return true
    })
    setSelectionGetter(() => {
      const model = editor?.getModel()
      const selection = editor?.getSelection()
      return model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : undefined
    })
    mounted = true
    // Existing development-only automation surface; never expose in production.
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__pgdev = {
        editor, monaco,
        getReadOnly: () => !!editor?.getOption(monaco.editor.EditorOption.readOnly),
        getValue: () => editor?.getModel()?.getValue() ?? '',
        setValue: (text: string) => editor?.getModel()?.setValue(text),
        suggestions: (needle?: string) => {
          const model = editor?.getModel()
          if (!model) return []
          let position: { lineNumber: number; column: number }
          if (needle) {
            const offset = model.getValue().lastIndexOf(needle)
            if (offset < 0) return []
            position = model.getPositionAt(offset + needle.length)
          } else {
            const end = model.getFullModelRange()
            position = { lineNumber: end.endLineNumber, column: end.endColumn }
          }
          return completionSuggestions(model, position as never).map((suggestion) => ({
            label: typeof suggestion.label === 'string' ? suggestion.label : suggestion.label.label,
            description: typeof suggestion.label === 'string' ? undefined : suggestion.label.description,
            labelDetail: typeof suggestion.label === 'string' ? undefined : suggestion.label.detail,
            kind: suggestion.kind, detail: suggestion.detail,
            insertText: typeof suggestion.insertText === 'string' ? suggestion.insertText : undefined,
            sortText: suggestion.sortText,
          }))
        },
        hover: (needle: string) => {
          const model = editor?.getModel()
          if (!model || !needle) return null
          const offset = model.getValue().lastIndexOf(needle)
          return offset < 0 ? null : hoverContents(model, model.getPositionAt(offset + Math.floor(needle.length / 2)) as never)
        },
        signatureHelp: (needle: string) => {
          const model = editor?.getModel()
          if (!model || !needle) return null
          const offset = model.getValue().lastIndexOf(needle)
          return offset < 0 ? null : signatureHelpAt(model, model.getPositionAt(offset + needle.length) as never)
        },
        markers: () => monaco.editor.getModelMarkers({}),
      }
    }
  })

  function formatActive() {
    if (!editor || tab.readOnly) return
    const model = editor.getModel()
    if (!model) return
    const selection = editor.getSelection()
    const selectedRange = selection && !selection.isEmpty() ? selection : null
    const selected = selectedRange ? model.getValueInRange(selectedRange) : ''
    if (selectedRange && selected.trim()) {
      let formatted: string
      try { formatted = formatSql(selected).replace(/\s+$/, '') }
      catch (cause) { toast.show(`Format failed: ${(cause as Error).message}`); return }
      if (formatted && formatted !== selected) editor.executeEdits('pgdev-format', [{ range: selectedRange, text: formatted }])
      return
    }
    const current = model.getValue()
    if (!current.trim()) return
    let formatted: string
    try { formatted = formatSql(current) }
    catch (cause) { toast.show(`Format failed: ${(cause as Error).message}`); return }
    const text = formatted.endsWith('\n') ? formatted : `${formatted}\n`
    if (text !== current) editor.executeEdits('pgdev-format', [{ range: model.getFullModelRange(), text }])
  }
  function mapParamsActive(valuesText?: string) {
    if (!editor || tab.readOnly) return
    const model = editor.getModel()
    if (!model) return
    const selection = editor.getSelection()
    const range = selection && !selection.isEmpty() ? selection : model.getFullModelRange()
    const sql = model.getValueInRange(range)
    if (!sql.trim()) return
    const override = valuesText ? parseParamValues(valuesText) : null
    if (valuesText?.trim() && !override) {
      toast.show('Could not parse parameter values — expected a JSON array like [1, "text", false, null]')
      return
    }
    const script = mapParams(sql, override ?? undefined)
    if (!script) { toast.show('No query parameters found'); return }
    editor.executeEdits('pgdev-prepare', [{ range, text: script }])
  }
  function modelFor(tab: EditorTab) {
    let model = models.get(tab.key)
    if (!model) {
      model = monaco.editor.createModel(tab.content, 'sql', monaco.Uri.parse(modelUri(tab.key)))
      model.onDidChangeContent(() => {
        monaco.editor.setModelMarkers(model!, 'pgdev-sql', [])
        tabs.updateContent(tab.key, model!.getValue())
      })
      models.set(tab.key, model)
    }
    return model
  }
  function applyTab(tab: EditorTab) {
    if (!editor) return
    const outgoing = editor.getModel()
    if (outgoing) {
      const key = [...models.entries()].find(([, model]) => model === outgoing)?.[0]
      const state = editor.saveViewState()
      if (key && state) viewStates.set(key, state)
    }
    const model = modelFor(tab)
    if (model.getValue() !== tab.content) model.setValue(tab.content)
    editor.setModel(model)
    const saved = viewStates.get(tab.key)
    if (saved) editor.restoreViewState(saved)
    editor.updateOptions({ readOnly: tab.readOnly })
  }
  function syncExternalContent(tab: EditorTab) {
    const model = models.get(tab.key)
    if (!model || model.getValue() === tab.content) return
    model.setValue(tab.content)
    if (editor?.getModel() === model) {
      const saved = viewStates.get(tab.key)
      if (saved) editor.restoreViewState(saved)
    }
  }
  function syncErrorMarker(tabKey: string, reveal: boolean) {
    const model = models.get(tabKey)
    if (!model) return
    const result = results.state.byTab[tabKey]
    const failure = [...(result?.messages ?? [])].reverse().find((message) => message.level === 'error' && message.position)
    if (!failure?.position || (result?.sentSql != null && result.sentSql !== model.getValue())) {
      monaco.editor.setModelMarkers(model, 'pgdev-sql', [])
      return
    }
    const offset = Number(failure.position) - 1
    if (!Number.isFinite(offset)) { monaco.editor.setModelMarkers(model, 'pgdev-sql', []); return }
    const clamped = Math.max(0, Math.min(model.getValueLength(), Math.floor(offset)))
    const position = model.getPositionAt(clamped)
    const word = model.getWordAtPosition(position)
    const end = word && word.startColumn <= position.column
      ? { lineNumber: position.lineNumber, column: word.endColumn }
      : model.getPositionAt(Math.min(model.getValueLength(), clamped + 1))
    monaco.editor.setModelMarkers(model, 'pgdev-sql', [{
      severity: monaco.MarkerSeverity.Error, message: failure.text,
      startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: end.lineNumber, endColumn: end.column,
    }])
    if (reveal && editor?.getModel() === model) editor.revealPositionInCenter(position)
  }
  $effect(() => {
    const key = activeKey
    if (!mounted) return
    // Content updates must not reset the model/cursor on every keystroke.
    untrack(() => { applyTab(tab); syncErrorMarker(key, false) })
  })
  $effect(() => {
    const content = tab.content
    if (!mounted) return
    untrack(() => { void content; syncExternalContent(tab) })
  })
  $effect(() => { const readOnly = tab.readOnly; if (mounted) editor?.updateOptions({ readOnly }) })
  $effect(() => { const fontSize = snapshot.current.fontSize; if (mounted) editor?.updateOptions({ fontSize }) })
  let markerKey = ''
  $effect(() => {
    const key = activeKey
    const signature = errorSignature
    if (!mounted) return
    untrack(() => { void signature; syncErrorMarker(key, markerKey === key); markerKey = key })
  })
  $effect(() => {
    const keys = snapshot.current.keys
    if (!mounted) return
    for (const [key, model] of models) if (!keys.includes(key)) {
      // Detach before disposing a closed active model; editor contributions
      // must stop using it before its disposal event fires.
      if (editor?.getModel() === model) editor.setModel(null)
      model.dispose(); models.delete(key); viewStates.delete(key)
    }
  })
  onDestroy(() => {
    setFormatHandler(null)
    setParamsHandler(null)
    setSelectionGetter(null)
    setInsertHandler(null)
    editor?.setModel(null)
    editor?.dispose()
    models.forEach((model) => model.dispose())
    models.clear()
    viewStates.clear()
  })
</script>

<div bind:this={el} class="editor-host" data-component="svelte-query-editor"></div>
