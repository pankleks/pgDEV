import type { FileHandle } from './files'
import type { TabSession } from './tabsession'
import { sanitizeSession } from './tabsession'
import { desktop } from './desktop'

export interface StoredPinnedFile {
  id: string
  order: number
  fileName: string
  content: string
  /** A native path reference, never a browser FileSystemHandle. */
  handle?: FileHandle
}

export interface StoredConnections {
  saved: unknown
  last: unknown
  nextSeq?: number
}

export interface StoredAppState {
  settings: unknown
  connections: StoredConnections | undefined
  pinnedFiles: StoredPinnedFile[]
  session?: TabSession
  warnings?: string[]
}

let writes = Promise.resolve()
function queueWrite(operation: () => Promise<unknown>): Promise<void> {
  const result = writes.then(operation).then(() => undefined)
  writes = result.catch(() => undefined)
  return result
}

export const storageReady: Promise<StoredAppState> = (async () => {
  // Pure state modules may be imported by Node unit tests. Desktop startup
  // requires the preload API; there is no supported browser storage fallback.
  if (typeof window === 'undefined') return { settings: undefined, connections: undefined, pinnedFiles: [] }
  return desktop().storage.load()
})()

function write(kind: 'settings' | 'connections' | 'pinnedFiles' | 'session', value: unknown): Promise<void> {
  const snapshot: unknown = JSON.parse(JSON.stringify(value))
  return queueWrite(() => desktop().storage.write(kind, snapshot))
}

export const saveSettings = (value: unknown): Promise<void> => write('settings', value)
export const saveConnections = (saved: unknown, last: unknown, nextSeq: number): Promise<void> =>
  write('connections', { saved, last, nextSeq })
export async function savePinnedFiles(pins: StoredPinnedFile[]): Promise<boolean> {
  await write('pinnedFiles', pins)
  return true
}
export const saveTabSession = (session: TabSession): Promise<void> => write('session', session)
export async function loadTabSession(): Promise<TabSession | null> {
  return sanitizeSession((await storageReady).session)
}
export const flushStorage = (): Promise<void> => writes
