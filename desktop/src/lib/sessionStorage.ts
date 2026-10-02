import { parseSession, type QuerySession } from './querySession'
import { parseSettingsRecord, type SettingsRecord } from './settings'
import { parseProfiles, type ConnectionProfiles } from './connectionProfiles'

// A separate desktop database avoids changing the reference application's
// stores. Dev and packaged WebViews have separate origins and saved sessions.
export function createQuerySessionStorage(getFactory: () => IDBFactory | undefined = () => globalThis.indexedDB) {
  let pending: Promise<IDBDatabase> | undefined

  function database(): Promise<IDBDatabase> {
    if (pending) return pending
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = getFactory()
      if (!factory) { reject(new Error('IndexedDB is unavailable')); return }
      let blocked = false
      const request = factory.open('pgdev-desktop', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('session') }
      request.onerror = () => reject(request.error ?? new Error('Could not open SQL session storage'))
      request.onblocked = () => { blocked = true; reject(new Error('SQL session storage is blocked by another window')) }
      request.onsuccess = () => {
        const db = request.result
        if (blocked) { db.close(); return }
        db.onversionchange = () => { db.close(); pending = undefined }
        resolve(db)
      }
    })
    pending = opening
    void opening.catch(() => { if (pending === opening) pending = undefined })
    return opening
  }

  async function loadRecord(key: string): Promise<unknown> {
    const db = await database()
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction('session', 'readonly')
      const request = transaction.objectStore('session').get(key)
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read saved SQL session'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not read saved SQL session'))
    })
    return value
  }

  async function saveRecord(key: string, record: unknown): Promise<void> {
    const db = await database()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('session', 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save SQL session'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save SQL session'))
      transaction.objectStore('session').put(record, key)
    })
  }
  return {
    async loadQuerySession(): Promise<QuerySession | null> {
      const value = await loadRecord('current')
      return value === undefined ? null : parseSession(value)
    },
    saveQuerySession: (session: QuerySession) => saveRecord('current', session),
    async loadSettings(): Promise<SettingsRecord | null> {
      const value = await loadRecord('settings')
      return value === undefined ? null : parseSettingsRecord(value)
    },
    saveSettings: (record: SettingsRecord) => saveRecord('settings', record),
    async loadProfiles(): Promise<ConnectionProfiles | null> {
      const value = await loadRecord('connections')
      return value === undefined ? null : parseProfiles(value)
    },
    async saveProfiles(record: ConnectionProfiles): Promise<void> {
      await saveRecord('connections', parseProfiles(record))
    },
  }
}

export const { loadQuerySession, saveQuerySession, loadSettings, saveSettings, loadProfiles, saveProfiles } = createQuerySessionStorage()
