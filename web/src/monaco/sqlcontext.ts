// Pure SQL context helpers for hover and completion: which identifier is
// under a cursor offset, its dotted chain, and whether it is followed by `(`.
// The scanner skips strings, comments and dollar-quoted bodies (a cursor
// inside one has no identifier), while quoted identifiers become tokens so
// names like "My Col" resolve. Lexing is shared through sqlcache.ts, so the
// token list is built once per document version.

import { allLexemes, allTokens, firstAtOrAfter, type SqlToken } from '../lib/sqlcache'
import { dollarBody } from '../../../server/src/sqllex'

export interface IdentifierAt {
  /** Identifier text without surrounding quotes. */
  name: string
  /** Identifier text as written (quoted identifiers keep their quotes). */
  raw: string
  /** Offsets into the scanned text; `end` is exclusive. */
  start: number
  end: number
  /** Dotted chain the identifier belongs to, outermost first, each part as
   * written (so callers can fold it with normIdent). */
  chain: string[]
  quoted: boolean
}

/** Tokens of `text`; whitespace, strings, comments and dollar bodies skip. */
function tokenize(text: string): readonly SqlToken[] {
  return allTokens(text)
}

function rawOf(text: string, token: SqlToken): string {
  return token.quoted ? text.slice(token.start, token.end) : token.name
}

/** The identifier containing `offset`, with its dotted chain, or null. */
export function identifierAt(text: string, offset: number): IdentifierAt | null {
  const tokens = tokenize(text)
  // Tokens never overlap: only the last one starting at or before `offset`,
  // or the one just before it when it ends exactly at `offset`, can match;
  // the earlier of the two wins, as a left-to-right scan would pick it.
  const last = firstAtOrAfter(tokens, offset + 1) - 1
  let index = -1
  for (const k of [last - 1, last]) {
    const token = tokens[k]
    if (token?.kind === 'ident' && token.start <= offset && offset <= token.end) {
      index = k
      break
    }
  }
  if (index < 0) return null

  const token = tokens[index] as SqlToken
  const chain = [rawOf(text, token)]

  let k = index - 1
  while (
    k - 1 >= 0 &&
    tokens[k]?.kind === 'punct' &&
    tokens[k]?.name === '.' &&
    tokens[k - 1]?.kind === 'ident'
  ) {
    chain.unshift(rawOf(text, tokens[k - 1] as SqlToken))
    k -= 2
  }
  let m = index + 1
  while (
    m + 1 < tokens.length &&
    tokens[m]?.kind === 'punct' &&
    tokens[m]?.name === '.' &&
    tokens[m + 1]?.kind === 'ident'
  ) {
    chain.push(rawOf(text, tokens[m + 1] as SqlToken))
    m += 2
  }

  return {
    name: token.name,
    raw: rawOf(text, token),
    start: token.start,
    end: token.end,
    chain,
    quoted: token.quoted,
  }
}

/** The dollar-quoted token whose interior contains `offset`, or null. */
function dollarTokenAt(text: string, offset: number): { raw: string; start: number } | null {
  const lexemes = allLexemes(text)
  const lex = lexemes[firstAtOrAfter(lexemes, offset) - 1]
  return lex?.kind === 'dollar' && offset < lex.end ? { raw: lex.raw, start: lex.start } : null
}

/**
 * Span of the identifier the cursor is inside or immediately after, or null
 * when no identifier character precedes it. Quoted identifiers include their
 * quotes, so accepting a suggestion replaces `"My` rather than leaving a
 * dangling quote. The cursor strictly after a token's first character counts,
 * but sitting just before an identifier (e.g. `SELECT |FROM`) does not.
 */
export function identifierRangeAt(text: string, offset: number): { start: number; end: number } | null {
  // The lexer folds a whole dollar-quoted body into one token; rebase into it
  // so completion inside a routine body still replaces the typed symbol.
  const dollar = dollarTokenAt(text, offset)
  if (dollar) {
    const span = dollarBody(dollar.raw)
    const inner = dollar.raw.slice(span.start, span.end)
    const innerOffset = offset - dollar.start - span.start
    if (innerOffset >= 0 && innerOffset <= inner.length) {
      const range = identifierRangeAt(inner, innerOffset)
      const shift = dollar.start + span.start
      return range ? { start: range.start + shift, end: range.end + shift } : null
    }
  }
  const tokens = tokenize(text)
  const token = tokens[firstAtOrAfter(tokens, offset) - 1]
  return token?.kind === 'ident' && offset <= token.end ? { start: token.start, end: token.end } : null
}

/** True when the first token at or after `offset` is `(`. */
export function callSite(text: string, offset: number): boolean {
  const tokens = tokenize(text)
  const token = tokens[firstAtOrAfter(tokens, offset)]
  return token?.kind === 'punct' && token.name === '('
}
