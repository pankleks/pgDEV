export interface SqlSubmission {
  sql: string
  documentSql: string
  /** Monaco/document offset in UTF-16 code units, unlike PostgreSQL positions. */
  startOffset: number
}
export interface SqlDiagnostic {
  submission: SqlSubmission
  position: number
  message: string
}

export function sqlDiagnostic(error: unknown, submission: SqlSubmission, currentSql: string): SqlDiagnostic | null {
  if (!error || typeof error !== 'object' || !('position' in error) || typeof error.position !== 'number'
    || !Number.isSafeInteger(error.position) || error.position < 1 || currentSql !== submission.documentSql
    || !Number.isSafeInteger(submission.startOffset) || submission.startOffset < 0
    || submission.documentSql.slice(submission.startOffset, submission.startOffset + submission.sql.length) !== submission.sql) return null
  const diagnostic = { submission, position: error.position, message: 'message' in error ? String(error.message) : 'SQL error' }
  return diagnosticOffset(diagnostic, currentSql) === null ? null : diagnostic
}

/** PostgreSQL counts Unicode scalar characters; Monaco counts UTF-16 units.
 * Never underline an unrelated token after a selection run or a text edit. */
export function diagnosticOffset(diagnostic: SqlDiagnostic | null | undefined, currentSql: string): number | null {
  if (!diagnostic || currentSql !== diagnostic.submission.documentSql) return null
  const { sql, startOffset } = diagnostic.submission
  let remaining = diagnostic.position - 1, offset = 0
  for (const character of sql) {
    if (remaining === 0) break
    offset += character.length
    --remaining
  }
  return remaining === 0 ? startOffset + offset : null
}
