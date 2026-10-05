import { desktop } from './desktop'

/** Serializable native file reference. Filesystem access stays in Electron. */
export interface FileHandle {
  readonly name: string
  readonly path: string
}

export interface SavedFile {
  fileName: string
  handle?: FileHandle
}

export interface WritableFileStream {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export function isPickerCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function createOutput(
  suggestedName: string, existing?: FileHandle, csv = false,
): Promise<{ handle: FileHandle; writable: WritableFileStream } | null> {
  const output = await desktop().files.begin({ suggestedName, existing, csv })
  if (!output) return null
  return {
    handle: output.handle,
    writable: {
      write: (text) => desktop().files.write(output.id, text),
      close: () => desktop().files.finish(output.id, true),
      abort: () => desktop().files.finish(output.id, false),
    },
  }
}

export async function saveTextFile(content: string, suggestedName: string, existingHandle?: FileHandle, pickName = !existingHandle): Promise<SavedFile | null> {
  const output = await createOutput(suggestedName, pickName ? undefined : existingHandle)
  if (!output) return null
  try {
    await output.writable.write(content)
    await output.writable.close()
    return { fileName: output.handle.name, handle: output.handle }
  } catch (error) {
    await output.writable.abort().catch(() => undefined)
    throw error
  }
}

export const openTextFiles = () => desktop().files.open()
export const readTextFileHandle = (handle: FileHandle) => desktop().files.read(handle)
