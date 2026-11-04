// Shared lexical cache for the Monaco IntelliSense providers.
//
// Every provider used to lex the whole document on each keystroke: completion
// for identifiers, calls and the query scope; hover and signature help for
// their own views. One text-keyed memo removes the duplicate passes.
// JavaScript compares string keys by value, so an unchanged editor value hits
// the cache even though Monaco hands back a fresh string. A single slot per
// shape is enough: only the focused document is served between edits, and a
// new edit simply replaces it (see SLOTS below for the few that coexist).
import { scanSqlLexemes, type SqlLexeme } from '../../../server/src/sqllex'

/** An identifier or punctuation lexeme (identifiers keep their quotes in
 * `raw`; `name` is unquoted; punctuation has `name === raw`). */
export type SqlToken = SqlLexeme & { kind: 'ident' | 'punct' }

/**
 * Index of the first item starting at or after `offset` (items sorted by
 * `start`, as lexemes and tokens are). `index - 1` is then the last item
 * starting before `offset`: the only one that can contain it.
 */
export function firstAtOrAfter(items: readonly { start: number }[], offset: number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (items[mid]!.start < offset) low = mid + 1
    else high = mid
  }
  return low
}

// A few slots, most recent first: one keystroke's providers alternate between
// the document, the text before the cursor and a routine's inner body, which
// would evict each other from a single slot. A miss compares lengths first, so
// lookups stay cheap; four slots bound the memory kept for large scripts.
const SLOTS = 4

function memo<T>(cache: { text: string; value: T }[], text: string, build: () => T): T {
  const index = cache.findIndex((entry) => entry.text === text)
  if (index === 0) return cache[0]!.value
  if (index > 0) {
    const [hit] = cache.splice(index, 1)
    cache.unshift(hit!)
    return hit!.value
  }
  const value = build()
  cache.unshift({ text, value })
  if (cache.length > SLOTS) cache.pop()
  return value
}

const lexemeCache: { text: string; value: SqlLexeme[] }[] = []
const tokenCache: { text: string; value: SqlToken[] }[] = []

/** Every lexeme of `text`, memoized by content. */
export function allLexemes(text: string): readonly SqlLexeme[] {
  return memo(lexemeCache, text, () => {
    const out: SqlLexeme[] = []
    scanSqlLexemes(text, (lex) => {
      out.push(lex)
    })
    return out
  })
}

/** Identifier and punctuation tokens of `text`, memoized by content. The
 * cached lexeme objects themselves, so no per-token copy is made. */
export function allTokens(text: string): readonly SqlToken[] {
  return memo(tokenCache, text, () =>
    allLexemes(text).filter((lex): lex is SqlToken => lex.kind === 'ident' || lex.kind === 'punct'))
}
