if (process.arch !== process.env.EXPECTED_ARCH) throw new Error('Runner architecture does not match the release target')
if (process.env.UNSIGNED_PREVIEW !== 'true') {
  const required = process.platform === 'darwin'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    : process.platform === 'win32' ? ['CSC_LINK', 'CSC_KEY_PASSWORD'] : []
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) throw new Error(`Signing configuration is incomplete: ${missing.join(', ')}. Use an explicitly unsigned preview for development.`)
}
