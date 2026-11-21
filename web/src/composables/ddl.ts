import { api } from '../api'
import { useConnection } from './connection'
import { useSchema } from './schema'
import { useTabs } from './tabs'
import { useToast } from './toast'

export type DdlObjectType = 'table' | 'view' | 'function' | 'index' | 'constraint' | 'trigger' | 'type' | 'sequence'

/** Latest request per object and connection: a slower, older answer for the
 * same object never overwrites a newer one. Keyed by connection, so requests
 * from a previous database can never match. */
const requests = new Map<string, number>()

/**
 * Fetch an object's DDL on the active connection and show it in its DDL tab
 * (reused when already open). Shared by the object browser's double-click and
 * the editor's Open Definition.
 */
export async function openObjectDdl(
  type: DdlObjectType,
  schemaName: string,
  name: string,
  oid?: string,
  identitySuffix = '',
  parent?: string,
): Promise<void> {
  const conn = useConnection()
  const connectionId = conn.state.id
  if (!connectionId) return
  const key = `${connectionId}\u0000${type}\u0000${schemaName}\u0000${name}\u0000${oid ?? ''}\u0000${parent ?? ''}`
  const version = (requests.get(key) ?? 0) + 1
  requests.set(key, version)
  try {
    const { ddl } = await api.ddl(connectionId, type, schemaName, name, oid, parent)
    if (conn.state.id !== connectionId || requests.get(key) !== version) return
    const materialized = type === 'view' &&
      !!useSchema().state.data?.views.find((v) => v.schema === schemaName && v.name === name)?.materialized
    await useTabs().openDdl(type, schemaName, name, ddl, oid ? `--${oid}` : identitySuffix, !materialized, parent ?? '', connectionId)
  } catch (cause) {
    if (conn.state.id === connectionId) useToast().show((cause as Error).message)
  } finally {
    if (requests.get(key) === version) requests.delete(key)
  }
}
