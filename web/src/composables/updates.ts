import { createState } from '../lib/state.svelte'
import { desktop } from '../lib/desktop'
import type { AvailableUpdate, UpdateCheck } from '../desktop'
import { useSettings } from './settings'

/** First automatic check shortly after startup, then once a day. */
const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 24 * 60 * 60 * 1000

const state = createState({
  current: '',
  /** False in development builds and tests (nothing is checked there). */
  enabled: true,
  update: null as AvailableUpdate | null,
  checking: false,
  /** Last manual check's failure; automatic checks fail silently. */
  error: '',
  /** A manual check shows its result even with automatic checks off. */
  manual: false,
  dialog: false,
})
let timer = 0
let started = false

async function run(force: boolean): Promise<UpdateCheck> {
  state.checking = true
  try {
    const result = await desktop().updates.check(force)
    state.current = result.current
    state.enabled = result.enabled
    state.update = result.update
    return result
  } finally {
    state.checking = false
  }
}

export function useUpdates() {
  const settings = useSettings()

  function schedule(delay: number) {
    window.clearTimeout(timer)
    timer = window.setTimeout(async () => {
      if (settings.state.checkUpdates) await run(false).catch(() => undefined)
      schedule(INTERVAL_MS)
    }, delay)
  }

  /** Begin automatic checks (idempotent). */
  function start() {
    if (started) return
    started = true
    schedule(FIRST_CHECK_MS)
  }

  function stop() {
    window.clearTimeout(timer)
    started = false
  }

  /** A forced check from Settings; failures are shown, not swallowed. */
  async function checkNow(): Promise<void> {
    state.error = ''
    state.manual = true
    try {
      await run(true)
    } catch (cause) {
      state.error = (cause as Error).message || 'The check failed'
    }
  }

  /** The update the top bar announces: not skipped, and checks are on (or
   * the user just checked by hand). */
  function announced(): AvailableUpdate | null {
    const update = state.update
    if (!update || update.version === settings.state.skippedUpdate) return null
    return settings.state.checkUpdates || state.manual ? update : null
  }

  function skip() {
    if (state.update) settings.setSkippedUpdate(state.update.version)
    state.dialog = false
  }

  function open(kind: 'release' | 'download') {
    return desktop().updates.open(kind)
  }

  return { state, start, stop, checkNow, announced, skip, open }
}
