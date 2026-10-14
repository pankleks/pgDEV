import type { FastifyInstance } from 'fastify'
import { getCatalogPool } from '../pools.js'
import type { DatabaseProcess } from '../schema-types.js'

export async function processRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/processes', async (req) => {
    const { id } = req.params as { id: string }
    const result = await getCatalogPool(id).query<DatabaseProcess>(`
      SELECT pid, backend_start::text, datname AS database, usename AS username,
        application_name, state, wait_event_type, wait_event,
        extract(epoch FROM clock_timestamp() - xact_start)::float8 AS transaction_age,
        extract(epoch FROM clock_timestamp() - query_start)::float8 AS query_age,
        pg_blocking_pids(pid) AS blocking_pids, query
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
      ORDER BY xact_start NULLS LAST, pid`)
    return { processes: result.rows }
  })

  app.post('/api/connections/:id/processes/:pid/:action', async (req, reply) => {
    const { id, pid, action } = req.params as { id: string; pid: string; action: string }
    const { backendStart } = (req.body ?? {}) as { backendStart?: unknown }
    if (!/^[1-9]\d*$/.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) > 2147483647 ||
        !['cancel', 'terminate'].includes(action) || typeof backendStart !== 'string' ||
        backendStart.length > 100 || !Number.isFinite(Date.parse(backendStart))) {
      return reply.code(400).send({ error: 'Invalid process action or session identity' })
    }
    const fn = action === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'
    // Check the start time as well as PID: a stale dialog must not target a reused PID.
    const result = await getCatalogPool(id).query<{ ok: boolean }>(`
      SELECT ${fn}(pid) AS ok FROM pg_stat_activity
      WHERE pid = $1 AND backend_start = $2::timestamptz
        AND datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        ${action === 'cancel' ? "AND state = 'active'" : ''}`,
    [Number(pid), backendStart])
    if (!result.rows[0]?.ok) {
      return reply.code(409).send({ error: 'Session ended, changed, or could not be signaled. Refresh the process list.' })
    }
    return { ok: true }
  })
}
