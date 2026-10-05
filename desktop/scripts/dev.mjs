import { spawn } from 'node:child_process'
import electron from 'electron'
import { createServer } from 'vite'
import { resolve } from 'node:path'

const vite = await createServer({
  root: resolve('web'), configFile: resolve('web/vite.config.ts'),
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
await vite.listen()
vite.printUrls()
const env = { ...process.env, PGDEV_DESKTOP_DEV: '1' }
delete env.ELECTRON_RUN_AS_NODE
const desktop = spawn(electron, ['.'], { stdio: 'inherit', env })
let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  desktop.kill()
  await vite.close()
  process.exitCode = code
}
desktop.on('error', () => void stop(1))
desktop.on('exit', (code) => void stop(code ?? 1))
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
