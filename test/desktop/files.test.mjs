import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFiles } from '../../desktop/files.mjs'

test('native output is atomic, bounded, authorized and abortable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pgdev-files-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'résults.sql')
  await writeFile(path, 'old')
  const dialog = { showSaveDialog: async () => ({ filePath: path }), showOpenDialog: async () => ({ filePaths: [path] }) }
  const files = createFiles(dialog, () => undefined)
  await assert.rejects(files.read({ path }), /not granted/)
  const opened = await files.pickOpen()
  assert.equal(opened[0].content, 'old')
  const output = await files.begin({ suggestedName: 'résults.sql', existing: opened[0].handle })
  await Promise.all([files.write(output.id, 'new'), files.write(output.id, ' content')])
  assert.equal(await readFile(path, 'utf8'), 'old', 'destination is unchanged until commit')
  await files.finish(output.id, true)
  assert.equal(await readFile(path, 'utf8'), 'new content')
  const canceled = await files.begin({ suggestedName: 'results.csv', csv: true })
  await files.write(canceled.id, 'partial')
  await files.finish(canceled.id, false)
  assert.equal(await readFile(path, 'utf8'), 'new content')
  assert.deepEqual(await readdir(directory), ['résults.sql'])
  await assert.rejects(files.write(canceled.id, 'late'), /closed/)
  await assert.rejects(files.begin({ suggestedName: 'outside', existing: { path: join(directory, 'outside') } }), /not granted/)
})

test('native picker cancellation does not create output', async () => {
  const files = createFiles({ showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) }, () => undefined)
  assert.equal(await files.begin({ suggestedName: 'query.sql' }), null)
  assert.deepEqual(await files.pickOpen(), [])
})
