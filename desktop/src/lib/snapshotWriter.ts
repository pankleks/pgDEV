/** Capture before queuing, serialize writes, and mark saved only after success.
 * A failed write leaves the newest snapshot retryable, not falsely 'saved'. */
export function createSnapshotWriter<T>(write: (snapshot: T) => Promise<void>) {
  let queue = Promise.resolve()
  let saved = ''
  return {
    markLoaded(snapshot: T) { saved = JSON.stringify(snapshot) },
    save(snapshot: T): Promise<void> {
      const text = JSON.stringify(snapshot)
      const result = queue.then(async () => {
        if (text === saved) return
        await write(JSON.parse(text) as T)
        saved = text
      })
      queue = result.catch(() => {})
      return result
    },
  }
}
