// The renderer's subscription to the backend's AI bridge (an SSE stream),
// relayed over IPC. Kept free of Electron so the start/stop race is testable:
// the renderer unsubscribes and resubscribes on remount, and a start landing
// while a stop is still unwinding must not be swallowed by that stop.

/**
 * @param {object} deps
 * @param {(signal: AbortSignal) => Promise<Response>} deps.fetchBridge
 * @param {(channel: string, payload: unknown) => void} deps.send
 * @param {number} [deps.retryMs]
 */
export function createAiSubscription({ fetchBridge, send, retryMs = 1000 }) {
  let current
  let task

  function start() {
    // A stop still unwinding has already aborted its controller: subscribe
    // again rather than treating the dying subscription as the live one.
    if (current && !current.signal.aborted) return
    const controller = new AbortController()
    current = controller
    task = (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetchBridge(controller.signal)
          if (!response.ok || !response.body) throw new Error('Bridge unavailable')
          send('pgdev:ai-status', true)
          let pending = ''
          for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
            pending += chunk.replace(/\r\n/g, '\n')
            let end
            while ((end = pending.indexOf('\n\n')) !== -1) {
              const event = pending.slice(0, end)
              pending = pending.slice(end + 2)
              const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
              if (data) send('pgdev:ai-message', data)
            }
            if (pending.length > 8 * 1024 * 1024) throw new Error('Bridge event too large')
          }
        } catch { /* Reconnect without replaying database work. */ }
        // A replaced subscription must not report "disconnected" over the new one.
        if (current === controller) send('pgdev:ai-status', false)
        if (!controller.signal.aborted) await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs))
      }
    })()
  }

  async function stop() {
    const controller = current
    const ending = task
    controller?.abort()
    await ending
    // Clear only the subscription this stop ended; a newer start owns its own.
    if (current === controller) current = undefined
  }

  /** Abort without waiting (app shutdown). */
  function abort() {
    current?.abort()
  }

  return { start, stop, abort }
}
