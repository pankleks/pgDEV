<script lang="ts">
  import { dialogFocus } from '../lib/dialogfocus'
  import { Copy, KeyRound, RefreshCw, RotateCcw, X } from '@lucide/svelte'
  import { api } from '../api'
  import { useAi } from '../composables/ai'
  import { useSettings } from '../composables/settings'
  import { useUpdates } from '../composables/updates'
  import { useToast } from '../composables/toast'
  import { confirmAction } from '../lib/desktop'
  import { copyText } from '../lib/gridio'
  import { stateView } from '../lib/state.svelte'
  import Stepper from './Stepper.svelte'
  import Toggle from './Toggle.svelte'

  let { onclose, onshowupdate }: { onclose: () => void; onshowupdate: () => void } = $props()
  const updates = useUpdates()
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
    checkUpdates: settings.state.checkUpdates,
    skippedUpdate: settings.state.skippedUpdate,
    current: updates.state.current,
    enabled: updates.state.enabled,
    update: updates.state.update,
    checking: updates.state.checking,
    error: updates.state.error,
    manual: updates.state.manual,
  }))
  const updateStatus = $derived.by(() => {
    const s = snapshot.current
    if (s.checking) return 'Checking…'
    if (s.error) return `The check failed: ${s.error}`
    if (!s.enabled) return 'Update checks are off in development builds.'
    if (s.update) return `pgDEV ${s.update.version} is available${s.update.version === s.skippedUpdate ? ' (skipped)' : ''}.`
    return s.manual ? 'You have the newest version.' : ''
  })

  function reset() {
    settings.resetToDefaults()
    void ai.pushLimits()
  }

  async function rotateToken() {
    if (copyingConfig) return
    const confirmed = await confirmAction(
      'Rotate the MCP token? Connected MCP clients stop working until you paste the new config into them.',
    )
    if (!confirmed) return
    copyingConfig = true
    try {
      const config = await api.rotateAiToken()
      const ok = await copyText(config.config)
      toast.show(ok ? 'Token rotated. New MCP config copied.' : 'Token rotated. Copy the new MCP config with COPY.')
    } catch (error) {
      toast.show((error as Error).message || 'Could not rotate the token')
    } finally {
      copyingConfig = false
    }
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

<!-- Pointer dismissal only (mousedown: a text selection dragged out of a field must not close it). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" onmousedown={(event) => { if (event.target === event.currentTarget) onclose() }}>
  <div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1" use:dialogFocus={onclose}>
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
          <small>Copy the JSON config for an MCP client (opencode, Claude Desktop, …). The agent can read the schema, run read-only queries, and stage writes in a tab for you to run. On connections with “Allow AI writes” it can also commit writes itself. Rotate the token if it may have leaked; every client then needs the new config.</small>
        </div>
        <div class="setting-actions">
          <button class="btn-sm" disabled={copyingConfig} title="Replace the MCP token; existing client configs stop working" onclick={rotateToken}><KeyRound size={13} /> Rotate</button>
          <button class="btn-sm primary" disabled={copyingConfig} onclick={copyMcpConfig}><Copy size={13} /> COPY</button>
        </div>
      </div>
    </section>
    <section class="settings-section">
      <h3>Updates</h3>
      <div class="setting-row">
        <div class="setting-text"><strong>Check for updates</strong><small>Ask GitHub for a newer pgDEV release at startup and once a day. A newer version glows next to the version number at the top right; nothing is downloaded or installed automatically.</small></div>
        <Toggle modelValue={snapshot.current.checkUpdates} label="Check for updates" onchange={(value) => settings.setCheckUpdates(value)} />
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <strong>Version {snapshot.current.current || '…'}</strong>
          {#if updateStatus}<small>{updateStatus}</small>{/if}
        </div>
        <div class="setting-actions">
          {#if snapshot.current.update}<button class="btn-sm primary" onclick={onshowupdate}>View</button>{/if}
          <button class="btn-sm" disabled={snapshot.current.checking} onclick={() => updates.checkNow()}><RefreshCw size={13} /> Check now</button>
        </div>
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
