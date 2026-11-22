import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LATEST_RELEASE_API, MAX_NOTES, assetName, compareVersions, createUpdates, parseRelease, updateInstructions } from '../../desktop/updates.mjs'

// New-release notice: only a newer, published release with exactly the
// expected URLs is announced, and the window can never supply a URL.

const RELEASES = 'https://github.com/pankleks/pgDEV/releases'
const TARGETS = ['deb', 'rpm', 'mac', 'win-setup', 'win-portable']

function release(version = '0.8.0', overrides = {}) {
  return {
    tag_name: `v${version}`,
    name: `pgDEV ${version} — unsigned preview`,
    html_url: `${RELEASES}/tag/v${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-11-22T10:00:00Z',
    body: '## What\'s new\n\n- **Thing**',
    assets: [
      ...TARGETS.map((target) => {
        const name = assetName(version, target)
        return { name, browser_download_url: `${RELEASES}/download/v${version}/${name}` }
      }),
      { name: 'SHA256SUMS.txt', browser_download_url: `${RELEASES}/download/v${version}/SHA256SUMS.txt` },
    ],
    ...overrides,
  }
}

test('versions compare numerically and reject anything else', () => {
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1)
  assert.equal(compareVersions('0.7.2', '0.7.2'), 0)
  assert.equal(compareVersions('0.7.2', '1.0.0'), -1)
  for (const bad of ['0.7', 'v0.7.2', '0.7.2-beta', '0.7.2 ', '', null, '1.2.3.4']) {
    assert.equal(compareVersions(bad, '0.7.2'), null, String(bad))
  }
})

test('a newer published release is parsed with its validated downloads', () => {
  const parsed = parseRelease(release(), '0.7.2')
  assert.equal(parsed.version, '0.8.0')
  assert.equal(parsed.url, `${RELEASES}/tag/v0.8.0`)
  assert.equal(parsed.publishedAt, '2026-11-22T10:00:00Z')
  assert.deepEqual(Object.keys(parsed.downloads).sort(), [...TARGETS].sort())
  assert.equal(parsed.downloads.deb, `${RELEASES}/download/v0.8.0/pgDEV-0.8.0-linux-amd64.deb`)
  assert.equal(parsed.notesTruncated, false)
})

test('older, equal, draft, prerelease or malformed releases are not announced', () => {
  assert.equal(parseRelease(release('0.7.2'), '0.7.2'), null)
  assert.equal(parseRelease(release('0.7.1'), '0.7.2'), null)
  assert.equal(parseRelease(release('0.8.0', { draft: true }), '0.7.2'), null)
  assert.equal(parseRelease(release('0.8.0', { prerelease: true }), '0.7.2'), null)
  assert.equal(parseRelease(release('0.8.0', { draft: undefined }), '0.7.2'), null, 'the draft flag must be present')
  assert.equal(parseRelease(release('0.8.0', { tag_name: '0.8.0' }), '0.7.2'), null)
  assert.equal(parseRelease(release('0.8.0', { tag_name: 'v0.8.0-rc1' }), '0.7.2'), null)
  assert.equal(parseRelease(release('0.8.0', { html_url: 'https://evil.example/releases/tag/v0.8.0' }), '0.7.2'), null)
  assert.equal(parseRelease(release('0.8.0', { html_url: `${RELEASES}/tag/v0.9.0` }), '0.7.2'), null, 'the page must match the tag')
  assert.equal(parseRelease(null, '0.7.2'), null)
  assert.equal(parseRelease('{}', '0.7.2'), null)
})

test('download URLs that are not exactly the expected ones are dropped', () => {
  const tampered = release('0.8.0', {
    assets: [
      { name: 'pgDEV-0.8.0-linux-amd64.deb', browser_download_url: 'https://evil.example/pgDEV-0.8.0-linux-amd64.deb' },
      { name: 'pgDEV-0.8.0-linux-x86_64.rpm', browser_download_url: `${RELEASES}/download/v0.8.0/other.rpm` },
      { name: 'pgDEV-0.8.0-mac-arm64.zip', browser_download_url: `${RELEASES}/download/v0.7.0/pgDEV-0.8.0-mac-arm64.zip` },
      { name: "x'; rm -rf ~; '.exe", browser_download_url: `${RELEASES}/download/v0.8.0/x'; rm -rf ~; '.exe` },
    ],
  })
  assert.deepEqual(parseRelease(tampered, '0.7.2').downloads, {})
  // With no download for this system there is no command either.
  assert.deepEqual(updateInstructions(parseRelease(tampered, '0.7.2'), { platform: 'linux', linux: { format: 'deb' } }), [])
})

test('long notes are capped and flagged; text fields are bounded', () => {
  const parsed = parseRelease(release('0.8.0', { body: 'x'.repeat(MAX_NOTES + 10), name: 'n'.repeat(500) }), '0.7.2')
  assert.equal(parsed.notes.length, MAX_NOTES)
  assert.equal(parsed.notesTruncated, true)
  assert.equal(parsed.name.length, 200)
  assert.equal(parseRelease(release('0.8.0', { body: null, name: null }), '0.7.2').name, 'pgDEV 0.8.0')
})

test('each installation gets its own update instructions', () => {
  const parsed = parseRelease(release(), '0.7.2')
  const deb = updateInstructions(parsed, { platform: 'linux', linux: { format: 'deb', suse: false } })
  assert.deepEqual(deb.map((i) => i.target), ['deb'])
  assert.equal(deb[0].command,
    `curl -fLO '${RELEASES}/download/v0.8.0/pgDEV-0.8.0-linux-amd64.deb' && sudo apt install './pgDEV-0.8.0-linux-amd64.deb' && rm 'pgDEV-0.8.0-linux-amd64.deb'`)
  const rpm = updateInstructions(parsed, { platform: 'linux', linux: { format: 'rpm', suse: false } })
  assert.equal(rpm[0].command, `sudo dnf install '${RELEASES}/download/v0.8.0/pgDEV-0.8.0-linux-x86_64.rpm'`)
  const suse = updateInstructions(parsed, { platform: 'linux', linux: { format: 'rpm', suse: true } })
  assert.match(suse[0].command, /^sudo zypper install '/)
  assert.deepEqual(updateInstructions(parsed, { platform: 'linux', linux: { format: null } }).map((i) => i.target), ['deb', 'rpm'],
    'an unknown package format shows both')

  const mac = updateInstructions(parsed, { platform: 'darwin', macBundle: '/Applications/pgDEV.app' })
  assert.equal(mac[0].command,
    `curl -fL -o /tmp/pgDEV-update.zip '${RELEASES}/download/v0.8.0/pgDEV-0.8.0-mac-arm64.zip' && rm -rf '/Applications/pgDEV.app' && ditto -x -k /tmp/pgDEV-update.zip '/Applications' && rm /tmp/pgDEV-update.zip`)
  const userApps = updateInstructions(parsed, { platform: 'darwin', macBundle: '/Users/kh/Applications/pgDEV.app' })
  assert.match(userApps[0].command, /rm -rf '\/Users\/kh\/Applications\/pgDEV\.app' && ditto -x -k \/tmp\/pgDEV-update\.zip '\/Users\/kh\/Applications'/)
  for (const unsafe of ['/Volumes/pgDEV/pgDEV.app', '/private/var/folders/x/AppTranslocation/y/d/pgDEV.app', '', "/Applications/it's.app/x"]) {
    assert.match(updateInstructions(parsed, { platform: 'darwin', macBundle: unsafe })[0].command, /rm -rf '\/Applications\/pgDEV\.app'/, unsafe)
  }

  const setup = updateInstructions(parsed, { platform: 'win32', portable: false })
  assert.equal(setup[0].command,
    `$f = Join-Path $env:TEMP 'pgDEV-0.8.0-win-x64-setup.exe'; Invoke-WebRequest '${RELEASES}/download/v0.8.0/pgDEV-0.8.0-win-x64-setup.exe' -OutFile $f; Start-Process $f`)
  const portable = updateInstructions(parsed, { platform: 'win32', portable: true })
  assert.deepEqual(portable.map((i) => [i.target, i.download, i.command]), [['win-portable', true, undefined]])
  assert.deepEqual(updateInstructions(parsed, { platform: 'freebsd' }), [])
})

function fakeFetch(answer) {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (answer instanceof Error) throw answer
      const { status = 200, body } = answer
      return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
    },
  }
}

function checker(answer, overrides = {}) {
  const net = fakeFetch(answer)
  const opened = []
  let clock = 1_000_000
  const updates = createUpdates({
    fetch: net.fetch, currentVersion: '0.7.2',
    environment: () => ({ platform: 'win32', portable: true }),
    openExternal: async (url) => { opened.push(url) },
    now: () => clock,
    ...overrides,
  })
  return { updates, net, opened, advance: (ms) => { clock += ms } }
}

test('a check asks GitHub once, caches for an hour, and forced checks refetch', async () => {
  const { updates, net, advance } = checker({ body: release() })
  const first = await updates.check()
  assert.equal(net.calls[0].url, LATEST_RELEASE_API)
  assert.match(net.calls[0].init.headers['user-agent'], /^pgDEV\/0\.7\.2$/)
  assert.equal(first.current, '0.7.2')
  assert.equal(first.update.version, '0.8.0')
  assert.equal('downloads' in first.update, false, 'raw download URLs stay in the main process')
  assert.deepEqual(first.update.instructions.map((i) => i.target), ['win-portable'])
  await updates.check()
  assert.equal(net.calls.length, 1, 'cached')
  await updates.check(true)
  assert.equal(net.calls.length, 2, 'a forced check refetches')
  advance(61 * 60 * 1000)
  await updates.check()
  assert.equal(net.calls.length, 3, 'the cache expires after an hour')
})

test('no release, an older release or a disabled checker announce nothing', async () => {
  assert.equal((await checker({ status: 404, body: '' }).updates.check()).update, null)
  assert.equal((await checker({ body: release('0.7.1') }).updates.check()).update, null)
  const disabled = checker({ body: release() }, { enabled: false })
  assert.deepEqual(await disabled.updates.check(true), { current: '0.7.2', enabled: false, update: null })
  assert.equal(disabled.net.calls.length, 0, 'a disabled checker never reaches the network')
})

test('failures are reported to the caller', async () => {
  await assert.rejects(checker({ status: 500, body: '' }).updates.check(), /GitHub answered 500/)
  await assert.rejects(checker(new Error('offline')).updates.check(), /offline/)
  await assert.rejects(checker({ body: 'x'.repeat(1024 * 1024 + 1) }).updates.check(), /too large/)
})

test('open uses only the validated URLs, whatever the window sends', async () => {
  const { updates, opened } = checker({ body: release() })
  await assert.rejects(updates.open('release'), /No newer release/)
  await updates.check()
  await updates.open('release')
  await updates.open('download')
  assert.deepEqual(opened, [`${RELEASES}/tag/v0.8.0`, `${RELEASES}/download/v0.8.0/pgDEV-0.8.0-win-x64-portable.exe`])
  await assert.rejects(updates.open('https://evil.example'), /Unknown update link/)
  await assert.rejects(updates.open({ url: 'https://evil.example' }), /Unknown update link/)

  const installer = checker({ body: release() }, { environment: () => ({ platform: 'win32', portable: false }) })
  await installer.updates.check()
  await assert.rejects(installer.updates.open('download'), /updates with a command/)
})
