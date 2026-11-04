import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { allTokens, allLexemes, firstAtOrAfter } = await load('web/lib/sqlcache.ts')
const sqllex = await load('server/sqllex.ts')
const { scanSqlLexemes } = sqllex

test('allTokens contains exactly the identifier and punctuation lexemes', () => {
  const text = "SELECT a.x, 'lit' /* c */ FROM t WHERE \"My Col\" = 1 -- end"
  const expected = []
  scanSqlLexemes(text, (lex) => {
    if (lex.kind === 'ident' || lex.kind === 'punct') {
      expected.push({ kind: lex.kind, start: lex.start, end: lex.end, raw: lex.raw, name: lex.name, quoted: lex.quoted })
    }
  })
  assert.deepEqual(allTokens(text), expected)
  // Quoted identifiers keep their raw text and expose the unquoted name.
  const quoted = allTokens(text).find((t) => t.quoted)
  assert.equal(quoted.raw, '"My Col"')
  assert.equal(quoted.name, 'My Col')
})

test('an edited text is re-lexed instead of serving the stale list', () => {
  const text = 'SELECT 1 FROM t'
  const first = allTokens(text)
  assert.equal(allTokens(text), first)
  assert.notEqual(allTokens(`${text} `), first)
})

test('the cache keeps a few texts, so alternating providers do not evict each other', () => {
  const doc = 'SELECT a FROM t; SELECT b FROM u'
  const before = doc.slice(0, 20)
  const inner = 'SELECT 1'
  const first = allLexemes(doc)
  allLexemes(before)
  allLexemes(inner)
  // Same content in a fresh string (as Monaco hands back) still hits.
  assert.equal(allLexemes(String(doc.split('').join(''))), first)
  // Beyond the slots, the least recently used text is dropped.
  for (let i = 0; i < 8; i++) allLexemes(`SELECT ${i}`)
  assert.notEqual(allLexemes(doc), first)
})

test('firstAtOrAfter finds the first item starting at or after an offset', () => {
  const items = [{ start: 0 }, { start: 3 }, { start: 3 }, { start: 7 }]
  assert.equal(firstAtOrAfter(items, -1), 0)
  assert.equal(firstAtOrAfter(items, 0), 0)
  assert.equal(firstAtOrAfter(items, 1), 1)
  assert.equal(firstAtOrAfter(items, 3), 1)
  assert.equal(firstAtOrAfter(items, 4), 3)
  assert.equal(firstAtOrAfter(items, 8), 4)
  assert.equal(firstAtOrAfter([], 5), 0)
})
