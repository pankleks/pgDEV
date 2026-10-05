import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

test('close-time save waits for an in-flight session write and observes its failure', async (t) => {
  const original = globalThis.window
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original })
  let failWrite
  let startedWrite
  const started = new Promise((resolve) => { startedWrite = resolve })
  const pending = new Promise((_resolve, reject) => { failWrite = reject })
  globalThis.window = {
    setInterval: () => 0,
    addEventListener: () => {},
    pgdevDesktop: { storage: {
      load: async () => ({ settings: undefined, connections: undefined, pinnedFiles: [], warnings: [] }),
      write: async () => { startedWrite(); await pending; return { warnings: [] } },
    } },
  }
  const load = sourceLoader()
  const { useTabs } = await load('web/composables/tabs.ts')
  const tabs = useTabs()
  await tabs.sessionsReady
  tabs.newQuery()
  tabs.state.tabs[0].content = 'SELECT unsaved_work'
  const periodic = tabs.saveSession()
  await started
  let closeFinished = false
  const onClose = tabs.saveSession().finally(() => { closeFinished = true })
  const outcomes = Promise.allSettled([periodic, onClose])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeFinished, false, 'quit must not bypass the pending snapshot')
  failWrite(new Error('Disk full'))
  assert.deepEqual((await outcomes).map((outcome) => outcome.status), ['rejected', 'rejected'])
  globalThis.window.pgdevDesktop.storage.write = async () => ({ warnings: [] })
  await tabs.saveSession()
})
