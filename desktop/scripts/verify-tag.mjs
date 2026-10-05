import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const tag = process.env.RELEASE_TAG ?? ''
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Release tag must match the existing package version')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const tagged = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim()
if (head !== tagged) throw new Error('Release checkout does not match the version tag')
console.log(`Verified ${tag}; no version files or tags were modified.`)
