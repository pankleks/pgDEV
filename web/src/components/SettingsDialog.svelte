<script lang="ts">
  import { Copy, RotateCcw, X } from '@lucide/svelte'
  import { api } from '../api'
  import { useAi } from '../composables/ai'
  import { useSettings } from '../composables/settings'
  import { useToast } from '../composables/toast'
  import { copyText } from '../lib/gridio'
  import { stateView } from '../lib/state.svelte'
  import Stepper from './Stepper.svelte'
  import Toggle from './Toggle.svelte'

  let { onclose }: { onclose: () => void } = $props()
  const settings = useSettings()
  const ai = useAi()
  const toast = useToast()
  let copyingConfig = $state(false)
  const snapshot = stateView(() => ({
    editorFontSize: settings.state.editorFontSize,
    statementTimeout: settings.state.statementTimeout,
    aiLimitRows: settings.state.aiLimitRows,
    aiLimitKb: settings.state.aiLimitKb,
    groupObjects: settings.state.groupObjects,
  }))

  function reset() {
    settings.resetToDefaults()
    void ai.pushLimits()
  }

  async function copyMcpConfig() {
    if (copyingConfig) return
    copyingConfig = true
    try {
      const config = await api.aiConfig()
      const ok = await copyText(config.config)
      toast.show(ok ? 'MCP config copied.' : 'Copy to clipboard failed')
    } catch {
      toast.show('Could not load the MCP config')
    } finally {
      copyingConfig = false
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={(event) => { if (event.target === event.currentTarget) onclose() }}>
  <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1">
    <div class="settings-head">
      <div><h2>Settings</h2></div>
      <button class="icon" title="Close" onclick={onclose}><X size={17} /></button>
    </div>
    <section class="settings-section">
      <h3>Editor</h3>
      <div class="setting-row">
        <div class="setting-text"><strong>Font size</strong><small>Size of text in the query editor.</small></div>
        <Stepper modelValue={snapshot.current.editorFontSize} min={8} max={32} unit="px" onchange={(value) => settings.setEditorFontSize(value)} />
      </div>
    </section>
    <section class="settings-section">
      <h3>Query execution</h3>
      <div class="setting-row">
        <div class="setting-text"><strong>Statement timeout</strong><small>Cancel queries exceeding this duration. Changes apply to new connections.</small></div>
        <Stepper modelValue={snapshot.current.statementTimeout} min={1} max={600} unit="s" onchange={(value) => settings.setStatementTimeout(value)} />
      </div>
    </section>
    <section class="settings-section">
      <h3>AI agent</h3>
      <div class="setting-row">
        <div class="setting-text"><strong>Row limit</strong><small>How many rows of each result set an MCP agent may read.</small></div>
        <Stepper modelValue={snapshot.current.aiLimitRows} min={1} max={10000} unit="rows"
          onchange={(value) => { settings.setAiLimitRows(value); void ai.pushLimits() }} />
      </div>
      <div class="setting-row">
        <div class="setting-text"><strong>Size limit</strong><small>Byte budget of the rows an MCP agent may read per result set.</small></div>
        <Stepper modelValue={snapshot.current.aiLimitKb} min={1} max={4096} unit="KB"
          onchange={(value) => { settings.setAiLimitKb(value); void ai.pushLimits() }} />
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <strong>MCP config</strong>
          <small>Copy the JSON config for an MCP client (opencode, Claude Desktop, …). The agent can read the schema, run read-only queries, and stage writes in a tab for you to run.</small>
        </div>
        <button class="btn-sm primary" disabled={copyingConfig} onclick={copyMcpConfig}><Copy size={13} /> COPY</button>
      </div>
    </section>
    <section class="settings-section">
      <h3>Object browser</h3>
      <div class="setting-row">
        <div class="setting-text"><strong>Group objects</strong><small>Group related tables, views, functions, and types by common name prefixes.</small></div>
        <Toggle modelValue={snapshot.current.groupObjects} label="Group objects" onchange={(value) => settings.setGroupObjects(value)} />
      </div>
    </section>
    <div class="settings-foot">
      <button class="reset-link" title="Restore every setting to its default" onclick={reset}><RotateCcw size={14} /> Reset to defaults</button>
    </div>
  </div>
</div>
