import type { FastifyInstance } from 'fastify'
import { Client, Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { setPool, setCatalogPool, removePool } from '../pools.js'
import { pgErrorMessage } from '../pgerror.js'
import { closeSessionsForConnection, closeSessionsForClient } from '../sessions.js'
import { cancelConnection } from '../queryexec.js'

interface ConnectBody {
  connectionString?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
  statementTimeout?: number
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30000

function connectionConfig(b: ConnectBody): Record<string, unknown> {
  if (b.connectionString) return { connectionString: b.connectionString }
  return {
    host: b.host || 'localhost', port: b.port || 5432, database: b.database,
    user: b.user, password: b.password,
    // The parameter-form SSL flag is authoritative, including self-signed certificates.
    ssl: b.ssl ? { rejectUnauthorized: false } : false,
  }
}

export async function connectionRoutes(app: FastifyInstance) {
  app.post('/api/connections/discover', {
    schema: {
      body: {
        type: 'object', required: ['host', 'port', 'user'], additionalProperties: false,
        properties: {
          host: { type: 'string', minLength: 1, maxLength: 1024 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          user: { type: 'string', minLength: 1, maxLength: 1024 },
          password: { type: 'string', maxLength: 65536 },
          ssl: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const client = new Client({
      ...connectionConfig(req.body as ConnectBody), database: 'postgres',
      application_name: 'pgDEV discovery', connectionTimeoutMillis: 10000, statement_timeout: 10000,
    })
    // A lost standalone connection must not become an unhandled error event.
    client.on('error', () => {})
    try {
      await client.connect()
      const result = await client.query<{ name: string }>(`
        SELECT datname AS name FROM pg_database
        WHERE NOT datistemplate AND datallowconn
          AND has_database_privilege(oid, 'CONNECT')
        ORDER BY datname`)
      return { databases: result.rows.map((row) => row.name) }
    } catch (err) {
      return reply.code(400).send({ error: `Could not discover databases via "postgres": ${pgErrorMessage(err)}. You can still enter a database name manually.` })
    } finally {
      await client.end().catch(() => {})
    }
  })

  app.post('/api/connections', async (req, reply) => {
    const b = req.body as ConnectBody
    // Statement timeout arrives in seconds from the settings UI; absent means
    // the documented 30 s default, anything else outside 1–600 is rejected.
    let statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS
    if (b.statementTimeout !== undefined) {
      const s = b.statementTimeout
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 600) {
        return reply.code(400).send({ error: 'statementTimeout must be an integer from 1 to 600 seconds' })
      }
      statementTimeoutMs = s * 1000
    }
    const config = connectionConfig(b)
    config.max = 5
    config.statement_timeout = statementTimeoutMs
    // Tabs can hold a session client while paging large results; fail fast
    // instead of hanging forever when every pool slot is checked out.
    config.connectionTimeoutMillis = 10000
    config.application_name = 'pgDEV'

    const pool = new Pool(config)
    // Idle clients can die at any time (server restart, NAT/VPN timeout,
    // idle_session_timeout). Without this handler node-postgres rethrows as
    // an unhandled 'error' event and takes down the whole API process.
    pool.on('error', (err, client) => {
      console.error(`pg pool error: ${pgErrorMessage(err, 'Database connection error')}`)
      if (client) void closeSessionsForClient(client)
    })
    let catalogPool: Pool | null = null
    try {
      const client = await pool.connect()
      // Cosmetic: the dialog shows "Connected • PostgreSQL x.y" next to the
      // status dot. Failure here must never block a working connection.
      let pgVersion = ''
      try {
        const vres = await client.query('SHOW server_version')
        pgVersion = String(vres.rows[0]?.server_version ?? '').trim().split(/\s+/)[0] ?? ''
      } catch {
        // ignore — version display is optional
      }
      client.release()
      // Catalog/DDL queries get their own small pool so a handful of paged
      // cursor sessions (which pin main-pool clients) cannot starve them.
      catalogPool = new Pool({ ...config, max: 4 })
      catalogPool.on('error', (err) => {
        console.error(`pg catalog pool error: ${pgErrorMessage(err, 'Database connection error')}`)
      })
      const id = randomUUID()
      setPool(id, pool)
      setCatalogPool(id, catalogPool)
      return { id, pgVersion }
    } catch (err) {
      await catalogPool?.end().catch(() => {})
      await pool.end().catch(() => {})
      return reply.code(400).send({ error: pgErrorMessage(err) })
    }
  })

  app.delete('/api/connections/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    // A request-owned query holds a main-pool client and would otherwise make
    // pool.end() wait for its statement timeout; cancel it first. Then roll
    // back open transactions and release session clients, which pool.end()
    // would also wait on.
    cancelConnection(id)
    await closeSessionsForConnection(id)
    const removed = await removePool(id)
    if (!removed) return reply.code(404).send({ error: 'Unknown connection' })
    return { ok: true }
  })
}
