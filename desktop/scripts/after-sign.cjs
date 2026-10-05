const { join } = require('node:path')

// Windows does not automatically sign executable extraResources. Sign the
// standalone MCP helper with the same configured identity as the application.
module.exports = async (context) => {
  if (context.electronPlatformName !== 'win32' || !process.env.CSC_LINK) return
  const sign = context.packager.signIf || context.packager.sign
  if (typeof sign !== 'function') throw new Error('The packager cannot sign the MCP helper')
  await sign.call(context.packager, join(context.appOutDir, 'resources', 'helpers', 'pgdev-mcp.exe'))
}
