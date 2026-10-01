import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.USERPROFILE ?? process.env.HOME
const installed = home && join(home, '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
const cargo = installed && existsSync(installed) ? installed : 'cargo'
const result = spawnSync(cargo, ['test', '-p', 'pgdev-core', 'frontend_contracts_match_rust'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)),
  env: { ...process.env, PGDEV_GENERATE_TYPES: '1' },
  stdio: 'inherit',
})
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
