import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createApp } from '../../server/dist/app.js'
import { setPool, removePool } from '../../server/dist/pools.js'
import { hasOpenTransaction } from '../../server/dist/queryshape.js'
import { splitStatements } from '../../server/dist/sqlsplit.js'

test('explicit transaction validation accounts for savepoints, chaining and comments', () => {
  for (const sql of [
    'BEGIN', 'BEGIN; UPDATE t SET x = 1',
    'START /* comment */ TRANSACTION; SELECT 1',
    'BEGIN; SAVEPOINT s; ROLLBACK TO SAVEPOINT s',
    'BEGIN; COMMIT AND CHAIN', 'ROLLBACK WORK AND CHAIN',
    'BEGIN; COMMIT; BEGIN; SELECT 1',
  ]) assert.equal(hasOpenTransaction(splitStatements(sql)), true, sql)
  for (const sql of [
    'SELECT 1', "SELECT 'BEGIN; COMMIT AND CHAIN'",
    'BEGIN; UPDATE t SET x = 1; COMMIT',
    'BEGIN; UPDATE t SET x = 1; ROLLBACK',
    'BEGIN; SAVEPOINT s; ROLLBACK TO s; END',
    'BEGIN; COMMIT AND CHAIN; ROLLBACK',
    'BEGIN; COMMIT AND NO CHAIN',
    '/* BEGIN */ SELECT 1; -- START TRANSACTION',
  ]) assert.equal(hasOpenTransaction(splitStatements(sql)), false, sql)
})

/** A fake pooled client that records statements and releases. */
function fakePool(options = {}) {
  const executed = []
  const state = { releases: 0, connects: 0, held: [] }
  const client = {
    connection: new EventEmitter(),
    on() {},
    removeListener() {},
    // Synchronous by design: boundedQuery submits a Query object and ignores
    // the return value, so a failure must throw inside its Promise executor.
    query(query) {
      const text = typeof query === 'string' ? query : query.text
      executed.push(text)
      if (text === 'SHOW standard_conforming_strings') {
        return { fields: [], rows: [{ standard_conforming_strings: 'on' }], command: 'SHOW', rowCount: 1 }
      }
      if (options.fail && text.includes(options.fail)) {
        throw Object.assign(new Error(`boom: ${text}`), options.failCode ? { code: options.failCode, position: options.failPosition } : {})
      }
      // Statements matching `hold` stay in flight: the Query object is kept so
      // the test can complete (or fail) it later, simulating a cancel race.
      if (options.hold && text.includes(options.hold)) {
        if (typeof query.emit === 'function') {
          state.held.push(query)
          return { fields: [], rows: [], command: 'OK', rowCount: 1 }
        }
        // A plain query (e.g. the DECLARE of a cursor) settles when the test
        // emits 'end' or 'error' on the held handle, like a Query object.
        const handle = new EventEmitter()
        state.held.push(handle)
        return new Promise((resolve, reject) => {
          handle.once('end', resolve)
          handle.once('error', reject)
        })
      }
      if (options.fetchAll && text.startsWith('FETCH FORWARD')) {
        // An endless result: every FETCH is filled to the requested count.
        const count = Number(text.match(/FETCH FORWARD (\d+)/)[1])
        return { fields: [{ name: 'n', tableID: 0, dataTypeID: 23, dataTypeModifier: -1 }], rows: Array.from({ length: count }, (_, i) => [i]) }
      }
      if (typeof query.emit === 'function') {
        queueMicrotask(() => query.emit('end', { fields: [], rows: [], command: 'OK', rowCount: 1 }))
      }
      return { fields: [], rows: [], command: 'OK', rowCount: 1 }
    },
    release() {
      state.releases++
    },
  }
  return {
    executed,
    state,
    client,
    pool: {
      async connect() {
        state.connects++
        return client
      },
      async end() {},
    },
  }
}

async function withApp(id, fake, run) {
  // Scratch token file: building the app must not touch the user's real one.
  const app = await createApp({
    serveStatic: false,
    aiTokenFile: join(tmpdir(), `pgdev_aitoken_${process.pid}`),
  })
  setPool(id, fake.pool)
  const inject = (sql) =>
    app.inject({
      method: 'POST',
      url: `/api/connections/${id}/query`,
      headers: { origin: 'http://localhost' },
      payload: { sql },
    })
  try {
    await run(inject, app)
  } finally {
    await removePool(id)
    await app.close()
    rmSync(join(tmpdir(), `pgdev_aitoken_${process.pid}`), { force: true })
  }
}

test('an unfinished transaction pins its client until COMMIT releases it', async () => {
  const fake = fakePool()
  await withApp('manual-txn-test', fake, async (inject) => {
    fake.executed.length = 0
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, true)
    assert.ok(fake.executed.includes('BEGIN'), JSON.stringify(fake.executed))
    assert.ok(fake.executed.includes('UPDATE t SET x = 1'), JSON.stringify(fake.executed))
    assert.equal(fake.state.releases, 0, 'the open transaction keeps its client')
    assert.equal(fake.state.connects, 1)

    fake.executed.length = 0
    response = await inject('COMMIT')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, false)
    assert.ok(fake.executed.includes('COMMIT'), JSON.stringify(fake.executed))
    assert.equal(fake.state.releases, 1, 'COMMIT ends the session and releases the client')
  })
})

test('COMMIT AND CHAIN keeps a transaction open and ROLLBACK closes it', async () => {
  const fake = fakePool()
  await withApp('chain-txn-test', fake, async (inject) => {
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.json().transactionOpen, true)

    response = await inject('COMMIT AND CHAIN')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, true, 'a chained commit opens a new transaction')
    assert.equal(fake.state.releases, 0)

    response = await inject('ROLLBACK')
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('a failed statement inside an open transaction keeps it open for ROLLBACK', async () => {
  const fake = fakePool({ fail: 'explode' })
  await withApp('aborted-txn-test', fake, async (inject) => {
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.json().transactionOpen, true)

    response = await inject('SELECT explode()')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /boom/)
    assert.equal(fake.state.releases, 0, 'the aborted transaction is still pinned')

    response = await inject('ROLLBACK')
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('an error in the batch that opened the transaction keeps it open for ROLLBACK, like a later batch', async () => {
  const fake = fakePool({ fail: 'explode' })
  await withApp('opening-error-test', fake, async (inject) => {
    fake.executed.length = 0
    const response = await inject('BEGIN; UPDATE t SET x = 1; SELECT explode()')
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /boom/)
    assert.equal(response.json().transactionOpen, true, 'the work before the error is not silently discarded')
    assert.equal(fake.state.releases, 0, 'the aborted transaction stays pinned')
    assert.ok(!fake.executed.includes('ROLLBACK'), JSON.stringify(fake.executed))

    // The user's ROLLBACK runs on the pinned client and ends it.
    const rollback = await inject('ROLLBACK')
    assert.equal(rollback.statusCode, 200)
    assert.equal(rollback.json().transactionOpen, false)
    assert.equal(fake.state.connects, 1)
    assert.equal(fake.state.releases, 1)
  })
})

test('an error before the user opened a transaction still rolls the implicit one back', async () => {
  const fake = fakePool({ fail: 'explode' })
  await withApp('implicit-error-test', fake, async (inject) => {
    const response = await inject('UPDATE t SET x = 1; SELECT explode()')
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().transactionOpen, false)
    assert.ok(fake.executed.includes('ROLLBACK'))
    assert.equal(fake.state.releases, 1)
  })
})

test('a tab closed while its opening batch fails keeps nothing', async () => {
  const fake = fakePool({ hold: 'pg_sleep' })
  await withApp('close-failing-open-test', fake, async (inject, app) => {
    const running = inject('BEGIN; UPDATE t SET x = 1; SELECT pg_sleep(60)')
    for (let waited = 0; !fake.state.held.length && waited < 1000; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await app.inject({
      method: 'POST', url: '/api/connections/close-failing-open-test/query/close',
      headers: { origin: 'http://localhost' }, payload: { tabKey: '' },
    })
    fake.state.held[0].emit('error', Object.assign(new Error('query canceled'), { code: '57014' }))
    const outcome = await running
    assert.equal(outcome.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('closing a busy transaction tab rolls it back instead of pinning the client', async () => {
  const fake = fakePool({ hold: 'pg_sleep' })
  await withApp('close-busy-test', fake, async (inject, app) => {
    const begun = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(begun.json().transactionOpen, true)
    assert.equal(fake.state.releases, 0, 'the transaction pins its client')

    // A long statement on the pinned session while the tab is closed.
    const running = inject('SELECT pg_sleep(60)')
    for (let waited = 0; !fake.state.held.length && waited < 1000; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(fake.state.held.length, 1, 'the statement is in flight')

    const close = await app.inject({
      method: 'POST',
      url: `/api/connections/close-busy-test/query/close`,
      headers: { origin: 'http://localhost' },
      payload: { tabKey: '' },
    })
    assert.equal(close.statusCode, 200, JSON.stringify(close.json()))

    // The canceled statement unwinds as a query error; the session must not
    // survive the close it was flagged for.
    fake.state.held[0].emit('error', Object.assign(new Error('query canceled'), { code: '57014' }))
    const outcome = await running
    assert.equal(outcome.statusCode, 400)
    assert.equal(fake.state.releases, 1, 'the closed tab releases the pinned client')

    // The tab is clean again: a new run checks out a fresh client.
    fake.state.held.length = 0
    const next = await inject('SELECT 1')
    assert.equal(next.statusCode, 200)
    assert.equal(fake.state.connects, 2)
  })
})

test('closing a tab while its first batch runs abandons instead of retaining', async () => {
  const fake = fakePool({ hold: 'pg_sleep' })
  await withApp('close-during-open-test', fake, async (inject, app) => {
    // The batch that would FIRST create the transaction session is still in
    // flight when the tab closes.
    const running = inject('BEGIN; UPDATE t SET x = 1; SELECT pg_sleep(60)')
    for (let waited = 0; !fake.state.held.length && waited < 1000; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(fake.state.held.length, 1, 'the statement is in flight')

    const close = await app.inject({
      method: 'POST',
      url: `/api/connections/close-during-open-test/query/close`,
      headers: { origin: 'http://localhost' },
      payload: { tabKey: '' },
    })
    assert.equal(close.statusCode, 200, JSON.stringify(close.json()))

    // The statement completes before the cancel takes effect: the batch must
    // not retain a transaction for a tab that no longer exists.
    fake.state.held[0].emit('end', { fields: [], rows: [], command: 'OK', rowCount: 1 })
    const outcome = await running
    assert.equal(outcome.statusCode, 200, JSON.stringify(outcome.json()))
    assert.equal(outcome.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1, 'the abandoned batch releases its client')
    assert.ok(fake.executed.includes('ROLLBACK'), JSON.stringify(fake.executed))

    // A later run on the same tab key retains normally again.
    fake.state.held.length = 0
    const next = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(next.json().transactionOpen, true)
    assert.equal(fake.state.releases, 1, 'the fresh run keeps its client')
  })
})

test('API still accepts complete explicit transactions and ordinary batches', async () => {
  const fake = fakePool()
  await withApp('complete-transaction-test', fake, async (inject) => {
    for (const sql of [
      'BEGIN; UPDATE t SET x = 1; COMMIT',
      'BEGIN; UPDATE t SET x = 1; ROLLBACK',
      'BEGIN; UPDATE t SET x = 1; COMMIT AND CHAIN; ROLLBACK',
      'UPDATE t SET x = 1',
    ]) {
      fake.executed.length = 0
      const response = await inject(sql)
      assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
      assert.equal(response.json().transactionOpen, false, sql)
      for (const stmt of splitStatements(sql)) assert.ok(fake.executed.includes(stmt), stmt)
    }
  })
})

test('session state is reset before a client returns to the pool, never while it is pinned', async () => {
  const fake = fakePool()
  await withApp('discard-test', fake, async (inject) => {
    fake.executed.length = 0
    let response = await inject("SET ROLE someone; SELECT set_config('search_path', 'evil', false)")
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(fake.executed.at(-1), 'DISCARD ALL', JSON.stringify(fake.executed))
    assert.equal(fake.state.releases, 1)

    fake.executed.length = 0
    response = await inject('BEGIN; SET search_path = x')
    assert.equal(response.json().transactionOpen, true)
    assert.ok(!fake.executed.includes('DISCARD ALL'), 'a pinned transaction keeps its state')

    fake.executed.length = 0
    response = await inject('COMMIT')
    assert.deepEqual(fake.executed.slice(-2), ['COMMIT', 'DISCARD ALL'])
    assert.equal(fake.state.releases, 2)
  })
})

test('a failed COMMIT ends the transaction instead of reporting it open', async () => {
  // A deferred constraint or serialization failure at COMMIT rolls the
  // transaction back server-side; the tab must not keep a phantom one.
  const fake = fakePool({ fail: 'COMMIT' })
  await withApp('failed-commit-test', fake, async (inject) => {
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.json().transactionOpen, true)

    fake.executed.length = 0
    response = await inject('COMMIT')
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().transactionOpen, false, JSON.stringify(response.json()))
    assert.equal(fake.state.releases, 1, 'the client is released, not kept pinned')
    assert.ok(fake.executed.includes('DISCARD ALL'), JSON.stringify(fake.executed))
    assert.ok(!fake.executed.includes('ROLLBACK'), 'nothing is left to roll back')
  })
})

test('PREPARE TRANSACTION detaches the transaction from the tab', async () => {
  const fake = fakePool()
  await withApp('prepare-txn-test', fake, async (inject) => {
    let response = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(response.json().transactionOpen, true)
    response = await inject("PREPARE TRANSACTION 'gid'")
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.equal(response.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('a failed COMMIT in a batch that opened its own transaction is not rolled back twice', async () => {
  const fake = fakePool({ fail: 'COMMIT' })
  await withApp('failed-commit-batch-test', fake, async (inject) => {
    fake.executed.length = 0
    const response = await inject('BEGIN; UPDATE t SET x = 1; COMMIT')
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().transactionOpen, false)
    assert.equal(fake.state.releases, 1)
  })
})

test('a request rejected as already running does not hide a later close from the running batch', async () => {
  const fake = fakePool({ hold: 'pg_sleep' })
  await withApp('close-after-reject-test', fake, async (inject, app) => {
    const running = inject('BEGIN; UPDATE t SET x = 1; SELECT pg_sleep(60)')
    for (let waited = 0; !fake.state.held.length && waited < 1000; waited++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.equal(fake.state.held.length, 1, 'the statement is in flight')

    // A second run on the same tab is refused while the first is running.
    const rejected = await inject('SELECT 1')
    assert.notEqual(rejected.statusCode, 200)

    const close = await app.inject({
      method: 'POST',
      url: `/api/connections/close-after-reject-test/query/close`,
      headers: { origin: 'http://localhost' },
      payload: { tabKey: '' },
    })
    assert.equal(close.statusCode, 200)

    fake.state.held[0].emit('end', { fields: [], rows: [], command: 'OK', rowCount: 1 })
    const outcome = await running
    assert.equal(outcome.json().transactionOpen, false, 'the closed tab must not keep a transaction')
    assert.ok(fake.executed.includes('ROLLBACK'), JSON.stringify(fake.executed))
    assert.equal(fake.state.releases, 1)
  })
})

test('a cancel or timeout during DECLARE is the outcome, not a reason to re-run the statement', async () => {
  for (const code of ['57014', '55P03', '40001']) {
    const fake = fakePool({ fail: 'DECLARE', failCode: code })
    await withApp(`declare-${code}-test`, fake, async (inject) => {
      fake.executed.length = 0
      const response = await inject('SELECT pg_sleep(60)')
      assert.equal(response.statusCode, 400, code)
      assert.equal(response.json().code, code)
      const direct = fake.executed.filter((text) => text === 'SELECT pg_sleep(60)')
      assert.equal(direct.length, 0, `${code}: the statement must not run again without the cursor`)
      assert.ok(fake.executed.includes('ROLLBACK'), JSON.stringify(fake.executed))
    })
  }
})

test('a statement DECLARE cannot take still falls back to direct execution', async () => {
  const fake = fakePool({ fail: 'DECLARE', failCode: '42601' })
  await withApp('declare-fallback-test', fake, async (inject) => {
    fake.executed.length = 0
    const response = await inject('SHOW search_path')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    assert.ok(fake.executed.includes('ROLLBACK TO SAVEPOINT pgdev_sp'))
    assert.ok(fake.executed.includes('SHOW search_path'))
  })
})

test('an error raised at DECLARE points into the statement, not the DECLARE prefix', async () => {
  const prefix = 'DECLARE "pgdev_cur_1" NO SCROLL CURSOR FOR '
  const fake = fakePool({ fail: 'DECLARE', failCode: '22012', failPosition: String(prefix.length + 8) })
  await withApp('declare-position-test', fake, async (inject) => {
    const response = await inject('SELECT 1/0')
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().position, '8')
  })
})

test('a query inside a user transaction produces only the displayed rows', async () => {
  const fake = fakePool({ fetchAll: true })
  await withApp('bounded-txn-test', fake, async (inject) => {
    await inject('BEGIN; UPDATE t SET x = 1')
    fake.executed.length = 0
    const response = await inject('SELECT n FROM big_table')
    assert.equal(response.statusCode, 200, JSON.stringify(response.json()))
    const data = response.json().results[0]
    assert.equal(data.limited, true, 'rows past the limit are reported as not retained')
    assert.equal(data.truncated, false, 'nothing pages inside a user transaction')
    const sent = fake.executed
    const declare = sent.findIndex((text) => /^DECLARE "pgdev_cur_\d+" NO SCROLL CURSOR FOR SELECT n FROM big_table$/.test(text))
    assert.ok(declare > 0, JSON.stringify(sent))
    assert.equal(sent[declare - 1], 'SAVEPOINT pgdev_sp')
    assert.equal(sent[declare + 1], 'RELEASE SAVEPOINT pgdev_sp', 'no subtransaction is left in the user transaction')
    assert.match(sent[declare + 2], /^FETCH FORWARD \d+ FROM/)
    assert.match(sent[declare + 3], /^CLOSE "pgdev_cur_\d+"$/)
    assert.ok(!sent.includes('SELECT n FROM big_table'), 'the query is not also streamed directly')
    assert.equal(response.json().transactionOpen, true)

    // Statements that do not return rows still run directly.
    fake.executed.length = 0
    await inject('UPDATE t SET x = 2')
    assert.deepEqual(fake.executed.filter((text) => !text.startsWith('SELECT oid')), ['UPDATE t SET x = 2'])
  })
})

test('a pool checkout timeout explains which tabs pin the connections', async () => {
  const fake = fakePool()
  let exhausted = false
  const connect = fake.pool.connect
  fake.pool.options = { max: 10 }
  fake.pool.connect = async () => {
    if (exhausted) throw new Error('timeout exceeded when trying to connect')
    return connect()
  }
  await withApp('busy-pool-test', fake, async (inject, app) => {
    const opened = await inject('BEGIN; UPDATE t SET x = 1')
    assert.equal(opened.json().transactionOpen, true)
    exhausted = true
    const other = await app.inject({
      method: 'POST', url: '/api/connections/busy-pool-test/query',
      headers: { origin: 'http://localhost' }, payload: { sql: 'SELECT 1', tabKey: 'other' },
    })
    assert.notEqual(other.statusCode, 200)
    assert.match(other.json().error, /All 10 database connections are busy; 1 tab holds an open transaction \(COMMIT or ROLLBACK to free them\)/)
  })
})
