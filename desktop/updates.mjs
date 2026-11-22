// New-release notification. The main process asks GitHub for the latest
// published release (never drafts or prereleases), checks every field it
// uses, and tells the window whether a newer version exists, with its notes
// and the update command for this installation. Nothing is downloaded or
// installed here.
//
// Trust boundary: the window never supplies a URL. The release page and the
// download links are rebuilt from the validated version and the fixed
// repository, and must equal what GitHub returned; shell commands only embed
// those exact URLs and fixed file names, so nothing GitHub sends reaches a
// command unchecked.

const REPOSITORY = 'pankleks/pgDEV'
const RELEASES = `https://github.com/${REPOSITORY}/releases`
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
export const MAX_NOTES = 20000
const MAX_RESPONSE = 1024 * 1024
const CACHE_MS = 60 * 60 * 1000
const TIMEOUT_MS = 10000
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/

/** -1, 0 or 1 for two `x.y.z` versions; null when either is not one. */
export function compareVersions(a, b) {
  const left = VERSION.exec(a ?? '')
  const right = VERSION.exec(b ?? '')
  if (!left || !right) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff) return diff < 0 ? -1 : 1
  }
  return 0
}

/** The release file for an install target (electron-builder artifactName). */
export function assetName(version, target) {
  switch (target) {
    case 'deb': return `pgDEV-${version}-linux-amd64.deb`
    case 'rpm': return `pgDEV-${version}-linux-x86_64.rpm`
    case 'mac': return `pgDEV-${version}-mac-arm64.zip`
    case 'win-setup': return `pgDEV-${version}-win-x64-setup.exe`
    case 'win-portable': return `pgDEV-${version}-win-x64-portable.exe`
    default: throw new Error(`Unknown install target ${target}`)
  }
}
const TARGETS = ['deb', 'rpm', 'mac', 'win-setup', 'win-portable']

/**
 * The newer release described by GitHub's "latest release" answer, or null
 * when it is not newer than `current` or does not pass every check. Download
 * URLs are kept only for the exact expected file names at their exact URLs.
 */
export function parseRelease(json, current) {
  if (!json || typeof json !== 'object' || json.draft !== false || json.prerelease !== false) return null
  const tag = typeof json.tag_name === 'string' ? json.tag_name : ''
  if (!tag.startsWith('v')) return null
  const version = tag.slice(1)
  if (compareVersions(version, current) !== 1) return null
  const url = `${RELEASES}/tag/v${version}`
  if (json.html_url !== url) return null
  const downloads = {}
  for (const asset of Array.isArray(json.assets) ? json.assets : []) {
    for (const target of TARGETS) {
      const name = assetName(version, target)
      if (asset?.name === name && asset.browser_download_url === `${RELEASES}/download/v${version}/${name}`) {
        downloads[target] = asset.browser_download_url
      }
    }
  }
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
  return {
    version,
    name: text(json.name, 200) || `pgDEV ${version}`,
    publishedAt: text(json.published_at, 40),
    notes: text(json.body, MAX_NOTES),
    notesTruncated: typeof json.body === 'string' && json.body.length > MAX_NOTES,
    url,
    downloads,
  }
}

/** POSIX shell single-quoting. */
const sh = (value) => `'${value.replace(/'/g, `'\\''`)}'`
/** PowerShell single-quoting. */
const ps = (value) => `'${value.replace(/'/g, "''")}'`

/**
 * How this installation is updated: one entry per applicable install target.
 * `environment`: { platform, portable, linux?: { format: 'deb'|'rpm'|null,
 * suse: boolean }, macBundle?: string } (macBundle: the running .app path).
 */
export function updateInstructions(release, environment) {
  const entry = (target, label, note, command) => {
    const url = release.downloads[target]
    if (!url) return null
    return { target, label, note, ...(command ? { command: command(url, assetName(release.version, target)) } : { download: true }) }
  }
  const { platform } = environment
  if (platform === 'win32') {
    if (environment.portable) {
      return [entry('win-portable', 'Windows portable', 'Download the new portable app and use it in place of this one; your data folder next to it is kept.')].filter(Boolean)
    }
    return [entry('win-setup', 'Windows installer', 'Run in PowerShell. The installer replaces this version; close pgDEV when it asks.',
      (url, name) => `$f = Join-Path $env:TEMP ${ps(name)}; Invoke-WebRequest ${ps(url)} -OutFile $f; Start-Process $f`)].filter(Boolean)
  }
  if (platform === 'darwin') {
    // The command replaces the bundle, so only a normal install location is
    // used: never a mounted DMG or a translocated copy.
    const bundle = /^\/(?:Users\/[^/]+\/)?Applications\/[^/]+\.app$/.test(environment.macBundle ?? '')
      ? environment.macBundle : '/Applications/pgDEV.app'
    const folder = bundle.slice(0, bundle.lastIndexOf('/')) || '/Applications'
    return [entry('mac', 'macOS', 'Quit pgDEV first, then run in Terminal. Downloading with curl avoids the "app is damaged" warning for unsigned builds.',
      (url) => `curl -fL -o /tmp/pgDEV-update.zip ${sh(url)} && rm -rf ${sh(bundle)} && ditto -x -k /tmp/pgDEV-update.zip ${sh(folder)} && rm /tmp/pgDEV-update.zip`)].filter(Boolean)
  }
  if (platform === 'linux') {
    const format = environment.linux?.format ?? null
    const deb = entry('deb', 'Debian / Ubuntu (.deb)', 'Run in a terminal, then restart pgDEV.',
      (url, name) => `curl -fLO ${sh(url)} && sudo apt install ${sh(`./${name}`)} && rm ${sh(name)}`)
    const rpm = entry('rpm', environment.linux?.suse ? 'openSUSE (.rpm)' : 'Fedora / RHEL (.rpm)', 'Run in a terminal, then restart pgDEV.',
      (url) => environment.linux?.suse ? `sudo zypper install ${sh(url)}` : `sudo dnf install ${sh(url)}`)
    const list = format === 'deb' ? [deb] : format === 'rpm' ? [rpm] : [deb, rpm]
    return list.filter(Boolean)
  }
  return []
}

/**
 * The checker the main process exposes over IPC.
 * - fetch: (url, init) => Promise<Response> (Electron's net.fetch)
 * - environment: () => environment for updateInstructions (computed lazily)
 * - openExternal: (url) => Promise<void>
 * - enabled: false in dev builds and tests, so they never reach the network
 */
export function createUpdates({ fetch, currentVersion, environment, openExternal, enabled = true, now = Date.now }) {
  let cached = null
  let checkedAt = 0
  let pending = null

  async function fetchLatest() {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `pgDEV/${currentVersion}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // No published release yet.
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const text = await response.text()
    if (text.length > MAX_RESPONSE) throw new Error('The release information is too large')
    return parseRelease(JSON.parse(text), currentVersion)
  }

  /** { current, enabled, update }: update is null when this is the newest. */
  async function check(force = false) {
    if (!enabled) return { current: currentVersion, enabled: false, update: null }
    if (!force && checkedAt && now() - checkedAt < CACHE_MS) return result()
    pending ??= fetchLatest().then((release) => {
      cached = release
      checkedAt = now()
    }).finally(() => { pending = null })
    await pending
    return result()
  }

  function result() {
    const update = cached && { ...cached, instructions: updateInstructions(cached, environment()) }
    if (update) delete update.downloads
    return { current: currentVersion, enabled: true, update }
  }

  /** Open the checked release's page or this installation's download. The
   * window only names which one; the URL is always the validated one. */
  async function open(kind) {
    if (!cached) throw new Error('No newer release has been found')
    if (kind === 'release') return openExternal(cached.url)
    if (kind === 'download') {
      const target = updateInstructions(cached, environment()).find((item) => item.download)?.target
      if (!target) throw new Error('This installation updates with a command')
      return openExternal(cached.downloads[target])
    }
    throw new Error('Unknown update link')
  }

  return { check, open }
}
