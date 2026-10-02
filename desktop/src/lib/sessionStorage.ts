import { parseSession, type QuerySession } from './querySession'

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

  async function loadQuerySession(): Promise<QuerySession | null> {
    const db = await database()
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction('session', 'readonly')
      const request = transaction.objectStore('session').get('current')
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read saved SQL session'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not read saved SQL session'))
    })
    return value === undefined ? null : parseSession(value)
  }

  async function saveQuerySession(session: QuerySession): Promise<void> {
    const db = await database()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('session', 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save SQL session'))
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save SQL session'))
      transaction.objectStore('session').put(session, 'current')
    })
  }
  return { loadQuerySession, saveQuerySession }
}

export const { loadQuerySession, saveQuerySession } = createQuerySessionStorage()
