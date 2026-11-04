// The agent's bearer token. Generated once and kept in a per-user file, so the
// MCP configuration survives restarts; Settings → AI agent can rotate it. A
// read or write failure at startup degrades to an ephemeral token so the
// server still boots (e.g. a read-only home directory).
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** The file every pgDEV on this account shares; tests pass their own path. */
export function defaultTokenPath(): string {
  return join(homedir(), '.config', 'pgdev', 'token')
}

export function ephemeralToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Replace the token file atomically, owner-only. A temporary file plus rename
 * means a crash never leaves a half-written token, and the new file carries
 * 0600 whatever the old one had (the `mode` of writeFileSync only applies to
 * files it creates).
 */
function writeToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (err) {
    rmSync(temporary, { force: true })
    throw err
  }
}

export function loadOrCreateToken(file = defaultTokenPath()): string {
  try {
    const saved = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32,128}$/i.test(saved)) {
      // A file created by an older build, or copied around, may be readable
      // by others; the token is a credential, so tighten it on every start.
      try {
        chmodSync(file, 0o600)
      } catch {
        // Not ours to change (or no POSIX modes); keep using it.
      }
      return saved
    }
  } catch {
    // Missing, unreadable, or not ours: mint one below.
  }
  const token = ephemeralToken()
  try {
    writeToken(file, token)
  } catch (err) {
    console.warn(
      `pgDEV could not persist the AI token (${err instanceof Error ? err.message : String(err)}); ` +
        'using an ephemeral one for this run.',
    )
  }
  return token
}

/** Mint and persist a new token. Throws when it cannot be saved: a rotation
 * that silently fell back to an ephemeral token would break every client
 * again on the next start. */
export function rotateToken(file = defaultTokenPath()): string {
  const token = ephemeralToken()
  writeToken(file, token)
  return token
}
