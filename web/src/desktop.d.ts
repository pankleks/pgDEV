import type { FileHandle } from './lib/files'
import type { StoredAppState } from './lib/storage'
import type { TabSession } from './lib/tabsession'

export interface DesktopApi {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>
  storage: {
    load(): Promise<StoredAppState & { session?: TabSession; warnings: string[] }>
    write(kind: 'settings' | 'connections' | 'pinnedFiles' | 'session', value: unknown): Promise<{ warnings: string[] }>
  }
  files: {
    open(): Promise<{ fileName: string; content: string; handle: FileHandle }[]>
    read(file: FileHandle): Promise<{ fileName: string; content: string; handle: FileHandle }>
    begin(options: { suggestedName: string; existing?: FileHandle; csv?: boolean }): Promise<{ id: string; handle: FileHandle } | null>
    write(id: string, text: string): Promise<void>
    finish(id: string, commit: boolean): Promise<void>
  }
  copyText(text: string): Promise<void>
  confirm(message: string): Promise<boolean>
  updates: {
    /** Ask whether a newer release exists (cached for an hour unless forced). */
    check(force?: boolean): Promise<UpdateCheck>
    /** Open the checked release page, or this installation's download. */
    open(kind: 'release' | 'download'): Promise<void>
  }
  subscribeAi(callback: (data: string) => void, status: (connected: boolean) => void): () => void
  onBeforeClose(callback: () => Promise<void>): () => void
  onBackendFailure(callback: () => void): () => void
  onStorageWarning(callback: (message: string) => void): () => void
}

/** How to update this installation (see desktop/updates.mjs). */
export interface UpdateInstruction {
  target: 'deb' | 'rpm' | 'mac' | 'win-setup' | 'win-portable'
  label: string
  note: string
  /** A shell/PowerShell command to copy; absent when `download` is set. */
  command?: string
  /** Update by downloading a file (Windows portable). */
  download?: boolean
}

export interface AvailableUpdate {
  version: string
  name: string
  publishedAt: string
  /** Release notes (GitHub Markdown), capped. */
  notes: string
  notesTruncated: boolean
  url: string
  instructions: UpdateInstruction[]
}

export interface UpdateCheck {
  current: string
  /** False in development builds and tests: nothing is checked. */
  enabled: boolean
  update: AvailableUpdate | null
}

declare global {
  interface Window { pgdevDesktop: DesktopApi }
}
