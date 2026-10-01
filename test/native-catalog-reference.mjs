// Migration oracle: executes only the existing catalog readers/DDL generators.
// Credentials arrive through the environment, never command-line arguments.
import { Pool } from 'pg'
import { fetchSchemaData } from '../server/src/catalog/metadata.ts'
import { objectDdl } from '../server/src/catalog/ddl.ts'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { targets } = JSON.parse(input)
const pool = new Pool({ connectionString: process.env.PGDEV_MIGRATION_URL })
try {
  const schema = await fetchSchemaData(pool)
  const ddls = []
  for (const target of targets) ddls.push(await objectDdl(pool, target))
  process.stdout.write(JSON.stringify({ schema, ddls }))
} finally { await pool.end() }
