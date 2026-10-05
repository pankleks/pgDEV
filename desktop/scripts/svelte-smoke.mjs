import { _electron as electron } from 'playwright'
import electronPath from 'electron'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Exercises the actual sandboxed renderer and native settings persistence.
// Database rows below are synthetic: this test never dials a database.
const directory = await mkdtemp(join(process.env.PGDEV_SMOKE_TEMP ?? tmpdir(), 'pgdev-svelte-smoke-'))
const env = { ...process.env, PGDEV_DESKTOP_TEST_DATA: directory }
delete env.ELECTRON_RUN_AS_NODE
delete env.PGDEV_DESKTOP_DEV
let application
const errors = []
const monacoDisposalCancellations = []
try {
  application = await electron.launch({
    executablePath: process.env.PGDEV_DESKTOP_EXECUTABLE || electronPath,
    args: process.env.PGDEV_DESKTOP_EXECUTABLE ? [] : ['.'], env, timeout: 30000,
  })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => {
    // Monaco 0.52.x WordHighlighter disposes a Delayer without catching its
    // cancellation (upstream #4702). Only recognize that disposal stack, never
    // ignore arbitrary Canceled errors or application exceptions.
    const stack = error.stack ?? ''
    if (error.name === 'Canceled' && error.message === 'Canceled' &&
      /at \S+\.cancel \(pgdev:\/\/app\/assets\//.test(stack) &&
      /at \S+\.dispose \(pgdev:\/\/app\/assets\//.test(stack) &&
      /at \S+\._deliver \(pgdev:\/\/app\/assets\//.test(stack)) {
      monacoDisposalCancellations.push(stack)
    } else errors.push(stack || error.message)
  })
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} (${JSON.stringify(message.location())})`) })
  await page.locator('[data-renderer="svelte-5"] .monaco-editor').waitFor({ timeout: 30000 })

  await page.getByTitle('Settings', { exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const font = settings.locator('.stepper').nth(0)
  const initialFont = Number(await font.locator('input').inputValue())
  await font.getByTitle('Increase by 1', { exact: true }).click()
  await page.waitForFunction((value) => document.querySelector('.settings-modal .stepper-input')?.value === String(value), initialFont + 1)
  const group = settings.getByRole('switch', { name: 'Group objects', exact: true })
  const initialGroup = await group.getAttribute('aria-checked')
  await group.click()
  assert.notEqual(await group.getAttribute('aria-checked'), initialGroup)
  await settings.getByTitle('Close', { exact: true }).click()
  await settings.waitFor({ state: 'detached' })
  await page.getByTitle('Settings', { exact: true }).click()
  assert.equal(await font.locator('input').inputValue(), String(initialFont + 1))
  assert.notEqual(await group.getAttribute('aria-checked'), initialGroup)
  await font.locator('input').fill('100')
  await settings.getByRole('heading', { name: 'Settings', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.settings-modal .stepper-input')?.value === '32')
  await settings.getByTitle('Restore every setting to its default', { exact: true }).click()
  await page.waitForFunction((value) => document.querySelector('.settings-modal .stepper-input')?.value === String(value), initialFont)
  await settings.getByTitle('Close', { exact: true }).click()

  // Replace the API handler only in the Electron test driver, never in the app.
  const json = '{"large":900719925474099312345,"text":"<script>not markup</script>"}'
  await application.evaluate(({ ipcMain, dialog }, value) => {
    globalThis.__pgdevSvelteFixture = {
      requests: [], confirm: false, rejectUpdate: true, tableLoadError: false,
      tableSubmitError: false, tableDdl: null,
    }
    dialog.showMessageBox = async () => ({ response: globalThis.__pgdevSvelteFixture.confirm ? 1 : 0, checkboxChecked: false })
    ipcMain.removeHandler('pgdev:request')
    ipcMain.handle('pgdev:request', (_event, method, path, body) => {
      globalThis.__pgdevSvelteFixture.requests.push({ method, path, body })
      if (method === 'POST' && path === '/api/connections') {
        if (body.database === 'failure') return { status: 400, body: { error: 'Fixture connection refused' } }
        return { status: 200, body: { id: `svelte-fixture-${globalThis.__pgdevSvelteFixture.requests.length}`, pgVersion: 'fixture' } }
      }
      if (path.endsWith('/schema')) return { status: 200, body: {
        tables: [{
          schema: 'public', name: 'fixture', oid: '42',
          columns: [{ name: 'payload', type: 'jsonb', nullable: true, defaultValue: null }],
          indexes: [], constraints: [], triggers: [], isPartition: false, isPartitioned: false, parents: '', relkind: 'r',
        }],
        views: [
          { schema: 'public', name: 'report_daily', oid: '51', materialized: false, columns: [{ name: 'payload', type: 'jsonb', nullable: true, defaultValue: null }] },
          { schema: 'public', name: 'report_weekly', oid: '52', materialized: true, columns: [] },
        ],
        functions: [{ schema: 'public', name: 'calculate', oid: '61', args: 'payload integer', returns: 'integer', typeSig: 'integer', kind: 'function' }],
        types: [{ schema: 'public', name: 'status', oid: '71', kind: 'enum', detail: "'active', '<script>not markup</script>'" }],
        sequences: [{ schema: 'public', name: 'counter', oid: '81', dataType: 'bigint', detail: 'increment 1 · owned by fixture.id' }],
      } }
      if (path.includes('/ddl?')) return { status: 200, body: { ddl: '-- fixture DDL\nSELECT 1;' } }
      if (path.endsWith('/tableedit/42')) {
        const fixture = globalThis.__pgdevSvelteFixture
        if (method === 'POST') {
          if (fixture.tableSubmitError) return { status: 409, body: { error: 'Fixture schema changed' } }
          return { status: 200, body: { ddl: fixture.tableDdl } }
        }
        if (fixture.tableLoadError) return { status: 400, body: { error: 'Fixture table load failed' } }
        return { status: 200, body: {
          oid: '42', schema: 'public', name: 'fixture', relkind: 'r', description: 'Original comment', fingerprint: 'fixture-fingerprint',
          columns: [
            { id: '1', name: '_meta', type: 'text', nullable: true },
            { id: '2', name: 'id', type: 'bigint', nullable: false, pk: true, locked: true, lockKind: 'identity' },
            { id: '3', name: 'label', type: 'character varying(20)', nullable: true, uks: [{ label: 'UK1', name: 'fixture_label_key', definition: 'UNIQUE (label)' }] },
            { id: '4', name: 'amount', type: 'numeric(12, 2)', nullable: true },
            { id: '5', name: 'custom', type: 'public.custom_type', nullable: true, fks: [{ label: 'FK1', name: 'fixture_custom_fkey', definition: 'FOREIGN KEY (custom) REFERENCES other(custom)' }] },
            { id: '6', name: 'sequence', type: 'serial', nullable: false, locked: true, lockKind: 'serial' },
          ].map((column) => ({ pk: false, locked: false, defaultValue: null, description: null, ...column })),
        } }
      }
      if (path.endsWith('/row-update')) {
        if (globalThis.__pgdevSvelteFixture.rejectUpdate) return { status: 409, body: { error: 'Fixture transaction changed' } }
        return { status: 200, body: { row: body.set, transactionId: null, transactionOpen: false } }
      }
      if (path.endsWith('/cancel')) {
        globalThis.__pgdevSvelteFixture.pendingQuery?.({ status: 400, body: { error: 'canceling statement due to user request', code: '57014' } })
        return { status: 200, body: { ok: true } }
      }
      if (path.endsWith('/query/more')) return { status: 200, body: { rows: [['true', 'last']], rowCount: 1, truncated: false } }
      if (path.endsWith('/query') && body.sql === 'SLOW') return new Promise((resolve) => { globalThis.__pgdevSvelteFixture.pendingQuery = resolve })
      if (path.endsWith('/query') && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(body.sql)) return { status: 200, body: {
        results: [{ kind: 'command', command: body.sql, rowCount: 0 }], durationMs: 1,
        transactionOpen: body.sql === 'BEGIN', transactionId: body.sql === 'BEGIN' ? 'fixture-transaction' : null,
      } }
      if (path.endsWith('/query') && body.sql === 'MULTI') return { status: 200, body: {
        results: [
          { kind: 'data', columns: ['number'], columnTypes: ['integer'], rows: Array.from({ length: 300 }, (_, index) => [String(index)]), rowCount: 300, truncated: false },
          { kind: 'data', columns: ['enabled', 'note'], columnTypes: ['boolean', 'text'], rows: [['true', null], ['false', 'line,\n"quoted"']], rowCount: 2, truncated: true },
        ], durationMs: 1, transactionOpen: false, transactionId: null,
      } }
      if (path.endsWith('/query') && body.sql === 'SELECT BROKEN') return { status: 400, body: {
        error: 'Fixture SQL error', code: '42601', position: '8', transactionId: null, transactionOpen: false,
      } }
      if (path.endsWith('/query')) return { status: 200, body: {
        results: [{
          kind: 'data', columns: ['payload', 'id', 'amount', 'enabled', 'note', '_generated'],
          columnTypes: ['jsonb', 'bigint', 'numeric', 'boolean', 'varchar', 'text'],
          columnTypeLengths: [null, null, null, null, 20, null],
          rows: [[value, '900719925474099312345', '1.50', 'true', 'original', 'locked']],
          rowCount: 1, truncated: false, limited: false,
          editable: {
            schema: 'public', table: 'fixture', pk: ['id'],
            columns: ['payload', 'id', 'amount', 'enabled', 'note', '_generated'].map((name) => ({
              name, pk: name === 'id', generated: name === '_generated', nullable: name !== 'id',
            })),
          },
        }],
        durationMs: 1, transactionId: null, transactionOpen: false,
      } }
      return { status: 200, body: { ok: true } }
    })
  }, json)
  assert.equal(await page.locator('.editor-tabs').getAttribute('data-component'), 'svelte-editor-tabs')
  assert.equal(await page.locator('.editor-host').getAttribute('data-component'), 'svelte-query-editor')
  const editorInput = page.locator('.monaco-editor textarea')
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
  async function replaceSql(sql) {
    await editorInput.focus()
    await page.keyboard.press(`${modifier}+A`)
    await page.keyboard.insertText(sql)
  }
  async function waitSql(sql) {
    await page.waitForFunction((text) => document.querySelector('.monaco-editor .view-lines')?.textContent?.replace(/\s/g, '') === text.replace(/\s/g, ''), sql)
  }
  await replaceSql('select 1 as first')
  await waitSql('select 1 as first')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  const firstTabTitle = await page.locator('.tab.active .tab-title').innerText()
  await page.getByTitle('New query tab (Ctrl+N)', { exact: true }).click()
  await replaceSql('select 2 as second')
  await waitSql('select 2 as second')
  const secondTabTitle = await page.locator('.tab.active .tab-title').innerText()
  await page.locator('.tab').filter({ hasText: firstTabTitle }).click()
  await waitSql('select 1 as first')
  await editorInput.focus()
  await page.keyboard.insertText('X')
  await waitSql('sXelect 1 as first')
  await page.keyboard.press(`${modifier}+Z`)
  await waitSql('select 1 as first')
  await page.locator('.tab').filter({ hasText: secondTabTitle }).click()
  await waitSql('select 2 as second')
  const tabCount = await page.locator('.tab').count()
  await page.locator('.tab.active').getByTitle('Close tab', { exact: true }).click()
  assert.equal(await page.locator('.tab').count(), tabCount, 'cancelled unsaved-close must keep the tab')
  // Native drag events use the same transfer/insertion path as pointer dragging.
  const beforeOrder = await page.locator('.tab-title').allTextContents()
  await page.locator('.tabstrip').evaluate((strip) => {
    const tabs = strip.querySelectorAll('.tab')
    const transfer = new DataTransfer()
    tabs[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
    strip.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }))
    strip.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
  })
  await page.waitForFunction((title) => [...document.querySelectorAll('.tab-title')].at(-1)?.textContent === title, beforeOrder[0])
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.confirm = true })
  await page.locator('.tab').first().click({ button: 'right' })
  await page.locator('.tab-menu').getByRole('button', { name: 'Close all', exact: true }).click()
  await page.getByText('No open tabs', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'New query', exact: true }).click()
  await editorInput.waitFor()
  await replaceSql('select 1 as formatted')
  await page.getByTitle('Format SQL or selection (Ctrl+Shift+F)', { exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent?.includes('SELECT'))
  await page.getByTitle('Collapse navigation panel', { exact: true }).click()
  assert.ok(!await page.locator('.sidebar').isVisible())
  await page.getByTitle('Expand navigation panel', { exact: true }).click()
  assert.ok(await page.locator('.sidebar').isVisible())
  const splitter = await page.locator('.drag-v').boundingBox()
  assert.ok(splitter)
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 30)
  await page.mouse.down()
  await page.mouse.move(400, splitter.y + 30)
  await page.mouse.up()
  assert.equal(await page.locator('.sidebar').evaluate((element) => element.offsetWidth), 400)
  await replaceSql('select $1')
  await page.getByTitle('Generate call of parameterized query.', { exact: true }).click()
  const values = page.locator('.param-bar input')
  await values.waitFor()
  await page.waitForFunction(() => document.activeElement === document.querySelector('.param-bar input'))
  await values.fill('[7]')
  await values.press('Enter')
  await page.waitForFunction(() => {
    const text = (document.querySelector('.monaco-editor .view-lines')?.textContent ?? '').replace(/\s/g, '')
    return text.includes('PREPAREtempAS') && text.includes('EXECUTEtemp') && text.includes('7--$1')
  })
  const savedSqlPath = join(directory, 'saved.sql')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, savedSqlPath)
  await replaceSql('SELECT 17 AS native_file')
  await page.keyboard.press(`${modifier}+S`)
  await page.locator('.tab.active').filter({ hasText: 'saved.sql' }).waitFor()
  assert.equal(await readFile(savedSqlPath, 'utf8'), 'SELECT 17 AS native_file')
  await page.locator('.tab.active').click({ button: 'right' })
  await page.locator('.tab-menu').getByRole('button', { name: 'Pin', exact: true }).click()
  await page.locator('.pinned-file').filter({ hasText: 'saved.sql' }).waitFor()
  const openedSqlPath = join(directory, 'opened.sql')
  await writeFile(openedSqlPath, 'SELECT 23 AS opened_file')
  await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, openedSqlPath)
  await page.keyboard.press(`${modifier}+O`)
  await page.locator('.tab.active').filter({ hasText: 'opened.sql' }).waitFor()
  await waitSql('SELECT 23 AS opened_file')
  await page.locator('.pinned-file').filter({ hasText: 'saved.sql' }).dblclick()
  await waitSql('SELECT 17 AS native_file')
  await page.locator('.pinned-file').filter({ hasText: 'saved.sql' }).click({ button: 'right' })
  await page.locator('.browser-node-menu').getByRole('button', { name: 'Unpin', exact: true }).click()
  await page.locator('.pinned-file').waitFor({ state: 'detached' })
  await page.locator('.tab.active').click({ button: 'right' })
  await page.locator('.tab-menu').getByRole('button', { name: 'Close all', exact: true }).click()
  await page.getByText('No open tabs', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'New query', exact: true }).click()
  await replaceSql('')
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.confirm = false })
  await page.getByRole('button', { name: 'Not connected', exact: true }).click()
  const connection = page.getByRole('dialog', { name: 'Connect to PostgreSQL', exact: true })
  await connection.getByRole('tab', { name: 'Connection string', exact: true }).click()
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await connection.getByText('Connection string is required', { exact: true }).waitFor()
  assert.equal(await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.length), 0)
  await connection.getByRole('tab', { name: 'Parameters', exact: true }).click()
  await connection.getByLabel('Host', { exact: true }).fill('fixture-host')
  await connection.getByLabel('Port', { exact: true }).fill('5444')
  await connection.getByLabel('Database', { exact: true }).fill('failure')
  await connection.getByLabel('User', { exact: true }).fill('fixture-user')
  const password = connection.getByPlaceholder('Enter password', { exact: true })
  await password.fill('fixture-secret')
  await connection.getByTitle('Show password', { exact: true }).click()
  assert.equal(await password.getAttribute('type'), 'text')
  assert.equal(await password.inputValue(), 'fixture-secret')
  await connection.getByTitle('Hide password', { exact: true }).click()
  assert.equal(await password.getAttribute('type'), 'password')
  await connection.getByRole('checkbox', { name: /^SSL/ }).check()
  await connection.getByRole('checkbox', { name: /^Remember on this device/ }).uncheck()
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await connection.getByText('Fixture connection refused', { exact: true }).waitFor()
  await connection.getByLabel('Database', { exact: true }).fill('fixture')
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.locator('.conn-badge:not(.off)').waitFor()
  const parameterRequest = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.method === 'POST' && request.path === '/api/connections').at(-1).body)
  assert.deepEqual(parameterRequest, {
    host: 'fixture-host', port: 5444, database: 'fixture', user: 'fixture-user',
    password: 'fixture-secret', ssl: true, statementTimeout: 30,
  })
  await page.locator('.conn-badge').click()
  assert.equal(await connection.locator('.saved-item').count(), 1, 'unsaved active connection remains visible')
  assert.equal(await connection.locator('.saved-seq').count(), 0, 'unsaved connection has no saved number')
  await connection.getByTitle('Disconnect', { exact: true }).click()
  await page.locator('.conn-badge.off').waitFor()
  await connection.locator('.connect-cols.single').waitFor()
  await connection.getByRole('tab', { name: 'Connection string', exact: true }).click()
  await connection.getByLabel('URL', { exact: true }).fill('  postgres://fixture@localhost/fixture  ')
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.locator('.conn-badge:not(.off)').waitFor()
  await page.locator('.conn-badge').click()
  await connection.locator('.saved-seq').waitFor()
  assert.equal(await connection.locator('.saved-seq').innerText(), '#1')
  await connection.getByTitle('Disconnect', { exact: true }).click()
  await page.locator('.conn-badge.off').waitFor()
  const savedConnection = connection.locator('.saved-item')
  await savedConnection.focus()
  await page.keyboard.press('Enter')
  assert.equal(await connection.getByRole('tab', { name: 'Connection string', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await connection.getByLabel('URL', { exact: true }).inputValue(), 'postgres://fixture@localhost/fixture')
  await connection.getByRole('button', { name: 'Clear all', exact: true }).click()
  assert.equal(await savedConnection.count(), 1, 'cancelled confirmation must keep saved connections')
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.locator('.conn-badge:not(.off)').waitFor()
  await replaceSql('SELECT BROKEN')
  await page.keyboard.press(`${modifier}+Enter`)
  await page.locator('.monaco-editor .squiggly-error').first().waitFor()
  await replaceSql('SELECT payload FROM fixture')
  await page.locator('.monaco-editor .squiggly-error').waitFor({ state: 'detached' })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  const cell = page.locator('.grid-row .grid-cell:not(.actions)').first()
  await cell.dblclick()
  const valueDialog = page.getByRole('dialog', { name: 'payload', exact: true })
  const rendered = await valueDialog.locator('pre').innerText()
  assert.ok(rendered.includes('900719925474099312345'), 'JSON formatting must preserve integer precision')
  assert.ok(rendered.includes('<script>not markup</script>'), 'database text must not become HTML')
  await page.keyboard.press('Escape')
  await valueDialog.waitFor({ state: 'detached' })
  await cell.dblclick()
  await valueDialog.getByRole('button', { name: 'COPY', exact: true }).click()
  await valueDialog.waitFor({ state: 'detached' })
  const copied = await application.evaluate(({ clipboard }) => clipboard.readText())
  assert.equal(copied, rendered)

  await page.getByTitle('Edit row', { exact: true }).click()
  const rowEditor = page.getByRole('dialog', { name: 'Edit row', exact: true })
  const saveRow = rowEditor.getByRole('button', { name: 'SAVE', exact: true })
  assert.ok(await saveRow.isDisabled(), 'unchanged numeric text must not dirty the row')
  assert.equal(await rowEditor.getByLabel('amount', { exact: true }).inputValue(), '1.50')
  assert.equal(await rowEditor.locator('.rowedit-locked').count(), 2, 'primary key and generated values remain locked')
  assert.equal(await rowEditor.getByLabel('note', { exact: true }).getAttribute('maxlength'), '20')
  await rowEditor.getByLabel('payload', { exact: true }).fill('{invalid')
  await saveRow.click()
  await rowEditor.locator('.rowedit-error').filter({ hasText: 'Invalid JSON' }).waitFor()
  assert.equal(await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.path.endsWith('/row-update')).length), 0)
  await rowEditor.getByLabel('payload', { exact: true }).fill('{"large":900719925474099312346}')
  await rowEditor.getByLabel('amount', { exact: true }).fill('2.75')
  await rowEditor.getByLabel('enabled', { exact: true }).uncheck()
  await rowEditor.getByLabel('Set note to NULL', { exact: true }).check()
  assert.ok(await rowEditor.getByLabel('note', { exact: true }).isDisabled())
  await page.keyboard.press('Escape')
  assert.ok(await rowEditor.isVisible(), 'cancelled discard must retain row draft')
  await saveRow.click()
  await rowEditor.getByText('Fixture transaction changed', { exact: true }).waitFor()
  const update = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.path.endsWith('/row-update')).at(-1).body)
  assert.equal(update.transactionId, null, 'row updates explicitly carry the captured transaction binding')
  assert.ok(update.tabKey)
  assert.deepEqual(update.key, { id: '900719925474099312345' })
  assert.deepEqual(update.set, { payload: '{"large":900719925474099312346}', amount: '2.75', enabled: false, note: null })
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.rejectUpdate = false })
  await saveRow.click()
  await rowEditor.waitFor({ state: 'detached' })
  await page.getByTitle('Edit row', { exact: true }).click()
  assert.equal(await rowEditor.getByLabel('amount', { exact: true }).inputValue(), '2.75', 'saved callback must patch the grid row')
  assert.ok(await rowEditor.getByLabel('Set note to NULL', { exact: true }).isChecked())
  assert.ok(await saveRow.isDisabled())
  await rowEditor.getByRole('button', { name: 'CANCEL', exact: true }).click()
  await rowEditor.waitFor({ state: 'detached' })

  const resultsPanel = page.locator('.results')
  assert.equal(await resultsPanel.getAttribute('data-component'), 'svelte-results-panel')
  await replaceSql('SLOW')
  await resultsPanel.getByTitle('Run (F5 or Ctrl+Enter)', { exact: true }).click()
  await resultsPanel.getByTitle('Cancel running query or row load', { exact: true }).click()
  await resultsPanel.getByText('Query canceled.', { exact: true }).waitFor()
  await replaceSql('BEGIN')
  await resultsPanel.getByTitle('Run (F5 or Ctrl+Enter)', { exact: true }).click()
  await resultsPanel.getByTitle('A manual transaction is open for this tab', { exact: true }).waitFor()
  await resultsPanel.getByTitle('Commit the open transaction', { exact: true }).click()
  await resultsPanel.getByTitle('A manual transaction is open for this tab', { exact: true }).waitFor({ state: 'detached' })
  const commit = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.find((request) => request.path.endsWith('/query') && request.body.sql === 'COMMIT'))
  assert.equal(commit.body.transactionId, 'fixture-transaction')
  await replaceSql('BEGIN')
  await resultsPanel.getByTitle('Run (F5 or Ctrl+Enter)', { exact: true }).click()
  await resultsPanel.getByTitle('Roll back the open transaction', { exact: true }).click()
  await resultsPanel.getByTitle('A manual transaction is open for this tab', { exact: true }).waitFor({ state: 'detached' })
  await replaceSql('MULTI')
  await resultsPanel.getByTitle('Run (F5 or Ctrl+Enter)', { exact: true }).click()
  await resultsPanel.getByRole('button', { name: 'Result 2', exact: true }).waitFor()
  assert.ok(await resultsPanel.locator('.grid-row').count() < 60, 'virtualization must not render all retained rows')
  const body = resultsPanel.locator('.grid-body')
  await body.evaluate((element) => { element.scrollTop = 240 * 24; element.dispatchEvent(new Event('scroll')) })
  await resultsPanel.locator('.grid-row').filter({ hasText: /^\s*240\s*$/ }).waitFor()
  const handle = resultsPanel.getByTitle('Resize column', { exact: true })
  const beforeWidth = await resultsPanel.locator('.grid-cell.head').first().evaluate((element) => element.offsetWidth)
  const bounds = await handle.boundingBox()
  assert.ok(bounds)
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 70, bounds.y + bounds.height / 2)
  await page.mouse.up()
  assert.equal(await resultsPanel.locator('.grid-cell.head').first().evaluate((element) => element.offsetWidth), beforeWidth + 70)
  await resultsPanel.getByRole('button', { name: 'Result 2', exact: true }).click()
  await resultsPanel.locator('.null-badge').waitFor()
  assert.equal(await resultsPanel.locator('.bool-badge.true').innerText(), 'true')
  assert.equal(await resultsPanel.locator('.bool-badge.false').innerText(), 'false')
  await resultsPanel.getByTitle('Copy loaded rows to clipboard (TSV)', { exact: true }).click()
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'enabled\tnote\ntrue\t\nfalse\tline, "quoted"')
  await resultsPanel.getByTitle('Fetch the next page of rows', { exact: true }).click()
  await resultsPanel.getByTitle('Fetch the next page of rows', { exact: true }).waitFor({ state: 'detached' })
  assert.ok((await resultsPanel.locator('.grid-foot').innerText()).includes('3 row(s)'))
  await resultsPanel.getByRole('button', { name: 'Messages', exact: true }).click()
  await resultsPanel.locator('.messages').waitFor()
  await resultsPanel.getByRole('button', { name: 'Result 1', exact: true }).click()
  assert.equal(await resultsPanel.locator('.grid-cell.head').first().evaluate((element) => element.offsetWidth), beforeWidth + 70, 'column widths survive result switching')
  await resultsPanel.getByTitle('Run (F5 or Ctrl+Enter)', { exact: true }).click()
  await resultsPanel.getByRole('button', { name: 'Result 2', exact: true }).click()
  const csvPath = join(directory, 'results.csv')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, csvPath)
  await resultsPanel.getByTitle('Export all rows to CSV', { exact: true }).click()
  await resultsPanel.locator('.grid-foot').filter({ hasText: '3 row(s) exported to CSV' }).waitFor()
  assert.equal(await readFile(csvPath, 'utf8'), '\uFEFFenabled,note\ntrue,\nfalse,"line,\n""quoted"""\ntrue,last\n')

  const tableEditor = page.getByRole('dialog', { name: 'Edit table', exact: true })
  async function openTableEditor() {
    const search = page.locator('.browser-search input')
    await search.fill('fixture')
    const tableNode = page.locator('.browser .tree > .node').filter({ has: page.locator('.obj-name', { hasText: /^fixture$/ }) }).first()
    await tableNode.click({ button: 'right' })
    await page.locator('.browser-node-menu').getByRole('button', { name: 'Edit…', exact: true }).click()
  }
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.tableLoadError = true })
  await openTableEditor()
  await tableEditor.getByText('Fixture table load failed', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await tableEditor.waitFor({ state: 'detached' })
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.tableLoadError = false })
  await openTableEditor()
  await tableEditor.getByRole('button', { name: 'Generate DDL', exact: true }).click()
  await tableEditor.waitFor({ state: 'detached' })
  const unchanged = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/tableedit/42')).at(-1).body)
  assert.equal(unchanged.fingerprint, 'fixture-fingerprint')
  assert.equal(unchanged.columns.find((column) => column.name === 'label').type, 'character varying(20)', 'untouched type spelling must be preserved')
  assert.equal(unchanged.columns.find((column) => column.name === 'amount').type, 'numeric(12, 2)')

  await openTableEditor()
  // Row order intentionally moves underscore-prefixed columns to the end.
  const tableRows = tableEditor.locator('.tableedit-row')
  await tableRows.first().waitFor()
  assert.equal(await tableRows.last().getByLabel('Column name', { exact: true }).inputValue(), '_meta')
  const identity = tableRows.nth(0)
  assert.ok(await identity.getByLabel('Column type', { exact: true }).isDisabled())
  assert.ok(await identity.getByLabel('Nullable', { exact: true }).isDisabled())
  assert.ok(await identity.getByTitle('Primary key columns cannot be dropped', { exact: true }).isDisabled())
  const label = tableRows.nth(1)
  assert.equal(await label.locator('.fk-chip').innerText(), 'UK1')
  const amount = tableRows.nth(2)
  const custom = tableRows.nth(3)
  assert.equal(await custom.getByLabel('Column type', { exact: true }).inputValue(), 'public.custom_type')
  assert.equal(await custom.locator('.fk-chip').innerText(), 'FK1')
  const serial = tableRows.nth(4)
  assert.ok(await serial.getByLabel('Column type', { exact: true }).isDisabled())
  assert.ok(await serial.getByLabel('Nullable', { exact: true }).isEnabled(), 'serial nullable remains editable')
  await custom.getByTitle('Delete column', { exact: true }).click()
  await custom.getByTitle('Restore column', { exact: true }).click()
  assert.ok(await custom.getByLabel('Column type', { exact: true }).isEnabled())
  await custom.getByTitle('Delete column', { exact: true }).click()
  await tableEditor.getByLabel('Description', { exact: true }).fill('Updated comment')
  await label.getByLabel('Column type', { exact: true }).selectOption('varchar')
  await label.getByTitle('Length (varchar, char) or precision (numeric)', { exact: true }).fill('30')
  await amount.getByTitle('Length (varchar, char) or precision (numeric)', { exact: true }).fill('14')
  await amount.getByTitle('Scale (numeric only)', { exact: true }).fill('4')
  await tableEditor.getByRole('button', { name: 'Add column', exact: true }).click()
  const added = tableEditor.locator('.tableedit-row').filter({ has: page.locator('.added-badge') })
  await added.getByTitle('Remove column', { exact: true }).click()
  assert.equal(await added.count(), 0)
  await tableEditor.getByRole('button', { name: 'Add column', exact: true }).click()
  await tableEditor.getByRole('button', { name: 'Generate DDL', exact: true }).click()
  await tableEditor.getByText('Every column needs a name', { exact: true }).waitFor()
  await added.getByLabel('Column name', { exact: true }).fill('label')
  await tableEditor.getByRole('button', { name: 'Generate DDL', exact: true }).click()
  await tableEditor.getByText('Column "label" needs a type', { exact: true }).waitFor()
  await added.getByLabel('Column type', { exact: true }).selectOption('text')
  await tableEditor.getByRole('button', { name: 'Generate DDL', exact: true }).click()
  await tableEditor.getByText('Column name "label" is used more than once', { exact: true }).waitFor()
  await added.getByLabel('Column name', { exact: true }).fill('new_column')
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.tableSubmitError = true })
  await tableEditor.getByRole('button', { name: 'Generate DDL', exact: true }).click()
  await tableEditor.getByText('Fixture schema changed', { exact: true }).waitFor()
  const tableRequest = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/tableedit/42')).at(-1))
  assert.equal(tableRequest.body.fingerprint, 'fixture-fingerprint')
  assert.equal(tableRequest.body.description, 'Updated comment')
  assert.equal(tableRequest.body.columns.find((entry) => entry.name === 'label').type, 'varchar(30)')
  assert.equal(tableRequest.body.columns.find((entry) => entry.name === 'amount').type, 'numeric(14,4)')
  assert.ok(!tableRequest.body.columns.some((entry) => entry.name === 'custom'), 'deleted columns must be omitted')
  assert.ok(tableRequest.body.columns.find((entry) => entry.name === 'new_column').added)
  const queryCount = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.path.endsWith('/query')).length)
  const ddl = 'ALTER TABLE public.fixture ADD COLUMN new_column text;'
  await application.evaluate((_electron, sql) => {
    globalThis.__pgdevSvelteFixture.tableSubmitError = false
    globalThis.__pgdevSvelteFixture.tableDdl = sql
  }, ddl)
  await tableEditor.getByRole('button', { name: 'Generate DDL', exact: true }).click()
  await tableEditor.waitFor({ state: 'detached' })
  await page.locator('.tab.active').filter({ hasText: 'Edit fixture' }).waitFor()
  await page.waitForFunction((sql) => document.querySelector('.monaco-editor .view-lines')?.textContent?.replace(/\s/g, '') === sql.replace(/\s/g, ''), ddl)
  assert.equal(await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.path.endsWith('/query')).length), queryCount, 'generating DDL must never execute SQL')

  // Lock down existing browser behavior before migrating its tree/state.
  const browser = page.locator('.browser')
  assert.equal(await browser.getAttribute('data-component'), 'svelte-object-browser')
  const search = browser.locator('.browser-search input')
  await search.fill('payload col')
  await browser.locator('.cat-child .obj-name').filter({ hasText: /^payload$/ }).waitFor()
  assert.equal(await browser.locator('section.group').count(), 2, 'column searches show only tables/views')
  await search.fill('no_such_object')
  await browser.locator('.no-match').waitFor()
  await browser.getByTitle('Clear search', { exact: true }).click()
  const tableSection = browser.locator('section.group').filter({ has: page.locator('h3', { hasText: /\bTables\b/ }) })
  await tableSection.locator('h3').click()
  const tableNode = tableSection.locator('.tree > .node').first()
  const caret = tableNode.locator('.caret')
  await caret.click()
  await tableSection.locator('.node.cat').filter({ hasText: 'Columns' }).waitFor()
  assert.ok((await caret.getAttribute('class')).split(' ').includes('open'), 'table chevron opens immediately')
  const columnsNode = tableSection.locator('.node.cat').filter({ hasText: 'Columns' })
  await columnsNode.locator('.caret').click()
  await tableSection.locator('.cat-child .obj-name').filter({ hasText: /^payload$/ }).waitFor()
  await columnsNode.click({ button: 'right' })
  await browser.locator('.browser-node-menu').getByRole('button', { name: 'Collapse', exact: true }).click()
  await tableSection.locator('.cat-child').waitFor({ state: 'detached' })
  await tableNode.click({ button: 'right' })
  await browser.locator('.browser-node-menu').getByRole('button', { name: 'Collapse', exact: true }).click()
  await tableSection.locator('.node.cat').first().waitFor({ state: 'detached' })
  const schemaRequests = await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.path.endsWith('/schema')).length)
  await browser.getByTitle('Refresh schema', { exact: true }).click()
  assert.equal(await application.evaluate(() => globalThis.__pgdevSvelteFixture.requests.filter((request) => request.path.endsWith('/schema')).length), schemaRequests + 1)

  // Exercise every secondary section and the shared-prefix folder.
  const section = (name) => browser.locator('section.group').filter({ has: page.locator('h3', { hasText: new RegExp(`\\b${name}\\b`) }) })
  const viewsSection = section('Views')
  await viewsSection.locator('h3').click()
  const folder = viewsSection.locator('.object-group-node')
  await folder.click()
  const daily = viewsSection.locator('.tree > .node').filter({ has: page.locator('.obj-name', { hasText: /^report_daily$/ }) })
  await daily.locator('.caret').click()
  await viewsSection.locator('.child .obj-name').filter({ hasText: /^payload$/ }).waitFor()
  await daily.dblclick()
  await page.locator('.tab.active').filter({ hasText: 'report_daily' }).waitFor()
  assert.ok((await daily.locator('.caret').getAttribute('class')).split(' ').includes('open'), 'double-click DDL must not collapse the node')
  const weekly = viewsSection.locator('.tree > .node').filter({ has: page.locator('.obj-name', { hasText: /^report_weekly$/ }) })
  await weekly.dblclick()
  await page.locator('.tab.active').filter({ hasText: 'report_weekly' }).waitFor()
  assert.ok(await page.getByTitle('Format SQL or selection (Ctrl+Shift+F)', { exact: true }).isDisabled(), 'materialized view preview stays read-only')
  const typesSection = section('Types')
  await typesSection.locator('h3').click()
  await typesSection.locator('.tree > .node .caret').click()
  assert.ok((await typesSection.locator('.child').innerText()).includes('<script>not markup</script>'))
  assert.equal(await typesSection.locator('.child script').count(), 0, 'highlighted schema details must remain escaped')
  const functionsSection = section('Functions')
  await functionsSection.locator('h3').click()
  await functionsSection.locator('.tree > .node .caret').click()
  await functionsSection.locator('.child .obj-name').filter({ hasText: /^payload$/ }).waitFor()
  const sequencesSection = section('Sequences')
  await sequencesSection.locator('h3').click()
  await sequencesSection.locator('.tree > .node .caret').click()
  await sequencesSection.locator('.child').filter({ hasText: 'owned by fixture.id' }).waitFor()
  await search.fill('payload param')
  assert.equal(await browser.locator('section.group').count(), 1)
  await functionsSection.locator('.child .obj-name').filter({ hasText: /^payload$/ }).waitFor()
  await browser.getByTitle('Clear search', { exact: true }).click()
  // Pagehide flushes the same native snapshot used at real window shutdown.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await openTableEditor()

  // Open the connection dialog beneath the modal from the test driver to
  // simulate a connection lifecycle change while the table draft is open.
  await page.locator('.conn-badge').evaluate((badge) => badge.click())
  await connection.getByTitle('Disconnect', { exact: true }).click()
  await page.locator('.conn-badge.off').waitFor()
  await tableEditor.waitFor({ state: 'detached' })
  await connection.locator('.saved-item').click()
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.locator('.conn-badge:not(.off)').waitFor()
  await browser.getByTitle('Clear search', { exact: true }).click()
  await typesSection.locator('.child').waitFor()
  await sequencesSection.locator('.child').waitFor()
  await viewsSection.locator('.child .obj-name').filter({ hasText: /^payload$/ }).waitFor()
  await page.locator('.conn-badge').click()
  await connection.getByTitle('Disconnect', { exact: true }).click()
  await page.locator('.conn-badge.off').waitFor()
  await connection.getByTitle('Forget', { exact: true }).click()
  await connection.locator('.connect-cols.single').waitFor()
  await connection.getByRole('tab', { name: 'Connection string', exact: true }).click()
  await connection.getByLabel('URL', { exact: true }).fill('postgres://fixture@localhost/second')
  await connection.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.locator('.conn-badge:not(.off)').waitFor()
  await page.locator('.conn-badge').click()
  await connection.locator('.saved-seq').waitFor()
  assert.equal(await connection.locator('.saved-seq').innerText(), '#2', 'forgotten connection numbers must not be reused')
  await application.evaluate(() => { globalThis.__pgdevSvelteFixture.confirm = true })
  await connection.getByRole('button', { name: 'Clear all', exact: true }).click()
  await connection.locator('.saved-seq').waitFor({ state: 'detached' })
  assert.equal(await connection.locator('.saved-item.current').count(), 1, 'forgetting active config must not disconnect')
  await connection.getByTitle('Disconnect', { exact: true }).click()
  await page.locator('.conn-badge.off').waitFor()
  await connection.getByTitle('Close', { exact: true }).click()

  const closed = application.waitForEvent('close', { timeout: 15000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  application = undefined
  const stored = JSON.parse(await readFile(join(directory, 'state/settings.json'), 'utf8'))
  assert.equal(stored.value.editorFontSize, initialFont)
  assert.equal(stored.value.groupObjects, initialGroup === 'true')
  assert.deepEqual(errors, [])
  console.log('Svelte smoke passed: tab models/cursors/undo/reorder/close/remount, settings, connections, row/table editing, browser, native persistence and clipboard.')
  if (monacoDisposalCancellations.length) console.log(`Observed ${monacoDisposalCancellations.length} known Monaco disposal cancellations (microsoft/monaco-editor#4702).`)
} catch (error) {
  if (errors.length) console.error('Renderer errors:', errors)
  throw error
} finally {
  await application?.close().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
