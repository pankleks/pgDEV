import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { explainSql } = await load('server/explain.ts')
const { parseExplainPlan, planGraph } = await load('web/lib/explain.ts')
const { createResults } = await load('web/composables/results.ts')

test('explain accepts one statement, quoted semicolons and trailing comments', () => {
  assert.equal(explainSql("SELECT ';'; -- trailing", 'explain', true), "EXPLAIN (VERBOSE, FORMAT JSON)\nSELECT ';'\n")
  assert.match(explainSql('SELECT 1', 'analyze', true), /^EXPLAIN \(ANALYZE, BUFFERS, VERBOSE, FORMAT JSON\)/)
  for (const sql of ['', '-- comment', 'SELECT 1; DELETE FROM users', 'SELECT 1; /* hi */ SELECT 2']) {
    assert.throws(() => explainSql(sql, 'explain', true), /exactly one statement/)
  }
  const sql = "SELECT 'a\\'; SELECT 2; -- '"
  assert.throws(() => explainSql(sql, 'explain', true), /exactly one statement/)
  assert.doesNotThrow(() => explainSql(sql, 'explain', false))
})

const fixture = [{ Plan: { 'Node Type': 'Hash Join', 'Total Cost': 100, Plans: [
  { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Total Cost': 60 },
  { 'Node Type': 'Hash', 'Total Cost': 20, Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'customers', 'Total Cost': 10 }] },
] } }]

test('JSON plans produce left-to-right edges from producers to consumers', () => {
  const plan = parseExplainPlan(JSON.stringify(fixture))
  assert.deepEqual(plan, fixture[0])
  assert.deepEqual(parseExplainPlan(fixture), plan)
  for (const invalid of [null, '{}', '[{}]', '[{"Plan":{"Node Type":"Result","Plans":{}}}]']) {
    assert.throws(() => parseExplainPlan(invalid))
  }
  const { nodes, edges } = planGraph(plan)
  assert.equal(nodes.length, 4)
  assert.equal(edges.length, 3)
  for (const edge of edges) {
    const source = nodes.find(node => node.id === edge.source)
    const target = nodes.find(node => node.id === edge.target)
    assert.ok(source.position.x < target.position.x)
    assert.equal(edge.markerEnd.type, 'arrowclosed')
    assert.equal(edge.markerEnd.color, '#b8d4ff')
    assert.equal(edge.markerEnd.width, 12)
    assert.match(edge.style, /stroke-width: 2.5px/)
  }
  assert.equal(nodes[0].data.metric, 'cost')
  assert.equal(nodes[0].data.share, 0.2)
  assert.ok(Math.abs(nodes.reduce((sum, node) => sum + node.data.share, 0) - 1) < 1e-12)
})

test('own-time shares subtract children, account for loops and total 100%', () => {
  const { nodes } = planGraph({ Plan: { 'Node Type': 'Nested Loop', 'Total Cost': 1000,
    'Actual Total Time': 10, 'Actual Loops': 1, Plans: [
      { 'Node Type': 'Seq Scan', 'Actual Total Time': 2, 'Actual Loops': 1 },
      { 'Node Type': 'Index Scan', 'Actual Total Time': 0.5, 'Actual Loops': 10 },
    ],
  } })
  assert.deepEqual(nodes.map(node => node.data.own), [3, 2, 5])
  assert.deepEqual(nodes.map(node => node.data.share), [0.3, 0.2, 0.5])
  assert.ok(nodes.every(node => node.data.metric === 'time'))
})

test('overlapping timings are clamped and normalized; zero totals never divide by zero', () => {
  const { nodes } = planGraph({ Plan: { 'Node Type': 'Gather', 'Actual Total Time': 4, 'Actual Loops': 1,
    Plans: [{ 'Node Type': 'Parallel Scan', 'Actual Total Time': 3, 'Actual Loops': 2 }],
  } })
  assert.deepEqual(nodes.map(node => node.data.own), [0, 6])
  assert.deepEqual(nodes.map(node => node.data.share), [0, 1])
  const zero = planGraph({ Plan: { 'Node Type': 'Result', 'Actual Total Time': 0, 'Actual Loops': 0 } })
  assert.equal(zero.nodes[0].data.share, 0)
})

test('explain shares transaction and run state, parses plans and resets on normal runs', async () => {
  const calls = []
  const results = createResults({ query: async (...args) => {
    calls.push(args)
    return { results: [{ kind: 'data', columns: ['QUERY PLAN'], columnTypes: ['json'], rows: [[JSON.stringify(fixture)]], rowCount: 1, truncated: false }], durationMs: 1 }
  } })
  await results.run('tab', 'db', 'SELECT 1', 'explain')
  const result = results.state.byTab.tab
  assert.equal(calls[0][4], 'explain')
  assert.equal(result.running, false)
  assert.deepEqual(result.grid.plan, fixture[0])
  assert.equal(result.sentSql, null, 'wrapped SQL errors must not mark positions in the editor')
  result.transactionId = 'txn'
  await results.run('tab', 'db', 'SELECT 1', 'analyze')
  assert.equal(calls[1][3], 'txn')
  await results.run('tab', 'db', 'SELECT 1')
  assert.equal(result.grid.plan, undefined)
})
