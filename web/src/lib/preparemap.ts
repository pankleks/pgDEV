// PREPARE/EXECUTE template generation for queries written with $N parameters.
// Pure helpers (no UI/Monaco imports) so the scanner and the script builder
// are unit-testable directly, mirroring sqlsplit/selectshape on the server.
//
// The scanner finds top-level $N references while skipping string literals,
// dollar-quoted bodies, comments, and identifiers that merely contain a `$`
// (`a$1` is a name, not a parameter). Parameter types are never resolved:
// PostgreSQL infers them from the query context — a parameter compared against
// a column takes that column's type — so the template declares no type list
// and the EXECUTE values are the caller's pasted literals or NULL.

import { scanSqlLexemes } from '../../../server/src/sqllex'

/**
 * Indices of the top-level $N parameters of one statement, in first-use
 * order. Repeated parameters appear once.
 */
export function findParams(sql: string): number[] | null {
  const indices: number[] = []
  const seen = new Set<number>()
  // A parameter is a bare `$` immediately followed by digits. The shared lexer
  // already keeps strings, comments, dollar bodies and identifiers that
  // contain `$` (`a$1`) out of plain punctuation.
  let afterDollar = -1
  scanSqlLexemes(sql, (lex) => {
    if (lex.kind === 'punct' && lex.start === afterDollar && /^[0-9]+$/.test(lex.raw)) {
      const index = Number(lex.raw)
      if (index > 0 && !seen.has(index)) {
        seen.add(index)
        indices.push(index)
      }
    }
    afterDollar = lex.kind === 'punct' && lex.raw === '$' ? lex.end : -1
  })
  return indices.length ? indices : null
}

/** `PREPARE temp AS` + the query, `EXECUTE` with one value per parameter, `DEALLOCATE`. */
export function prepareScript(sql: string, values: string[]): string {
  // The query needs a terminator: add `;` when the statement's code portion
  // is unterminated. A trailing line comment must not swallow it, so in that
  // case the `;` gets its own line.
  let body = sql.trim()
  const lastLine = body.slice(body.lastIndexOf('\n') + 1)
  const commentStart = lastLine.indexOf('--')
  const codeTail = (commentStart === -1 ? lastLine : lastLine.slice(0, commentStart)).trimEnd()
  if (!codeTail.endsWith(';')) {
    body = commentStart !== -1 ? `${body}\n;` : `${body};`
  }
  const indented = body
    .split('\n')
    .map((line) => `\t${line}`)
    .join('\n')
  const argLines = values
    .map((v, i) => `\t${v}${i < values.length - 1 ? ',' : ''} -- $${i + 1}`)
    .join('\n')
  return ['PREPARE temp AS', indented, '', '', `EXECUTE temp(\n${argLines}\n);`, '', '', 'DEALLOCATE temp;'].join('\n')
}

/** JSON source-text access (V8 11.4+): a number kept as its exact text,
 * which JSON.stringify also emits verbatim inside objects. */
interface RawJson { rawJSON: string }
const sourceJson = JSON as unknown as {
  rawJSON?: (text: string) => RawJson
  isRawJSON?: (value: unknown) => value is RawJson
}

/**
 * Convert one parsed parameter value to a SQL literal: numbers pass through,
 * strings get single-quote escaping, booleans become TRUE/FALSE, null/undefined
 * become NULL, arrays become ARRAY[...] (`'{}'` when empty — an unknown literal
 * is coerced to the parameter's inferred type), objects become JSON literals.
 */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (sourceJson.isRawJSON?.(v)) return v.rawJSON
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(sqlLiteral).join(', ')}]` : "'{}'"
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  return 'NULL'
}

/**
 * Parse an optional parameter-values payload: a JSON array, optionally
 * preceded by `--` (values often arrive as a comment line from logs).
 * A bare value without brackets is wrapped into a one-element array;
 * anything unparseable yields null.
 */
export function parseParamValues(text: string): unknown[] | null {
  let t = text.trim()
  if (t.startsWith('--')) t = t.slice(2).trim()
  if (!t) return null
  if (!t.startsWith('[')) t = `[${t}]`
  try {
    // Keep every number exactly as written (12345678901234567890, 1.50):
    // a double would round it. Plain parsing where the engine lacks
    // source-text access.
    const reviver = sourceJson.rawJSON
      ? (_key: string, value: unknown, context?: { source?: string }) =>
          typeof value === 'number' && context?.source ? sourceJson.rawJSON!(context.source) : value
      : undefined
    const parsed: unknown = JSON.parse(t, reviver as Parameters<typeof JSON.parse>[1])
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return null
  }
}

/**
 * Build the full PREPARE/EXECUTE/DEALLOCATE script for `sql`, or null when it
 * has no top-level $N parameters. Pasted values apply positionally; every
 * parameter without one gets `NULL`, and a gap like `$1, $3` fills in too.
 */
export function mapParams(sql: string, override?: unknown[]): string | null {
  const indices = findParams(sql)
  if (!indices?.length) return null
  const max = Math.max(...indices)
  const values: string[] = []
  for (let n = 1; n <= max; n++) {
    values.push(override && override.length >= n ? sqlLiteral(override[n - 1]) : 'NULL')
  }
  return prepareScript(sql, values)
}
