import { createState } from '../lib/state.svelte'
import { api } from '../api'
import { insertAtCursor } from '../lib/formatbridge'
import { AI_TAB_TITLE, applyBridgeAction, type AiBridgeDeps, type BridgeAction } from '../lib/aibridge'
import { useConnection } from './connection'
import { releaseTab, useResults } from './results'
import { useSettings } from './settings'
import { useTabs } from './tabs'
import { desktop } from '../lib/desktop'

export { AI_TAB_TITLE, applyBridgeAction }

export function useAi() {
  const state = createState({ enabled: false, connected: false })
  let unsubscribe: (() => void) | null = null

  function deps(): AiBridgeDeps {
    const tabs = useTabs()
    const results = useResults()
    const conn = useConnection()
    return {
      connectionId: () => conn.state.id ?? null,
      connectionLabel: () => conn.state.label ?? '',
      tabs: () =>
        tabs.state.tabs.map((t) => ({
          key: t.key,
          kind: t.kind,
          title: t.title,
          readOnly: t.readOnly,
          content: t.content,
          connectionId: t.connectionId,
          aiMirror: t.aiMirror,
          agentOpened: t.agentOpened,
          dirty: tabs.isDirty(t),
        })),
      activeKey: () => tabs.state.activeKey,
      activateTab: (key) => tabs.activate(key),
      openSqlTab: (title, content, connectionId) => tabs.openSqlTab(title, content, connectionId, true),
      showAiLog: (sql) => tabs.showAiLog(sql),
      updateContent: (key, content) => tabs.updateContent(key, content),
      closeTab: (key) => {
        // The same cleanup as closing the tab in the UI (drop the result state
        // and close the backend session, rolling back an open transaction),
        // then remove the tab itself.
        releaseTab(key, conn.state.id)
        tabs.close(key)
      },
      showGrid: (tabKey, grid) => results.showGrid(tabKey, grid),
      insertAtCursor: (sql) => insertAtCursor(sql),
      activeResult: (tabKey) => {
        const r = results.state.byTab[tabKey]
        if (!r) return null
        return {
          running: r.running || r.loadingMore,
          transactionOpen: r.transactionOpen,
          selected: r.grid?.statementNumber ?? null,
          messages: r.messages.map((m) => ({ level: m.level, text: m.text })),
          grids: r.grids.map((g) => ({
            statement: g.statementNumber,
            columns: g.columns,
            columnTypes: g.columnTypes,
            rows: g.rows,
            rowCount: g.rowCount,
            truncated: g.truncated,
            limited: g.limited === true,
            totalRowCount: g.totalRowCount,
            exported: g.exported?.rows,
          })),
        }
      },
    }
  }

  async function onAction(data: string): Promise<void> {
    let action: BridgeAction
    try {
      action = JSON.parse(data) as BridgeAction
    } catch {
      return
    }
    let result: unknown = null
    let error: string | null = null
    try {
      result = await applyBridgeAction(deps(), action)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    await api.aiBridgeResult(action.id, result, error).catch(() => undefined)
  }

  async function start(): Promise<void> {
    if (unsubscribe) return
    const config = await api.aiConfig().catch(() => null)
    if (!config) return
    state.enabled = true
    void pushLimits()
    unsubscribe = desktop().subscribeAi((data) => void onAction(data), (connected) => { state.connected = connected })
  }

  /** Push the user's row/byte preference; the server default stands until then. */
  async function pushLimits(): Promise<void> {
    const settings = useSettings()
    await settings.ready.catch(() => undefined)
    await api
      .aiLimits({
        maxRows: settings.state.aiLimitRows,
        maxBytes: settings.state.aiLimitKb * 1024,
      })
      .catch(() => undefined)
  }

  function stop() { unsubscribe?.(); unsubscribe = null; state.connected = false }
  return { state, start, stop, pushLimits }
}
