// Read-only migration oracle. Produces scripts, never executes submitted SQL.
import { Pool } from 'pg'
import { fetchTableEditState, tableEditDdl } from '../server/src/catalog/tableedit.ts'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { oids, edits } = JSON.parse(input)
const pool = new Pool({ connectionString: process.env.PGDEV_MIGRATION_URL })
try {
  const states = []
  for (const oid of oids) states.push(await fetchTableEditState(pool, oid))
  const results = []
  for (const { oid, request } of edits) {
    try { results.push({ ddl: await tableEditDdl(pool, oid, request) }) }
    catch (error) { results.push({ error: error.message }) }
  }
  process.stdout.write(JSON.stringify({ states, results }))
} finally { await pool.end() }
