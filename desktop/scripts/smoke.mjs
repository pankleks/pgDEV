import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

try { process.loadEnvFile() } catch {}
const directory = await mkdtemp(join(tmpdir(), 'pgdev-desktop-smoke-'))
const env = { ...process.env, PGDEV_DESKTOP_TEST_DATA: directory }
delete env.ELECTRON_RUN_AS_NODE
delete env.PGDEV_DESKTOP_DEV
const executablePath = process.env.PGDEV_DESKTOP_EXECUTABLE || electronPath
const args = process.env.PGDEV_DESKTOP_EXECUTABLE ? [] : ['.']
let application
let helper
const errors = []
try {
  application = await electron.launch({ executablePath, args, env, timeout: 30000 })
  application.process().stderr?.on('data', (chunk) => process.stderr.write(chunk))
  const dialogs = []
  application.process().stdout?.on('data', (chunk) => dialogs.push(chunk.toString()))
  // Replace native dialogs from the test driver, never from application code.
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => { console.log('PGDEV_SMOKE_DIALOG'); return { response: 1 } }
  })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.monaco-editor').waitFor({ timeout: 30000 })
  await page.waitForFunction(() => document.querySelectorAll('.tabstrip .tab').length > 0)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.pgdevDesktop), 'object')
  const version = await page.evaluate(() => window.pgdevDesktop.request('GET', '/api/version'))
  assert.equal(version.status, 200)
  assert.equal(version.body.version, JSON.parse(await readFile('package.json', 'utf8')).version)
  await assert.rejects(page.evaluate(() => window.pgdevDesktop.request('GET', 'https://example.com/api/version')), /Invalid/)
  await assert.rejects(page.evaluate(() => window.pgdevDesktop.files.read({ name: 'outside', path: '/outside' })), /not granted/)

  const config = await page.evaluate(() => window.pgdevDesktop.request('GET', '/api/ai/config'))
  const mcp = JSON.parse(config.body.config).mcp.pgdev
  const backendAddress = config.body.url
  const unauthorized = await fetch(`${backendAddress}/api/version`)
  assert.equal(unauthorized.status, 401)
  // A real MCP client launches the standalone packaged stdio helper.
  helper = spawn(mcp.command[0], mcp.command.slice(1), { env: { ...env, ...mcp.environment }, stdio: ['pipe', 'pipe', 'pipe'] })
  helper.stderr.on('data', () => {})
  const initialized = new Promise((resolve, reject) => {
    let pending = ''
    const timeout = setTimeout(() => reject(new Error('Packaged MCP initialize timed out')), 20000)
    helper.stdout.on('data', (chunk) => {
      pending += chunk.toString()
      for (;;) {
        const end = pending.indexOf('\n')
        if (end === -1) break
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        try { const message = JSON.parse(line); if (message.id === 1) { clearTimeout(timeout); resolve(message) } } catch {}
      }
    })
    helper.on('error', (error) => { clearTimeout(timeout); reject(error) })
    helper.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`MCP exited before initialization: ${code}`)) })
  })
  helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-smoke', version: '1' } } }) + '\n')
  assert.ok((await initialized).result.serverInfo)
  helper.stdin.end()

  if (process.env.PGDEV_TEST_URL) {
    await page.getByRole('button', { name: 'Not connected', exact: true }).click()
    await page.getByRole('tab', { name: 'Connection string' }).click()
    await page.locator('input[placeholder="postgres://user:pass@host:5432/db"]').fill(process.env.PGDEV_TEST_URL)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.locator('.conn-badge:not(.off)').waitFor({ timeout: 30000 })
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.insertText('SELECT 42 AS desktop_smoke')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await page.getByRole('button', { name: 'Result 1', exact: true }).waitFor({ timeout: 30000 })
    assert.ok((await page.locator('.results').innerText()).includes('42'))
  } else console.log('Database smoke skipped: PGDEV_TEST_URL is unset.')

  // Persist a recognizable editor session through the UI and exercise real close.
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText('SELECT 73 AS persisted_desktop_session')
  const closed = application.waitForEvent('close', { timeout: 15000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  assert.equal(dialogs.join('').includes('PGDEV_SMOKE_DIALOG'), false, 'idle quit with unsaved text must save silently, without confirmation')
  application = undefined
  const snapshot = JSON.parse(await readFile(join(directory, 'state/session.json'), 'utf8'))
  assert.ok(snapshot.value.tabs.some((tab) => tab.content.includes('persisted_desktop_session')))
  await assert.rejects(fetch(`${backendAddress}/api/version`), 'backend must exit with its window')
  // Relaunch against the same native data and verify session/config continuity.
  application = await electron.launch({ executablePath, args, env, timeout: 30000 })
  application.process().stdout?.on('data', (chunk) => dialogs.push(chunk.toString()))
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => { console.log('PGDEV_SMOKE_DIALOG'); return { response: 1 } }
  })
  const reopened = await application.firstWindow()
  await reopened.locator('.monaco-editor').waitFor({ timeout: 30000 })
  await reopened.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent?.includes('persisted_desktop_session'))
  const next = await reopened.evaluate(() => window.pgdevDesktop.request('GET', '/api/ai/config'))
  const nextMcp = JSON.parse(next.body.config).mcp.pgdev
  assert.deepEqual(nextMcp, mcp, 'MCP configuration stays valid across dynamic-port restarts')
  const nextClosed = application.waitForEvent('close', { timeout: 15000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await nextClosed
  assert.equal(dialogs.join('').includes('PGDEV_SMOKE_DIALOG'), false, 'unchanged restored editor tabs must not prompt on quit')
  application = undefined
  assert.deepEqual(errors, [])
  console.log('Desktop smoke passed: sandbox, Monaco, API authentication, MCP, session restart and shutdown.')
} finally {
  helper?.kill()
  await application?.close().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
