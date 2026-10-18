import type { ConnectionConfig } from '../types'

export interface ProfileConfig extends ConnectionConfig {
  id?: string
  name?: string
}

export interface SavedConnection extends ProfileConfig {
  id: string
  name: string
  label: string
}

export function configOf(connection: ConnectionConfig): ConnectionConfig {
  if (connection.connectionString) return { connectionString: connection.connectionString }
  const { host, port, database, user, password, ssl } = connection
  return { host, port, database, user, password, ssl }
}

export function profileName(name: string | undefined, fallback: string): string {
  return name?.trim() || fallback
}

export function duplicateName(saved: SavedConnection[], name: string, id?: string): boolean {
  return saved.some((entry) => entry.id !== id && entry.name.trim().toLowerCase() === name.trim().toLowerCase())
}

export function migrateProfiles(entries: (ConnectionConfig & { label: string; id?: unknown; name?: unknown })[]): SavedConnection[] {
  const saved: SavedConnection[] = []
  for (const entry of entries) {
    const base = profileName(typeof entry.name === 'string' ? entry.name : undefined, entry.label)
    let name = base
    for (let suffix = 2; duplicateName(saved, name); suffix++) name = `${base} (${suffix})`
    const id = typeof entry.id === 'string' && entry.id && !saved.some((item) => item.id === entry.id)
      ? entry.id : crypto.randomUUID()
    saved.push({ ...configOf(entry), label: entry.label, id, name })
  }
  return saved
}
