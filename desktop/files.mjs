import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export function createFiles(dialog, getWindow) {
  const allowed = new Set()
  const streams = new Map()
  const SQL_FILTERS = [{ name: 'SQL and text scripts', extensions: ['sql', 'txt', 'ddl'] }]

  function grant(path) {
    if (typeof path === 'string' && path.length && !path.includes('\0')) allowed.add(resolve(path))
  }

  function authorize(file) {
    if (!file || typeof file.path !== 'string' || !allowed.has(resolve(file.path))) throw new Error('File access was not granted')
    return resolve(file.path)
  }

  async function read(file) {
    const path = authorize(file)
    const info = await stat(path)
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('SQL files must be regular files smaller than 32 MiB')
    const content = await readFile(path, 'utf8')
    return { fileName: basename(path), content, handle: { name: basename(path), path } }
  }

  async function pickOpen() {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openFile', 'multiSelections'], filters: SQL_FILTERS })
    if (result.canceled) return []
    return Promise.all(result.filePaths.map((path) => { grant(path); return read({ path }) }))
  }

  async function begin({ suggestedName, existing, csv = false }) {
    if (typeof suggestedName !== 'string' || suggestedName.length > 512) throw new Error('Invalid file name')
    let path
    if (existing) path = authorize(existing)
    else {
      const result = await dialog.showSaveDialog(getWindow(), {
        defaultPath: basename(suggestedName),
        filters: csv ? [{ name: 'CSV', extensions: ['csv'] }] : SQL_FILTERS,
      })
      if (result.canceled || !result.filePath) return null
      path = result.filePath
      grant(path)
    }
    const id = randomUUID()
    const temporary = join(dirname(path), `.pgdev-${id}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    streams.set(id, { file, temporary, path, writes: Promise.resolve(), closing: false })
    return { id, handle: { name: basename(path), path } }
  }

  function stream(id) {
    const entry = streams.get(id)
    if (!entry || entry.closing) throw new Error('The output stream is closed')
    return entry
  }

  async function write(id, text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Output chunk is too large')
    const entry = stream(id)
    const result = entry.writes.then(() => entry.file.writeFile(text, 'utf8'))
    entry.writes = result
    await result
  }

  async function finish(id, commit) {
    const entry = stream(id)
    entry.closing = true
    try {
      await entry.writes
      await entry.file.sync()
      await entry.file.close()
      if (commit) await rename(entry.temporary, entry.path)
      else await rm(entry.temporary, { force: true })
    } catch (error) {
      await entry.file.close().catch(() => undefined)
      await rm(entry.temporary, { force: true }).catch(() => undefined)
      throw error
    } finally {
      streams.delete(id)
    }
  }

  async function abortAll() {
    await Promise.all([...streams.keys()].map((id) => finish(id, false).catch(() => undefined)))
  }

  return { grant, authorize, read, pickOpen, begin, write, finish, abortAll }
}
