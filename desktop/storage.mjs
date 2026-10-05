import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const KINDS = new Set(['settings', 'connections', 'pinnedFiles', 'session'])

function validRecord(kind, value) {
  if (kind === 'pinnedFiles') return Array.isArray(value) && value.every((pin) =>
    pin && typeof pin.id === 'string' && typeof pin.order === 'number' && typeof pin.fileName === 'string' && typeof pin.content === 'string')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (kind === 'session') return Array.isArray(value.tabs) && value.tabs.every((tab) =>
    tab && typeof tab.key === 'string' && typeof tab.title === 'string' && typeof tab.content === 'string' &&
    (tab.savedContent === undefined || tab.savedContent === null || typeof tab.savedContent === 'string'))
  if (kind === 'connections') return Array.isArray(value.saved)
  return true
}

function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  if (!value || typeof value !== 'object') return value
  const clean = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'password') continue
    if (key === 'connectionString' && typeof entry === 'string') {
      try {
        const url = new URL(entry)
        url.password = ''
        // Connection URI options may also carry credentials.
        for (const param of [...url.searchParams.keys()]) {
          if (/password|secret|token/i.test(param)) url.searchParams.delete(param)
        }
        clean[key] = url.toString()
      } catch {
        // Unparseable connection strings cannot safely be persisted in clear.
      }
    } else clean[key] = withoutSecrets(entry)
  }
  return clean
}

/** All native persistence is serialized here, independently of the UI framework.
 * Unknown/corrupt records are preserved, not silently replaced with defaults. */
export function createStorage(directory, encryption) {
  let writes = Promise.resolve()
  const warnings = new Set()
  const blocked = new Set()
  const recovered = new Set()

  function secure() {
    return encryption.isEncryptionAvailable() &&
      (!encryption.getSelectedStorageBackend || encryption.getSelectedStorageBackend() !== 'basic_text')
  }

  function path(kind) {
    if (!KINDS.has(kind)) throw new Error('Unknown storage record')
    return join(directory, `${kind}.json`)
  }

  async function read(kind) {
    const file = path(kind)
    async function decode(name) {
      const record = JSON.parse(await readFile(name, 'utf8'))
      if (record.version !== 1 || !Object.hasOwn(record, 'value')) throw new Error('Unsupported storage record')
      if (kind === 'connections' && record.encrypted) {
        if (!secure()) throw new Error('Secure credential storage is unavailable')
        const value = JSON.parse(encryption.decryptString(Buffer.from(record.value, 'base64')))
        if (!validRecord(kind, value)) throw new Error('Malformed credential record')
        return value
      }
      if (!validRecord(kind, record.value)) throw new Error('Malformed storage record')
      return record.value
    }
    try {
      return await decode(file)
    } catch (error) {
      try {
        const value = await decode(`${file}.bak`)
        recovered.add(kind)
        warnings.add(`Recovered ${kind} from its backup. The previous file will be preserved.`)
        return value
      } catch (backupError) {
        if (error.code === 'ENOENT' && backupError.code === 'ENOENT') return undefined
        blocked.add(kind)
        warnings.add(`Cannot read ${kind}. Its files have been preserved; saving this record is disabled until repaired.`)
        return undefined
      }
    }
  }

  function write(kind, value) {
    path(kind)
    // Snapshot before queueing: never capture mutable caller state.
    const snapshot = JSON.parse(JSON.stringify(value))
    const result = writes.then(async () => {
      if (blocked.has(kind)) throw new Error(`${kind} storage is unreadable. Repair or move its files before saving.`)
      if (!validRecord(kind, snapshot)) throw new Error('Malformed storage record')
      let record = { version: 1, value: snapshot }
      if (kind === 'connections') {
        if (secure()) {
          record = { version: 1, encrypted: true, value: encryption.encryptString(JSON.stringify(snapshot)).toString('base64') }
        } else {
          record.value = withoutSecrets(snapshot)
          warnings.add('Secure credential storage is unavailable. Passwords are not being remembered.')
        }
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = path(kind)
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        if (recovered.has(kind)) {
          await copyFile(file, `${file}.corrupt-${randomUUID()}`).catch((error) => {
            if (error.code !== 'ENOENT') throw error
          })
          recovered.delete(kind)
        } else {
          await copyFile(file, `${file}.bak`).catch((error) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        await rename(temporary, file)
      } catch (error) {
        // Leave the temporary snapshot available for recovery on write failure.
        throw error
      }
      return { warnings: [...warnings] }
    })
    writes = result.catch(() => undefined)
    return result
  }

  async function load() {
    const [settings, connections, pinnedFiles, session] = await Promise.all([...KINDS].map(read))
    if (!secure()) warnings.add('Secure credential storage is unavailable. Passwords are not being remembered.')
    return { settings, connections, pinnedFiles: pinnedFiles ?? [], session, warnings: [...warnings] }
  }

  return { load, write, flush: () => writes }
}
