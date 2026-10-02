import { createQueryTab, type QueryWorkspace } from './queryWorkspace'

export interface QuerySession {
  version: 1
  tabs: { title: string; sql: string }[]
  activeIndex: number
  nextTitle: number
}

/** Persist only authored text, never credentials, query results or server state. */
export function snapshotSession(workspace: QueryWorkspace): QuerySession {
  return {
    version: 1,
    tabs: workspace.tabs.map(tab => ({ title: tab.title, sql: tab.sql })),
    activeIndex: Math.max(0, workspace.tabs.findIndex(tab => tab.key === workspace.activeKey)),
    nextTitle: workspace.nextTitle,
  }
}

export function parseSession(value: unknown): QuerySession {
  if (!value || typeof value !== 'object') throw new Error('Invalid saved SQL session')
  const record = value as Partial<QuerySession>
  if (record.version !== 1) throw new Error('Unsupported saved SQL session version')
  if (!Array.isArray(record.tabs) || !record.tabs.length || record.tabs.some(tab => !tab || typeof tab.title !== 'string' || typeof tab.sql !== 'string')) {
    throw new Error('Invalid saved SQL tabs')
  }
  const activeIndex = typeof record.activeIndex === 'number' && Number.isInteger(record.activeIndex)
    ? Math.max(0, Math.min(record.tabs.length - 1, record.activeIndex)) : 0
  const minimumTitle = record.tabs.reduce((next, tab) => {
    const match = /^Query (\d+)$/.exec(tab.title)
    const title = match ? Number(match[1]) : 0
    return Number.isSafeInteger(title) ? Math.max(next, title + 1) : next
  }, 1)
  const nextTitle = typeof record.nextTitle === 'number' && Number.isSafeInteger(record.nextTitle) && record.nextTitle > 0
    ? Math.max(minimumTitle, record.nextTitle) : minimumTitle
  return { version: 1, tabs: record.tabs.map(tab => ({ title: tab.title, sql: tab.sql })), activeIndex, nextTitle }
}

export function restoreQuerySession(session: QuerySession, takeKey: () => string = () => crypto.randomUUID()): QueryWorkspace {
  const tabs = session.tabs.map(tab => createQueryTab(takeKey(), tab.title, tab.sql))
  return { tabs, activeKey: tabs[session.activeIndex]!.key, nextTitle: session.nextTitle }
}

/** Capture before queuing, serialize writes, and mark saved only after success.
 * A failed write leaves the newest snapshot retryable, not falsely 'saved'. */
export function createSessionWriter(write: (session: QuerySession) => Promise<void>) {
  let queue = Promise.resolve()
  let saved = ''
  return {
    markLoaded(session: QuerySession) { saved = JSON.stringify(session) },
    save(session: QuerySession): Promise<void> {
      const text = JSON.stringify(session)
      const result = queue.then(async () => {
        if (text === saved) return
        await write(JSON.parse(text) as QuerySession)
        saved = text
      })
      queue = result.catch(() => {})
      return result
    },
  }
}
