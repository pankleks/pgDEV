import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { createHmac, randomBytes } from 'node:crypto'

// The MCP shim is behaviour, not internals: a stub pgDEV API records what the
// shim forwards, and a JSON-RPC conversation over stdio pins the agent-visible
// contract (tool names, argument forwarding, token, error surfaces).

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SHIM = join(REPO, 'bin', 'pgdev-mcp.mjs')

const SECRET = 'a'.repeat(64)

/** `identitySecret` makes the stub a genuine pgDEV that can answer the
 * shim's identity challenge; without it the stub is an impostor. */
async function stubApi({ identitySecret } = {}) {
  const requests = []
  let status = 200
  let closed = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        parsed = {}
      }
      requests.push({ url: req.url, auth: req.headers.authorization, body: parsed })
      if (identitySecret && req.url === '/api/ai/identity') {
        const proof = createHmac('sha256', identitySecret).update(`pgdev-mcp-identity:${parsed.challenge}`).digest('hex')
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ proof }))
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          status === 200
            ? { ok: true, result: { tool: req.url.split('/').pop(), args: parsed } }
            : { error: 'stub failure' },
        ),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    setStatus: (value) => {
      status = value
    },
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

function startShim(env) {
  const child = spawn(process.execPath, [SHIM], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const settle = pending.get(message.id)
      if (settle) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })
  let nextId = 1
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  return {
    child,
    rpc,
    notify,
    stop: () => {
      child.stdin.end()
      child.kill('SIGKILL')
    },
  }
}

async function handshake(shim) {
  const init = await shim.rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'pgdev-test', version: '0' },
  })
  assert.equal(init.result.serverInfo.name, 'pgdev')
  // The agent is told what it may run and where authored writes/DDL go.
  assert.match(init.result.instructions ?? '', /read-only/)
  assert.match(init.result.instructions ?? '', /set_active_query.*open_query_tab/s)
  assert.match(init.result.instructions ?? '', /never executes staged SQL/)
  assert.match(init.result.instructions ?? '', /get_active_result/)
  assert.match(init.result.instructions ?? '', /list_tabs/)
  shim.notify('notifications/initialized')
  return init
}

for (const scenario of ['endpoint removed', 'desktop replaced', 'desktop crashed']) {
  test(`desktop MCP helper exits with stdin open when ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pgdev-mcp-lifecycle-'))
    const file = join(directory, 'endpoint.json')
    let owner
    let shim
    try {
      let pid = process.pid
      if (scenario === 'desktop crashed') {
        owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        await once(owner, 'spawn')
        pid = owner.pid
      }
      await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:3010', pid, secret: SECRET }))
      shim = startShim({ PGDEV_ENDPOINT_FILE: file })
      await handshake(shim)
      const exited = once(shim.child, 'exit', { signal: AbortSignal.timeout(5000) })
      if (scenario === 'endpoint removed') await rm(file)
      else if (scenario === 'desktop replaced') await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:3011', pid: 0, secret: SECRET }))
      else {
        const ownerExited = once(owner, 'exit')
        owner.kill('SIGKILL')
        await ownerExited
      }
      const [code, signal] = await exited
      assert.equal(code, 0)
      assert.equal(signal, null)
      assert.equal(shim.child.stdin.writableEnded, false)
    } finally {
      shim?.stop()
      owner?.kill()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('the shim lists the tools and forwards calls with the token', async () => {
  const api = await stubApi()
  const shim = startShim({ PGDEV_URL: api.url, PGDEV_TOKEN: 'test-token' })
  try {
    await handshake(shim)
    const list = await shim.rpc('tools/list', {})
    const names = list.result.tools.map((t) => t.name)
    assert.deepEqual(names.sort(), [
      'activate_tab',
      'close_tab',
      'get_active_query',
      'get_active_result',
      'get_ddl',
      'get_schema',
      'list_tabs',
      'open_query_tab',
      'query',
      'set_active_query',
    ])
    // Every tool advertises a JSON schema the agent can read.
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', tool.name)
    }
    // Connections are not part of the agent's surface, not even as a resource.
    const resources = await shim.rpc('resources/list', {})
    assert.deepEqual(resources.result.resources.map((r) => r.uri), ['pgdev://active-tab'])

    const call = await shim.rpc('tools/call', {
      name: 'get_schema',
      arguments: { table: 'items' },
    })
    const payload = JSON.parse(call.result.content[0].text)
    assert.deepEqual(payload, { tool: 'get_schema', args: { table: 'items' } })
    assert.equal(api.requests[0].auth, 'Bearer test-token')
    assert.equal(api.requests[0].url, '/api/ai/tool/get_schema')
  } finally {
    shim.stop()
    await api.close()
  }
})

test('a refused or unreachable pgDEV becomes a tool error, not a crash', async () => {
  const api = await stubApi()
  const shim = startShim({ PGDEV_URL: api.url, PGDEV_TOKEN: 'bad-token' })
  try {
    await handshake(shim)
    api.setStatus(401)
    const refused = await shim.rpc('tools/call', { name: 'query', arguments: { sql: 'SELECT 1' } })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /token/)

    await api.close()
    const down = await shim.rpc('tools/call', { name: 'query', arguments: { sql: 'SELECT 1' } })
    assert.equal(down.result.isError, true)
    assert.match(down.result.content[0].text, /Cannot reach pgDEV/)

    const again = await shim.rpc('tools/list', {})
    assert.ok(again.result.tools.length > 0)
  } finally {
    shim.stop()
    await api.close()
  }
})

test('invalid arguments and unknown tools are protocol errors', async () => {
  const api = await stubApi()
  const shim = startShim({ PGDEV_URL: api.url, PGDEV_TOKEN: 't' })
  try {
    await handshake(shim)
    // get_ddl requires schema and name.
    const invalid = await shim.rpc('tools/call', { name: 'get_ddl', arguments: { type: 'table' } })
    assert.ok(invalid.error || invalid.result?.isError, JSON.stringify(invalid))

    const unknown = await shim.rpc('tools/call', { name: 'nope', arguments: {} })
    assert.ok(unknown.error || unknown.result?.isError, JSON.stringify(unknown))
  } finally {
    shim.stop()
    await api.close()
  }
})

for (const genuine of [true, false]) {
  test(`a desktop endpoint ${genuine ? 'that proves its identity receives the token' : 'held by an impostor never sees the token'}`, async () => {
    // After a crash the endpoint file outlives the desktop, and another local
    // process may bind its port. The shim challenges before sending the token.
    const secret = randomBytes(32).toString('hex')
    const api = await stubApi(genuine ? { identitySecret: secret } : {})
    const directory = await mkdtemp(join(tmpdir(), 'pgdev-mcp-identity-'))
    const file = join(directory, 'endpoint.json')
    await writeFile(file, JSON.stringify({ url: api.url, pid: process.pid, secret }))
    const shim = startShim({ PGDEV_ENDPOINT_FILE: file, PGDEV_TOKEN: 'secret-token' })
    try {
      await handshake(shim)
      const call = await shim.rpc('tools/call', { name: 'get_schema', arguments: {} })
      const withToken = api.requests.filter((r) => r.auth)
      if (genuine) {
        assert.equal(call.result.isError, undefined, JSON.stringify(call.result))
        assert.deepEqual(withToken.map((r) => r.url), ['/api/ai/tool/get_schema'])
        assert.equal(withToken[0].auth, 'Bearer secret-token')
      } else {
        assert.equal(call.result.isError, true)
        assert.match(call.result.content[0].text, /Cannot find the running pgDEV/)
        assert.deepEqual(withToken, [], 'the token never left the shim')
        assert.deepEqual(api.requests.map((r) => r.url), ['/api/ai/identity'])
      }
    } finally {
      shim.stop()
      await api.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
