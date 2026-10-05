import type { PoolClient } from 'pg'
import type { EventEmitter } from 'node:events'

interface SqlState {
  standardConformingStrings: boolean
}

const states = new WeakMap<PoolClient, SqlState>()

/** PostgreSQL reports effective string-mode changes, including SET LOCAL,
 * savepoint rollback, COMMIT, RESET and changes made inside a routine.
 * Observe the protocol rather than trying to infer these from SQL text.
 * One listener lives for the lifetime of each pooled physical connection. */
export async function observeSqlState(client: PoolClient): Promise<void> {
  if (states.has(client)) return
  // Like cancellation, this uses the JS driver's protocol connection.
  const connection = (client as unknown as { connection: EventEmitter }).connection
  const state: SqlState = { standardConformingStrings: true }
  const listener = (message: { parameterName: string; parameterValue: string }) => {
    if (message.parameterName === 'standard_conforming_strings') {
      state.standardConformingStrings = message.parameterValue === 'on'
    }
  }
  connection.on('parameterStatus', listener)
  try {
    // Startup ParameterStatus messages arrived before pool checkout. Read the
    // initial value once, before opening any application transaction.
    const result = await client.query('SHOW standard_conforming_strings')
    const value = result.rows[0]?.standard_conforming_strings
    if (value !== 'on' && value !== 'off') throw new Error('Cannot determine PostgreSQL string mode')
    state.standardConformingStrings = value === 'on'
    states.set(client, state)
  } catch (error) {
    connection.removeListener('parameterStatus', listener)
    throw error
  }
}

export function standardConformingStrings(client: PoolClient): boolean {
  const state = states.get(client)
  if (!state) throw new Error('PostgreSQL string mode was not initialized')
  return state.standardConformingStrings
}
