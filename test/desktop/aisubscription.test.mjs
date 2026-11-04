import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAiSubscription } from '../../desktop/aisubscription.mjs'

/** A bridge whose streams stay open until aborted, delivering `events` first. */
function bridge(events = []) {
  const calls = []
  const fetchBridge = (signal) => {
    calls.push(signal)
    const body = new ReadableStream({
      start(controller) {
        for (const data of events) controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
        signal.addEventListener('abort', () => controller.error(new Error('aborted')))
      },
    })
    return Promise.resolve({ ok: true, body })
  }
  return { calls, fetchBridge }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('messages are relayed and a stop ends the subscription', async () => {
  const b = bridge(['{"a":1}'])
  const sent = []
  const ai = createAiSubscription({ fetchBridge: b.fetchBridge, send: (c, p) => sent.push([c, p]) })
  ai.start()
  await tick()
  assert.deepEqual(sent.slice(0, 2), [['pgdev:ai-status', true], ['pgdev:ai-message', '{"a":1}']])
  await ai.stop()
  assert.deepEqual(sent.at(-1), ['pgdev:ai-status', false])
  assert.equal(b.calls.length, 1)
})

test('a second start while subscribed is a no-op', async () => {
  const b = bridge()
  const ai = createAiSubscription({ fetchBridge: b.fetchBridge, send: () => {} })
  ai.start()
  ai.start()
  await tick()
  assert.equal(b.calls.length, 1)
  await ai.stop()
})

test('a start that lands while a stop unwinds survives that stop', async () => {
  const b = bridge()
  const sent = []
  const ai = createAiSubscription({ fetchBridge: b.fetchBridge, send: (c, p) => sent.push([c, p]) })
  ai.start()
  await tick()
  // Unsubscribe and resubscribe without waiting, as a remount does.
  const stopping = ai.stop()
  ai.start()
  await stopping
  await tick()
  assert.equal(b.calls.length, 2, 'the new start opened its own stream')
  assert.equal(b.calls[1].aborted, false, 'and the earlier stop did not end it')
  assert.deepEqual(sent.at(-1), ['pgdev:ai-status', true], 'the old stream did not report disconnected over it')
  // The surviving subscription is still the one a later stop ends.
  await ai.stop()
  assert.equal(b.calls[1].aborted, true)
})
