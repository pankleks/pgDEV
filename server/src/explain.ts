import { splitStatements } from './sqlsplit.js'
import { withoutLeadingComments } from './queryshape.js'

/** Validate using the executing connection's lexical mode, before any SQL runs. */
export function explainSql(sql: string, mode: 'explain' | 'analyze', standardConformingStrings: boolean): string {
  const statements = splitStatements(sql, { standardConformingStrings })
    .filter((statement) => withoutLeadingComments(statement).trim())
  if (statements.length !== 1) throw new Error('Select exactly one statement to explain.')
  const options = mode === 'analyze' ? 'ANALYZE, BUFFERS, VERBOSE, FORMAT JSON' : 'VERBOSE, FORMAT JSON'
  return `EXPLAIN (${options})\n${statements[0]}\n`
}
