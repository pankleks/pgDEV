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
  subscribeAi(callback: (data: string) => void, status: (connected: boolean) => void): () => void
  onBeforeClose(callback: () => Promise<void>): () => void
  onBackendFailure(callback: () => void): () => void
  onStorageWarning(callback: (message: string) => void): () => void
}

declare global {
  interface Window { pgdevDesktop: DesktopApi }
}
