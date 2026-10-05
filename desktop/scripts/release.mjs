import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const tag = process.env.RELEASE_TAG
if (tag !== `v${version}`) throw new Error('Release version mismatch')
const directory = 'release-artifacts'
const files = (await readdir(directory)).filter((name) => /\.(exe|dmg|zip|deb|rpm)$/.test(name)).sort()
for (const extension of ['exe', 'dmg', 'zip', 'deb', 'rpm']) {
  if (!files.some((name) => name.endsWith(`.${extension}`))) throw new Error(`Missing ${extension} release artifact`)
}
const sums = []
for (const name of files) {
  const hash = createHash('sha256').update(await readFile(join(directory, name))).digest('hex')
  sums.push(`${hash}  ${name}`)
}
await writeFile(join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
let existing
try { existing = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft'])) } catch {}
if (existing && !existing.isDraft) throw new Error('An already published release will not be changed')
if (!existing) gh(['release', 'create', tag, '--verify-tag', '--draft', '--generate-notes', '--title', `pgDEV ${version}${process.env.UNSIGNED_PREVIEW === 'true' ? ' — unsigned preview' : ''}`])
gh(['release', 'upload', tag, ...[...files, 'SHA256SUMS.txt'].map((name) => join(directory, name)), '--clobber'])
console.log(`Draft ${tag} has all platform artifacts and checksums. Publish it only after review.`)
