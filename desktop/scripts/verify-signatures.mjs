import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.UNSIGNED_PREVIEW === 'true') {
  console.log('Unsigned preview: signature checks deliberately skipped.')
} else if (process.platform === 'darwin') {
  const app = resolve('release/mac-arm64/pgDEV.app')
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', `${app}/Contents/Resources/helpers/pgdev-mcp`], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' })
} else if (process.platform === 'win32') {
  const paths = [resolve('release/win-unpacked/pgDEV.exe'), resolve('release/win-unpacked/resources/helpers/pgdev-mcp.exe')]
  for (const name of readdirSync('release').filter((name) => name.endsWith('.exe'))) paths.push(resolve('release', name))
  for (const path of paths) {
    execFileSync('powershell', ['-NoProfile', '-Command', `if ((Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}').Status -ne 'Valid') { throw 'Release signature is invalid' }`], { stdio: 'inherit' })
  }
}
