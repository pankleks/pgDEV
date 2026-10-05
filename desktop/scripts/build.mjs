import { build } from 'esbuild'
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { inject } from 'postject'

await mkdir('desktop/generated', { recursive: true })
await build({
  entryPoints: { backend: 'desktop/backend.mjs' },
  outdir: 'desktop/generated',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['pg-native'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __dirnameOf } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);" },
})

// A dedicated stdio helper avoids Electron's GUI-process stdin limitations.
// This SEA contains the MCP SDK and does not require Node on the user's machine.
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
await build({
  entryPoints: ['bin/pgdev-mcp.mjs'], outfile: 'desktop/generated/mcp.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  define: { 'process.env.PGDEV_APP_VERSION': JSON.stringify(version) },
})
const config = resolve('desktop/generated/sea-config.json')
const blob = resolve('desktop/generated/mcp.blob')
await writeFile(config, JSON.stringify({ main: resolve('desktop/generated/mcp.cjs'), output: blob, disableExperimentalSEAWarning: true, execArgvExtension: 'none' }))
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })
const helper = resolve(`desktop/generated/pgdev-mcp${process.platform === 'win32' ? '.exe' : ''}`)
await copyFile(process.execPath, helper)
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', helper])
await inject(helper, 'NODE_SEA_BLOB', await readFile(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
})
await chmod(helper, 0o755)
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', helper])
