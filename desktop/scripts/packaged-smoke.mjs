import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const executable = process.platform === 'win32' ? 'release/win-unpacked/pgDEV.exe'
  : process.platform === 'darwin' ? 'release/mac-arm64/pgDEV.app/Contents/MacOS/pgDEV'
    : 'release/linux-unpacked/pgdev'
const env = { ...process.env, PGDEV_DESKTOP_EXECUTABLE: resolve(executable) }
const command = process.platform === 'linux' ? 'xvfb-run' : process.execPath
const args = process.platform === 'linux' ? ['-a', process.execPath, 'desktop/scripts/smoke.mjs'] : ['desktop/scripts/smoke.mjs']
const result = spawnSync(command, args, { env, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
