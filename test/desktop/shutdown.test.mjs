import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { stopBackend } from '../../desktop/shutdown.mjs'

function backend() {
  return Object.assign(new EventEmitter(), {
    pid: 123, killed: false,
    postMessage(message) { assert.deepEqual(message, { type: 'shutdown' }) },
    kill() { this.killed = true; return true },
    exit() { this.pid = undefined; this.emit('exit', 0) },
  })
}

test('backend shutdown waits for exit, including after a forced kill', async () => {
  const child = backend()
  let finished = false
  const stopped = stopBackend(child, { graceMs: 5, killMs: 1000 }).then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(child.killed, true)
  assert.equal(finished, false, 'sending kill must not resolve shutdown')
  child.exit()
  await stopped
  assert.equal(finished, true)
  assert.equal(child.listenerCount('exit'), 0)
})

test('graceful and already-exited backends need no forced kill', async () => {
  const child = backend()
  const stopped = stopBackend(child)
  child.exit()
  await stopped
  await stopBackend(child)
  assert.equal(child.killed, false)
})

test('failed termination and missing exit are reported rather than accepted', async () => {
  const refused = backend()
  refused.kill = () => false
  await assert.rejects(stopBackend(refused, { graceMs: 1, killMs: 1 }), /Could not terminate/)
  const stuck = backend()
  await assert.rejects(stopBackend(stuck, { graceMs: 1, killMs: 1 }), /did not exit/)
  assert.equal(stuck.listenerCount('exit'), 0)
})

test('a broken shutdown channel falls back to kill and still waits for exit', async () => {
  const child = backend()
  child.postMessage = () => { throw new Error('channel closed') }
  const stopped = stopBackend(child)
  assert.equal(child.killed, true)
  child.exit()
  await stopped
})
