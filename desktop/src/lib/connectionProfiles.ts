export interface ConnectionProfile { label: string; seq: number; uri: string }
export interface ConnectionProfiles { version: 1; highWater: number; saved: ConnectionProfile[] }
export const emptyProfiles = (): ConnectionProfiles => ({ version: 1, highWater: 0, saved: [] })

const allowed = new Set(['sslmode', 'hostaddr', 'connect_timeout', 'application_name', 'target_session_attrs', 'channel_binding', 'user', 'dbname', 'port', 'host'])
function connectionUrl(uri: string): URL {
  if (uri.length > 8192) throw new Error('Connection URI is limited to 8192 characters')
  let url: URL
  try { url = new URL(uri) } catch { throw new Error('Profiles require a PostgreSQL URI') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error('Profiles require a PostgreSQL URI without a fragment')
  return url
}

/** Strict query allowlist: never persist arbitrary options, file paths or keys.
 * Passwords in either supported URI position are removed before snapshots. */
export function profileUri(uri: string): string {
  const url = connectionUrl(uri)
  url.password = ''
  url.searchParams.delete('password')
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error('This URI has options unsupported by saved profiles; use a direct connection instead')
  }
  return url.toString()
}

export function withConnectionPassword(uri: string, password: string): string {
  if (!password) return uri
  const url = connectionUrl(uri)
  url.searchParams.delete('password')
  url.password = password
  return url.toString()
}

export function rememberProfile(record: ConnectionProfiles, label: string, uri: string): ConnectionProfiles {
  label = label.trim()
  if (!label || label.length > 128) throw new Error('Profile name must contain 1–128 characters')
  const safeUri = profileUri(uri)
  const existing = record.saved.find(profile => profile.label === label)
  if (!existing && record.highWater >= Number.MAX_SAFE_INTEGER) throw new Error('Connection profile numbering is exhausted')
  const seq = existing?.seq ?? record.highWater + 1
  return { version: 1, highWater: Math.max(record.highWater, seq), saved: [{ label, seq, uri: safeUri }, ...record.saved.filter(profile => profile.label !== label)].slice(0, 10) }
}

export function forgetProfile(record: ConnectionProfiles, seq: number): ConnectionProfiles {
  return { ...record, saved: record.saved.filter(profile => profile.seq !== seq) }
}

/** Corrupt records are rejected, not overwritten or partially restored. */
export function parseProfiles(value: unknown): ConnectionProfiles {
  const fail = (): never => { throw new Error('Invalid saved connection profiles') }
  if (!value || typeof value !== 'object') return fail()
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['version', 'highWater', 'saved'].includes(key)) || v.version !== 1 || !Number.isSafeInteger(v.highWater) || (v.highWater as number) < 0 || !Array.isArray(v.saved) || v.saved.length > 10) return fail()
  const seqs = new Set<number>(), labels = new Set<string>()
  const saved = v.saved.map((item: unknown) => {
    if (!item || typeof item !== 'object') return fail()
    const p = item as Record<string, unknown>
    if (Object.keys(p).some(key => !['label', 'seq', 'uri'].includes(key)) || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 128 || typeof p.uri !== 'string' || !Number.isSafeInteger(p.seq) || (p.seq as number) <= 0 || (p.seq as number) > (v.highWater as number)) return fail()
    const seq = p.seq as number
    if (seqs.has(seq) || labels.has(p.label) || profileUri(p.uri) !== p.uri) return fail()
    seqs.add(seq); labels.add(p.label)
    return { label: p.label, seq, uri: p.uri }
  })
  return { version: 1, highWater: v.highWater as number, saved }
}
