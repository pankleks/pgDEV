import { scanSqlLexemes, type SqlLexState, type SqlLexeme } from './sqllex.js'

// Split SQL text into individual statements on top-level semicolons.
// Aware of single-quoted strings ('' escape), double-quoted identifiers,
// line/block comments, and dollar-quoted bodies ($$…$$, $tag$…$tag$),
// so function bodies and literals containing `;` stay intact. The lexing
// itself lives in sqllex.ts, shared with the query router and the agent gate.

const GUC = 'standard_conforming_strings'
/** Only the first few real tokens of a statement can form the SET that flips
 * the string mode; the buffer is capped accordingly. */
const SCS_WINDOW = 10

export interface StatementWithOffset {
  /** Trimmed statement text (same as `splitStatements()` returns). */
  text: string
  /** 0-based offset of the trimmed statement's first char in the original SQL. */
  start: number
}

export interface SplitOptions {
  standardConformingStrings?: boolean
  /** The batch runner normally supplies an implicit transaction. */
  inTransaction?: boolean
}

export function splitStatements(sql: string, options: SplitOptions = {}): string[] {
  return splitStatementsWithOffsets(sql, options).map((s) => s.text)
}

/** Read exactly one statement using the server's current lexical setting.
 * Execution calls this again after each response, never pre-splitting SQL
 * whose string mode may be changed by a preceding statement or routine. */
export function nextStatement(sql: string, offset: number, standardConformingStrings: boolean): (StatementWithOffset & { end: number }) | null {
  while (offset < sql.length) {
    const remaining = sql.slice(offset)
    let end = remaining.length
    let consumed = remaining.length
    scanSqlLexemes(remaining, (lex) => {
      if (lex.kind === 'punct' && lex.raw === ';') {
        end = lex.start
        consumed = lex.end
        return false
      }
    }, { standardConformingStrings })
    const segment = remaining.slice(0, end)
    const text = segment.trim()
    const start = offset + Math.max(0, segment.search(/\S/))
    offset += consumed
    if (text) return { text, start, end: offset }
  }
  return null
}

export function splitStatementsWithOffsets(sql: string, options: SplitOptions = {}): StatementWithOffset[] {
  const out: StatementWithOffset[] = []
  const initial = options.standardConformingStrings ?? true
  const state: SqlLexState = { standardConformingStrings: initial }
  let sessionMode = initial
  let transactionMode = initial
  let inTransaction = options.inTransaction ?? true
  const savepoints: { name: string; session: boolean; effective: boolean }[] = []
  const lastSavepoint = (name: string | undefined): number => {
    for (let i = savepoints.length - 1; i >= 0; i--) if (savepoints[i].name === name) return i
    return -1
  }
  /** Real (non-whitespace, non-comment) lexemes of the statement being
   * assembled, capped. Comments never matter for the SET pattern, so they
   * must not consume the window. */
  let tokens: SqlLexeme[] = []
  /** Original offset just past the previous top-level `;` (start of the
   * current segment). */
  let segStart = 0

  const finish = (segEnd: number) => {
    const segment = sql.slice(segStart, segEnd)
    const text = segment.trim()
    if (text) {
      // `trim()` strips whitespace only, so the first surviving char is the
      // first non-whitespace char of the segment (comments are preserved).
      const leading = segment.search(/\S/)
      const start = leading === -1 ? segEnd : segStart + leading
      out.push({ text, start })
      const word = (i: number) => tokens[i]?.kind === 'ident' && !tokens[i]?.quoted ? tokens[i]?.name.toLowerCase() : ''
      const name = (i: number) => tokens[i]?.quoted ? tokens[i]?.name : word(i)
      const command = word(0)
      const setting = trackStandardConformingStrings(tokens)
      if (command === 'begin' || (command === 'start' && word(1) === 'transaction')) {
        if (!inTransaction) transactionMode = sessionMode
        inTransaction = true
      } else if (command === 'savepoint' && inTransaction) {
        savepoints.push({ name: name(1) ?? '', session: sessionMode, effective: state.standardConformingStrings })
      } else if (command === 'release') {
        const key = name(word(1) === 'savepoint' ? 2 : 1)
        const index = lastSavepoint(key)
        if (index >= 0) savepoints.splice(index)
      } else if (['commit', 'end', 'rollback', 'abort'].includes(command)) {
        let k = 1
        if (word(k) === 'work' || word(k) === 'transaction') k++
        if (word(k) === 'to') {
          k++
          if (word(k) === 'savepoint') k++
          const index = lastSavepoint(name(k))
          const saved = savepoints[index]
          if (saved) {
            sessionMode = saved.session
            state.standardConformingStrings = saved.effective
            savepoints.splice(index + 1)
          }
        } else if (word(k) !== 'prepared') {
          if (command === 'rollback' || command === 'abort') sessionMode = transactionMode
          state.standardConformingStrings = sessionMode
          savepoints.length = 0
          inTransaction = word(k) === 'and' && word(k + 1) === 'chain'
          transactionMode = sessionMode
        }
      } else if (setting) {
        const local = word(1) === 'local'
        if (!local) sessionMode = setting === 'on'
        if (!local || inTransaction) state.standardConformingStrings = setting === 'on'
      }
    }
    tokens = []
  }

  scanSqlLexemes(sql,
    (lex) => {
      if (lex.kind === 'punct' && lex.raw === ';') {
        finish(lex.start)
        segStart = lex.end
        return
      }
      // The SET that flips the mode must start its own statement, so only a
      // few leading tokens can ever matter (a spelling of the GUC name inside
      // a string literal, comment or deep expression is data, not a setting).
      if (
        lex.kind !== 'whitespace' && lex.kind !== 'lineComment' && lex.kind !== 'blockComment' &&
        tokens.length < SCS_WINDOW
      ) tokens.push(lex)
    },
    state,
  )
  finish(sql.length)
  return out
}

/** Classify the leading `SET [LOCAL | SESSION] standard_conforming_strings
 * {TO | =} on|off` of a token run — bare-word occurrences only, so the same
 * spelling inside a literal or a comparison can never flip the string mode.
 * Returns the setting, or null when the statement does not set the GUC. */
function trackStandardConformingStrings(tokens: SqlLexeme[]): 'on' | 'off' | null {
  const word = (idx: number): string | null => {
    const t = tokens[idx]
    return t && t.kind === 'ident' && !t.quoted ? t.name.toLowerCase() : null
  }
  let k = 0
  if (word(k) !== 'set') return null
  k++
  const scope = word(k)
  if (scope === 'local' || scope === 'session') k++
  if (word(k) !== GUC) return null
  k++
  const sep = tokens[k]
  if (sep?.kind === 'ident' && !sep.quoted && sep.name.toLowerCase() === 'to') {
    k++
  } else if (sep?.kind === 'punct' && sep.raw === '=') {
    k++
  } else {
    return null
  }
  const value = tokens[k]
  if (!value) return null
  if (value.kind === 'ident' && !value.quoted) {
    const v = value.name.toLowerCase()
    return v === 'on' || v === 'off' ? v : null
  }
  if (value.kind === 'string') {
    const v = value.name.trim().toLowerCase()
    return v === 'on' || v === 'off' ? v : null
  }
  return null
}

/**
 * Classify one statement's effect on `standard_conforming_strings` for
 * consumers that track the setting statement by statement (the formatter's
 * dollar-segment scanner shares this detection with the splitter). Returns
 * the setting when the statement is a leading `SET [LOCAL | SESSION]
 * standard_conforming_strings {TO | =} on|off`, else null. Bare-word
 * occurrences only: the same spelling inside a literal or a comparison is
 * data, not a setting.
 */
export function applyStandardConformingSetting(statement: string): 'on' | 'off' | null {
  const tokens: SqlLexeme[] = []
  scanSqlLexemes(statement, (lex) => {
    if (
      lex.kind !== 'whitespace' && lex.kind !== 'lineComment' && lex.kind !== 'blockComment' &&
      tokens.length < SCS_WINDOW
    ) tokens.push(lex)
  })
  return trackStandardConformingStrings(tokens)
}
