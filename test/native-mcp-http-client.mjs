// Integration oracle using the existing official MCP SDK; test tooling only.
// Endpoint/token arrive via the environment, never arguments or stdout.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'pgdev-http-test', version: '1' })
const transport = new StreamableHTTPClientTransport(new URL(process.env.PGDEV_MCP_TEST_URL), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.PGDEV_MCP_TEST_TOKEN}` } },
})
try {
  await client.connect(transport)
  const listed = await client.listTools()
  const catalog = await client.callTool({ name: 'get_schema', arguments: {} })
  await client.ping()
  await transport.terminateSession()
  process.stdout.write(JSON.stringify({ tools: listed.tools.map(tool => tool.name), disconnected: catalog.isError === true }))
} catch {
  // Do not print SDK errors that might contain HTTP request credentials.
  process.exitCode = 1
} finally { await client.close() }
