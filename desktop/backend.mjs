import { createApp } from '../server/src/app.js'
import { connectionIds, removePool } from '../server/src/pools.js'
import { cancelConnection } from '../server/src/queryexec.js'
import { closeSessionsForConnection } from '../server/src/sessions.js'

const parent = process.parentPort
if (!parent) throw new Error('The desktop backend must run in an Electron utility process')
let app
let stopping = false

async function shutdown() {
  if (stopping) return
  stopping = true
  const timeout = setTimeout(() => process.exit(1), 5000)
  await Promise.all(connectionIds().map(async (id) => {
    cancelConnection(id)
    await closeSessionsForConnection(id)
    await removePool(id)
  }))
  // SSE connections are closed by terminating the process after DB cleanup.
  parent.postMessage({ type: 'stopped' })
  clearTimeout(timeout)
  process.exit(0)
}

parent.on('message', ({ data }) => {
  if (data?.type === 'shutdown') void shutdown().catch(() => process.exit(1))
})
parent.on('close', () => void shutdown())

try {
  app = await createApp({
    serveStatic: false,
    aiTokenFile: process.env.PGDEV_TOKEN_FILE,
    desktopToken: process.env.PGDEV_DESKTOP_TOKEN,
    mcpCommand: JSON.parse(process.env.PGDEV_MCP_COMMAND),
    mcpEndpointFile: process.env.PGDEV_MCP_ENDPOINT_FILE,
  })
  const url = await app.listen({ port: 0, host: '127.0.0.1' })
  parent.postMessage({ type: 'ready', url })
} catch (error) {
  if (process.env.PGDEV_DESKTOP_DEV === '1') console.error(error)
  // Never forward diagnostics containing connection strings to the renderer.
  parent.postMessage({ type: 'failed', message: 'The database service could not start.' })
  process.exit(1)
}
