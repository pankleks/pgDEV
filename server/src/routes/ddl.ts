import type { FastifyInstance } from 'fastify'
import { getCatalogPool } from '../pools.js'
import { objectDdl } from '../catalog/ddl.js'

export async function ddlRoutes(app: FastifyInstance) {
  app.get('/api/connections/:id/ddl', async (req) => {
    const { id } = req.params as { id: string }
    const { type, schema, name, oid, parent } = req.query as {
      type: string
      schema: string
      name: string
      oid?: string
      parent?: string
    }
    // Validate before anything reaches the catalog: an oid is cast with ::oid,
    // so a non-numeric value would surface as a 500 from PostgreSQL.
    for (const [key, value] of Object.entries({ type, schema, name, oid, parent })) {
      if (value !== undefined && (typeof value !== 'string' || value.length > 1024)) {
        throw Object.assign(new Error(`Invalid ${key}`), { statusCode: 400 })
      }
    }
    if (typeof type !== 'string') throw Object.assign(new Error('type is required'), { statusCode: 400 })
    if (oid !== undefined && oid !== '' && !/^\d{1,10}$/.test(oid)) {
      throw Object.assign(new Error('oid must be a number'), { statusCode: 400 })
    }
    const ddl = await objectDdl(getCatalogPool(id), { type, schema, name, oid, parent })
    return { ddl }
  })
}
