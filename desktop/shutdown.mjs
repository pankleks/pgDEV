/** Do not treat sending a kill request as proof that the backend has exited. */
export function stopBackend(child, { graceMs = 6000, killMs = 3000 } = {}) {
  if (!child.pid) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let killTimer
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      clearTimeout(graceTimer)
      clearTimeout(killTimer)
      child.removeListener('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    const force = () => {
      clearTimeout(graceTimer)
      try {
        if (!child.kill() && child.pid) return finish(new Error('Could not terminate the database service'))
        if (done) return
        if (!child.pid) return finish()
        killTimer = setTimeout(() => finish(new Error('Database service did not exit after termination')), killMs)
      } catch (error) { finish(error) }
    }
    const graceTimer = setTimeout(force, graceMs)
    child.once('exit', onExit)
    try { child.postMessage({ type: 'shutdown' }) }
    catch { force() }
  })
}
