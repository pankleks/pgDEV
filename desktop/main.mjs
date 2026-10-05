import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, safeStorage, shell, utilityProcess } from 'electron'
import { mkdir, appendFile, writeFile, rename, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createStorage } from './storage.mjs'
import { createFiles } from './files.mjs'
import { isAppUrl, validateRequest } from './security.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEV = !app.isPackaged && process.env.PGDEV_DESKTOP_DEV === '1'
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
app.setName('pgDEV')
// An opt-in data directory isolates development and packaged smoke tests.
if (process.env.PGDEV_DESKTOP_TEST_DATA) app.setPath('userData', resolve(process.env.PGDEV_DESKTOP_TEST_DATA))
protocol.registerSchemesAsPrivileged([{ scheme: 'pgdev', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

function utilityEnvironment(extra = {}) {
  const env = { ...process.env, PGDEV_APP_VERSION: version, ...extra }
  // Runtime/debug injection is not an application feature.
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  // Do not await ready at ESM top level: Electron waits for module evaluation
  // before emitting ready, which would deadlock application startup.
  void app.whenReady().then(runDesktop).catch(async (error) => {
    if (!app.isPackaged) console.error('pgDEV startup failed:', error)
    await dialog.showMessageBox({ type: 'error', title: 'pgDEV startup failed', message: 'pgDEV could not start. Check the application data directory and try again.' })
    app.exit(1)
  })
}

async function runDesktop() {
  const directory = app.getPath('userData')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const log = (message) => appendFile(join(directory, 'desktop.log'), `${new Date().toISOString()} ${message}\n`).catch(() => undefined)
  const storage = createStorage(join(directory, 'state'), safeStorage)
  let window
  let closing = false
  let stopped = false
  let aiController
  let aiTask
  let closeTimer
  const files = createFiles(dialog, () => window)
  const stored = await storage.load()
  for (const pin of stored.pinnedFiles) files.grant(pin?.handle?.path)
  for (const tab of stored.session?.tabs ?? []) files.grant(tab?.filePath)

  const token = randomBytes(32).toString('hex')
  const endpointFile = join(directory, 'mcp-endpoint.json')
  const child = utilityProcess.fork(join(ROOT, 'desktop/generated/backend.mjs'), [], {
    env: utilityEnvironment({
      PGDEV_DESKTOP_TOKEN: token,
      PGDEV_TOKEN_FILE: join(directory, 'mcp-token'),
      PGDEV_MCP_ENDPOINT_FILE: endpointFile,
      PGDEV_MCP_COMMAND: JSON.stringify([join(app.isPackaged ? process.resourcesPath : join(ROOT, 'desktop/generated'), ...(app.isPackaged ? ['helpers'] : []), `pgdev-mcp${process.platform === 'win32' ? '.exe' : ''}`)]),
    }),
    stdio: 'pipe', serviceName: 'pgDEV Database Service',
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', (chunk) => {
    if (!app.isPackaged && process.env.PGDEV_DESKTOP_TEST_DATA) process.stderr.write(chunk)
    void log('Database service reported an error (details redacted).')
  })
  let backendUrl
  try {
    backendUrl = await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Backend startup timed out')) }, 15000)
      const fail = () => { clearTimeout(timeout); reject(new Error('Backend startup failed')) }
      const message = (data) => {
        if (data?.type === 'failed') fail()
        if (data?.type !== 'ready') return
        const url = new URL(data.url)
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return fail()
        clearTimeout(timeout)
        child.removeListener('exit', fail)
        child.removeListener('message', message)
        resolveReady(url.origin)
      }
      child.once('exit', fail)
      child.on('message', message)
    })
  } catch (error) { child.kill(); throw error }
  const endpointTemporary = `${endpointFile}.${randomBytes(8).toString('hex')}.tmp`
  await writeFile(endpointTemporary, JSON.stringify({ url: backendUrl }), { mode: 0o600, flag: 'wx' })
  await rename(endpointTemporary, endpointFile)

  const backendFetch = (path, options = {}) => fetch(`${backendUrl}${path}`, {
    ...options, redirect: 'error', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  })

  child.on('exit', () => {
    if (stopped) return
    void log('Database service exited unexpectedly. Queries will not be replayed.')
    window?.webContents.send('pgdev:backend-failed')
    if (!closing) void dialog.showMessageBox(window, {
      type: 'error', title: 'Database service stopped',
      message: 'The database service stopped. Save your work and restart pgDEV. Open database transactions have ended.',
    })
  })

  const assets = resolve(ROOT, 'web/dist')
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'"
  protocol.handle('pgdev', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 403 })
      const path = resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`)
      if (relative(assets, path).startsWith('..') || path === assets) return new Response(null, { status: 403 })
      const response = await net.fetch(pathToFileURL(path).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', CSP)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch { return new Response('Not found', { status: 404 }) }
  })

  window = new BrowserWindow({
    title: 'pgDEV', width: 1440, height: 950, minWidth: 800, minHeight: 550,
    icon: join(ROOT, 'pgDEV.png'),
    backgroundColor: '#1e1e1e', show: false,
    webPreferences: {
      preload: join(ROOT, 'desktop/preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true,
    },
  })
  const session = window.webContents.session
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  // Native state owns persistence; no WebView IndexedDB or cookies are needed.
  await session.clearStorageData({ storages: ['indexdb', 'localstorage', 'cookies', 'serviceworkers', 'cachestorage'] })
  const openProject = (value) => {
    if (value === 'https://github.com/pankleks/pgdev') void shell.openExternal(value)
  }
  window.webContents.setWindowOpenHandler(({ url }) => { openProject(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, DEV)) { event.preventDefault(); openProject(url) }
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', () => {
    void log('Renderer exited unexpectedly. Last persisted session remains available.')
    void stop().then(() => app.exit(1))
  })
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.show(); window.focus() })

  const handle = (channel, operation) => ipcMain.handle(`pgdev:${channel}`, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url, DEV)) {
      throw new Error('Untrusted desktop request')
    }
    return operation(...args)
  })
  handle('request', async (method, path, body) => {
    const route = validateRequest(method, path, body)
    const response = await backendFetch(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  })
  handle('storage-load', () => storage.load())
  handle('storage-write', async (kind, value) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024 * 1024) throw new Error('Storage record is too large')
    // File references can only originate from a native file dialog or trusted storage.
    if (kind === 'pinnedFiles') for (const pin of value) if (pin.handle) files.authorize(pin.handle)
    if (kind === 'session') for (const tab of value.tabs) if (tab.filePath) files.authorize({ path: tab.filePath })
    const result = await storage.write(kind, value)
    for (const warning of result.warnings) window.webContents.send('pgdev:storage-warning', warning)
    return result
  })
  handle('files-open', () => files.pickOpen())
  handle('files-read', (file) => files.read(file))
  handle('files-begin', (options) => files.begin(options))
  handle('files-write', (id, text) => files.write(id, text))
  handle('files-finish', (id, commit) => {
    if (typeof commit !== 'boolean') throw new Error('Invalid output operation')
    return files.finish(id, commit)
  })
  handle('clipboard', (text) => {
    if (typeof text !== 'string' || text.length > 32 * 1024 * 1024) throw new Error('Clipboard text is too large')
    clipboard.writeText(text)
  })
  handle('confirm', async (message) => {
    if (typeof message !== 'string' || message.length > 4096) throw new Error('Invalid confirmation')
    const result = await dialog.showMessageBox(window, { type: 'question', title: 'pgDEV', message, buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true })
    return result.response === 1
  })

  async function subscribeAi() {
    if (aiController) return
    aiController = new AbortController()
    const controller = aiController
    aiTask = (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await backendFetch('/api/ai/bridge', { signal: controller.signal })
          if (!response.ok || !response.body) throw new Error('Bridge unavailable')
          window.webContents.send('pgdev:ai-status', true)
          let pending = ''
          for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
            pending += chunk.replace(/\r\n/g, '\n')
            let end
            while ((end = pending.indexOf('\n\n')) !== -1) {
              const event = pending.slice(0, end)
              pending = pending.slice(end + 2)
              const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
              if (data && !window.isDestroyed()) window.webContents.send('pgdev:ai-message', data)
            }
            if (pending.length > 8 * 1024 * 1024) throw new Error('Bridge event too large')
          }
        } catch { /* Reconnect without replaying database work. */ }
        if (!window.isDestroyed()) window.webContents.send('pgdev:ai-status', false)
        if (!controller.signal.aborted) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
      }
    })()
  }
  handle('ai-start', subscribeAi)
  handle('ai-stop', async () => { aiController?.abort(); await aiTask; aiController = undefined })

  async function stop() {
    if (stopped) return
    stopped = true
    const hardStop = setTimeout(() => { child.kill(); app.exit(1) }, 10000)
    aiController?.abort()
    clearTimeout(closeTimer)
    await files.abortAll()
    await storage.flush()
    await new Promise((resolveStopped) => {
      const timeout = setTimeout(() => { child.kill(); resolveStopped() }, 6000)
      child.once('exit', () => { clearTimeout(timeout); resolveStopped() })
      if (!child.pid) { clearTimeout(timeout); resolveStopped() }
      else child.postMessage({ type: 'shutdown' })
    })
    clearTimeout(hardStop)
    await rm(endpointFile, { force: true }).catch(() => undefined)
  }

  handle('close-ready', async () => { if (!closing) return; await stop(); app.exit(0) })
  handle('close-failed', () => { closing = false; clearTimeout(closeTimer) })
  function requestClose(event) {
    if (stopped) return
    event.preventDefault()
    if (closing) return
    closing = true
    window.webContents.send('pgdev:before-close')
    closeTimer = setTimeout(() => {
      closing = false
      void dialog.showMessageBox(window, { type: 'error', message: 'Could not save the session before closing. Save your SQL files and try again.' })
    }, 120000)
  }
  window.on('close', requestClose)
  app.on('before-quit', requestClose)
  app.on('activate', () => { window.show(); window.focus() })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, ...(DEV ? [{ role: 'toggleDevTools' }] : [])] },
    { label: 'Help', submenu: [{ label: 'pgDEV on GitHub', click: () => openProject('https://github.com/pankleks/pgdev') }] },
  ]))
  await window.loadURL(DEV ? 'http://127.0.0.1:5173' : 'pgdev://app/index.html')
  window.show()
  void log(`pgDEV ${version} started.`)
}
