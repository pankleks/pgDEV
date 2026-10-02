// Compare utility names/counts to the original node-postgres transport.
// Only session-local temporary objects; credentials never reach argv/output.
import { Client } from 'pg'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { sql } = JSON.parse(input)
const client = new Client({ connectionString: process.env.PGDEV_MIGRATION_URL })
try {
  await client.connect()
  const response = await client.query(sql)
  const results = Array.isArray(response) ? response : [response]
  process.stdout.write(JSON.stringify(results.map(result => ({ command: result.command, rowCount: result.rowCount ?? 0 }))))
} finally { await client.end() }
