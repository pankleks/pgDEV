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
  // The router decodes the path, so encoded spellings must not skip the guard.
  for (const url of ['/%61pi/ai/config', '/api/%61i/config', '/%2561pi/ai/config', '/api/ai/%63onfig']) {
    const r = await app.inject({ url, headers: { host: 'evil.example' } })
    assert.notEqual(r.statusCode, 200, url)
    assert.doesNotMatch(r.body, /token/, url)
  }
})

test('web-mode origin guard also covers percent-encoded API paths', async (t) => {
  const load = sourceLoader()
  const { createApp } = await load('server/app.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-auth-'))
  const app = await createApp({ serveStatic: false, aiTokenFile: join(directory, 'mcp-token') })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const r = await app.inject({ url: '/%61pi/ai/config', headers: { origin: 'http://evil.example' } })
  assert.equal(r.statusCode, 403)
})

test('the MCP identity route proves the endpoint secret without the desktop token', async (t) => {
  const load = sourceLoader()
  const { createApp } = await load('server/app.ts')
  const { identityProof } = await load('server/routes/ai.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-identity-'))
  const secret = 'b'.repeat(64)
  const app = await createApp({ serveStatic: false, desktopToken: 'desktop-secret', aiTokenFile: join(directory, 'mcp-token'), mcpEndpointSecret: secret })
  const plain = await createApp({ serveStatic: false, desktopToken: 'desktop-secret', aiTokenFile: join(directory, 'mcp-token') })
  t.after(async () => { await app.close(); await plain.close(); await rm(directory, { recursive: true, force: true }) })
  const challenge = 'c'.repeat(64)
  const ok = await app.inject({ method: 'POST', url: '/api/ai/identity', payload: { challenge } })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().proof, identityProof(secret, challenge))
  assert.doesNotMatch(ok.body, new RegExp(secret))
  for (const bad of ['short', 'z'.repeat(64), 42]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/ai/identity', payload: { challenge: bad } })).statusCode, 400)
  }
  // Exempting the identity route must not open anything else.
  assert.equal((await app.inject({ url: '/api/ai/config' })).statusCode, 401)
  // Without an endpoint secret (web mode) the route does not exist.
  assert.equal((await plain.inject({ method: 'POST', url: '/api/ai/identity', payload: { challenge } })).statusCode, 404)
})

test('requests naming a non-loopback host are refused (DNS rebinding)', async (t) => {
  const load = sourceLoader()
  const { createApp } = await load('server/app.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-host-'))
  const web = await createApp({ serveStatic: false, aiTokenFile: join(directory, 'mcp-token') })
  const desktop = await createApp({ serveStatic: false, desktopToken: 'desktop-secret', aiTokenFile: join(directory, 'mcp-token'), mcpEndpointSecret: 'd'.repeat(64) })
  t.after(async () => { await web.close(); await desktop.close(); await rm(directory, { recursive: true, force: true }) })

  // A rebinding page is "same-origin" with itself: Origin and Host agree.
  const rebound = { host: 'evil.example:3010', origin: 'http://evil.example:3010' }
  const before = await web.inject({ url: '/api/ai/config', headers: rebound })
  assert.equal(before.statusCode, 403)
  assert.doesNotMatch(before.body, /token/)
  for (const host of ['evil.example', '192.168.1.10:3010', 'localhost.evil.example', '127.0.0.1.nip.io']) {
    for (const app of [web, desktop]) {
      for (const [method, url] of [['GET', '/api/version'], ['POST', '/api/ai/tool/list_tabs'], ['POST', '/api/ai/identity'], ['GET', '/index.html']]) {
        const r = await app.inject({ method, url, headers: { host, authorization: 'Bearer desktop-secret' }, payload: method === 'POST' ? {} : undefined })
        assert.equal(r.statusCode, 403, `${host} ${method} ${url}`)
      }
    }
  }
  // Every loopback spelling still works.
  for (const host of ['localhost', 'localhost:3010', '127.0.0.1:3010', '[::1]:3010', 'app.localhost:5173']) {
    const r = await web.inject({ url: '/api/version', headers: { host, origin: `http://${host}` } })
    assert.equal(r.statusCode, 200, host)
  }
  assert.equal((await desktop.inject({ url: '/api/version', headers: { host: '127.0.0.1:41234', authorization: 'Bearer desktop-secret' } })).statusCode, 200)
})

test('rotating the MCP token invalidates the old one at once and needs the desktop token', async (t) => {
  const load = sourceLoader()
  const { createApp } = await load('server/app.ts')
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-rotate-'))
  const tokenFile = join(directory, 'mcp-token')
  const app = await createApp({ serveStatic: false, desktopToken: 'desktop-secret', aiTokenFile: tokenFile })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const desktop = { authorization: 'Bearer desktop-secret' }
  const old = (await app.inject({ url: '/api/ai/config', headers: desktop })).json().token
  const tool = (token) => app.inject({ method: 'POST', url: '/api/ai/tool/no_such_tool', headers: { authorization: `Bearer ${token}` }, payload: {} })
  assert.equal((await tool(old)).statusCode, 404, 'the current token is accepted (unknown tool past auth)')

  // Only the desktop renderer may rotate; an MCP client holding the token may not.
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/token/rotate', headers: { authorization: `Bearer ${old}` } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/token/rotate' })).statusCode, 401)

  const rotated = await app.inject({ method: 'POST', url: '/api/ai/token/rotate', headers: desktop })
  assert.equal(rotated.statusCode, 200)
  const next = rotated.json().token
  assert.notEqual(next, old)
  assert.match(rotated.json().config, new RegExp(next))
  assert.equal((await tool(old)).statusCode, 401, 'the old token stops working immediately')
  assert.equal((await tool(next)).statusCode, 404)
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), next, 'the new token survives a restart')
  assert.equal((await app.inject({ url: '/api/ai/config', headers: desktop })).json().token, next)
  assert.equal(validateRequest('POST', '/api/ai/token/rotate'), '/api/ai/token/rotate')
})
