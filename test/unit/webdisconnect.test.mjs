import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { api } = await load('web/api.ts')

// A failed DELETE must surface: the connection composable keeps UI state and
// toasts instead of phantom-clearing to "not connected".

function stubRequest(status, body = {}) {
  globalThis.window = { pgdevDesktop: { request: async () => ({ status, body }) } }
}

test('disconnect surfaces the server result', async (t) => {
  const original = globalThis.window
  t.after(() => { if (original === undefined) delete globalThis.window; else globalThis.window = original })
  for (const [status, body, wantThrow] of [
    [200, {}, false],
    [500, { error: 'boom' }, true],
  ]) {
    stubRequest(status, body)
    if (wantThrow) await assert.rejects(api.disconnect('conn-1'), /boom/)
    else await api.disconnect('conn-1')
  }
})
