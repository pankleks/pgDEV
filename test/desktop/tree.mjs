// Real Electron/Svelte interaction regression, with a synthetic catalog (no DB).
import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import { createServer } from 'vite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(message)
}
const checkOpen = (caret, open) => until(async () => /\bopen\b/.test(await caret.getAttribute('class')) === open, `Expected caret open=${open}`)
const checkCount = (locator, count) => until(async () => await locator.count() === count, `Expected ${count} tree nodes`)

const directory = await mkdtemp(join(tmpdir(), 'pgdev-tree-'))
const vite = await createServer({ root: resolve('web'), configFile: resolve('web/vite.config.ts'), server: { host: '127.0.0.1', port: 5173, strictPort: true } })
let application
try {
  await vite.listen()
  const env = { ...process.env, PGDEV_DESKTOP_DEV: '1', PGDEV_DESKTOP_TEST_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  application = await electron.launch({ executablePath: electronPath, args: ['.'], env })
  await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }) })
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.monaco-editor').waitFor()
  await page.evaluate(async () => {
    const { api } = await import('/src/api.ts')
    const { useConnection } = await import('/src/composables/connection.ts')
    const { useSchema } = await import('/src/composables/schema.ts')
    const { useSettings } = await import('/src/composables/settings.ts')
    const { tick } = await import('/@id/svelte')
    const column = { name: 'id', type: 'integer', nullable: false, defaultValue: null }
    const catalog = { tables: [], views: [], functions: [], types: [], sequences: [] }
    for (let i = 1; i <= 2; i++) {
      const base = { schema: 'public', oid: String(i) }
      catalog.tables.push({ ...base, name: `probe_table_${i}`, columns: [column], indexes: [{ name: 'probe_idx', type: 'normal', method: 'btree' }], constraints: [{ name: 'probe_pk', type: 'p', definition: 'PRIMARY KEY (id)' }], triggers: [{ name: 'probe_trigger', definition: '' }], isPartition: false, isPartitioned: false, parents: '', relkind: 'r' })
      catalog.views.push({ ...base, name: `probe_view_${i}`, columns: [column], materialized: false })
      catalog.functions.push({ ...base, name: `probe_function_${i}`, args: 'value integer', returns: 'integer', typeSig: 'integer', kind: 'function' })
      catalog.types.push({ ...base, name: `probe_type_${i}`, kind: 'enum', detail: "'one', 'two'" })
      catalog.sequences.push({ ...base, name: `probe_sequence_${i}`, dataType: 'bigint', detail: 'increment 1' })
    }
    api.schema = async () => catalog
    window.treeDdlCalls = 0
    api.ddl = async () => { window.treeDdlCalls++; return { ddl: '-- tree fixture' } }
    useSettings().state.groupObjects = false
    const connection = useConnection()
    connection.state.label = 'tree-fixture'
    connection.state.id = 'tree-fixture'
    await tick()
    useSchema().state.data = catalog
    await tick()
  })

  const sections = ['Tables', 'Views', 'Types', 'Functions', 'Sequences']
  for (const title of sections) {
    const section = page.locator('.browser-main section.group').filter({ has: page.locator('h3', { hasText: title }) })
    const header = section.locator('h3')
    await header.locator('svg').click()
    await checkCount(section.locator('.tree'), 2)
    await header.locator('svg').click()
    await checkCount(section.locator('.tree'), 0)
    await header.click()
  }

  async function checkToggle(row) {
    const caret = row.locator(':scope > .caret')
    await checkOpen(caret, false)
    await caret.locator('svg').click()
    await checkOpen(caret, true)
    await caret.locator('svg').click()
    await checkOpen(caret, false)
    await row.locator(':scope > .obj-name').click()
    await checkOpen(caret, true)
    await row.locator(':scope > .obj-icon').click()
    await checkOpen(caret, false)
  }

  for (const search of ['', 'probe']) {
    await page.locator('.browser-search input').fill(search)
    for (const kind of ['table', 'view', 'type', 'function', 'sequence']) {
      const row = page.locator('.tree > .node').filter({ has: page.getByText(`probe_${kind}_1`, { exact: true }) })
      await checkToggle(row)
      if (kind === 'table') {
        await row.locator('.caret svg').click()
        for (const category of ['Columns', 'Indexes', 'Constraints', 'Triggers']) {
          const child = page.locator('.node.cat').filter({ has: page.getByText(category, { exact: true }) })
          await checkToggle(child)
        }
        await row.locator('.caret svg').click()
      }
    }
  }

  await page.locator('.browser-search input').fill('')
  const table = page.locator('.tree > .node').filter({ has: page.getByText('probe_table_1', { exact: true }) })
  await table.locator('.obj-name').dblclick()
  await until(async () => await page.evaluate(() => window.treeDdlCalls) === 1, 'Double-click must open DDL exactly once')
  await checkOpen(table.locator('.caret'), false)

  await page.evaluate(async () => { const { useSettings } = await import('/src/composables/settings.ts'); useSettings().state.groupObjects = true })
  for (const title of sections) {
    const section = page.locator('.browser-main section.group').filter({ has: page.locator('h3', { hasText: title }) })
    await checkToggle(section.locator('.object-group-node').first())
  }
   // Restored bindings contain an expired session ID, not proof of a different
   // database. Keep the execution guard but do not misreport database identity.
   await page.evaluate(async () => {
     const { useTabs } = await import('/src/composables/tabs.ts')
     const tabs = useTabs()
     await tabs.openDdl('table', 'public', 'restart_probe', 'SELECT 1;', '', true, '', 'tree-fixture')
     tabs.state.tabs.find((tab) => tab.key === tabs.state.activeKey).content = 'SELECT 2;'
     await tabs.saveSession()
   })
   await page.reload()
   await page.locator('.monaco-editor').waitFor()
   await page.evaluate(async () => {
     const { useConnection } = await import('/src/composables/connection.ts')
     const { api } = await import('/src/api.ts')
     useConnection().state.label = 'tree-fixture'
     useConnection().state.id = 'tree-fixture-after-restart'
     window.restartQueryCalls = 0
     api.query = async () => { window.restartQueryCalls++; throw new Error('Expired binding must not run') }
   })
   await page.locator('.stale-ddl').waitFor()
   const warning = await page.locator('.stale-ddl').innerText()
   assert.ok(warning.includes('even for the same database'))
   assert.ok(!warning.includes('different database'))
   await page.locator('.monaco-editor textarea').focus()
   await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
   await page.locator('.toast').filter({ hasText: 'including after an app restart' }).waitFor()
   assert.equal(await page.evaluate(() => window.restartQueryCalls), 0)
   assert.deepEqual(errors, [])
  console.log('Tree interactions passed: section/group arrows, all object types and table categories, filtered/unfiltered, names/icons and DDL double-click.')
} finally {
  await application?.close().catch(() => undefined)
  await vite.close()
  await rm(directory, { recursive: true, force: true })
}
