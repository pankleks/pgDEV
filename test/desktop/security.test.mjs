import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAppUrl, validateRequest } from '../../desktop/security.mjs'
import { sourceLoader } from '../lib/load.mjs'

test('renderer origin and API routes have a narrow allowlist', () => {
  assert.equal(isAppUrl('pgdev://app/index.html'), true)
  assert.equal(isAppUrl('pgdev://evil/index.html'), false)
  assert.equal(isAppUrl('http://127.0.0.1:5173', true), true)
  assert.equal(isAppUrl('http://127.0.0.1:9999', true), false)
  assert.equal(validateRequest('GET', '/api/version'), '/api/version')
  assert.equal(validateRequest('GET', '/api/connections/abc/ddl?name=t'), '/api/connections/abc/ddl?name=t')
  for (const path of ['https://evil/api/version', '//evil/api/version', '/api/ai/tool/query', '/api/../other', '/api/version#fragment']) {
    assert.throws(() => validateRequest('GET', path), /Invalid|not allowed/)
  }
  assert.throws(() => validateRequest('POST', '/api/version'), /not allowed/)
})

test('desktop API requires its own token and MCP token cannot authorize it', async (t) => {
  const load = sourceLoader()
  const { createApp } = await load('server/app.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-auth-'))
  const app = await createApp({ serveStatic: false, desktopToken: 'desktop-secret', aiTokenFile: join(directory, 'mcp-token') })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await app.inject({ url: '/api/version', headers: { origin: 'http://localhost:3010' } })).statusCode, 401)
  const response = await app.inject({ url: '/api/ai/config', headers: { authorization: 'Bearer desktop-secret' } })
  assert.equal(response.statusCode, 200)
  const mcpToken = response.json().token
  assert.equal((await app.inject({ url: '/api/version', headers: { authorization: `Bearer ${mcpToken}` } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/tool/get_active_query', headers: { authorization: 'Bearer desktop-secret' }, payload: {} })).statusCode, 401)
})
