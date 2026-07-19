import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { TeamGridClient } from '../packages/api-client/dist/index.js'
import { createProgram } from '../packages/cli/dist/index.js'
import { createTeamGridMcpServer } from '../packages/mcp-server/dist/index.js'

const syntheticToken = // gitleaks:allow -- fixed-format non-secret contract fixture
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function fail(message) {
  throw new Error(`Operation surface gate failed: ${message}`)
}

function openApiOperations(openapi) {
  const operations = []
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation?.operationId) continue
      if ((operation.security || []).some((item) => item.bearerAuth?.length)) {
        fail(`${operation.operationId} puts TeamGrid scopes on an HTTP bearer scheme`)
      }
      const scopes = operation['x-teamgrid-required-scopes'] || []
      operations.push({
        method: method.toUpperCase(),
        operationId: operation.operationId,
        path,
        scope: scopes[0] || null,
      })
    }
  }
  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId))
}

function commandPaths(command, prefix = []) {
  const result = []
  for (const child of command.commands) {
    const current = [...prefix, child.name()]
    result.push(current.join(' '), ...commandPaths(child, current))
  }
  return result
}

function hasFunction(root, dottedPath) {
  const parts = dottedPath.split('.')
  let current = root
  for (const part of parts) current = current?.[part]
  return typeof current === 'function'
}

const [openapi, ledger] = await Promise.all([
  readFile(new URL('../../openapi/v1.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../../openapi/developer-capabilities.json', import.meta.url), 'utf8').then(
    JSON.parse,
  ),
])

const expectedOperations = openApiOperations(openapi)
const policyOperations = ledger.operationPolicy
  .map((operation) => ({
    method: operation.method,
    operationId: operation.operationId,
    path: operation.path,
    scope: operation.scope,
  }))
  .sort((left, right) => left.operationId.localeCompare(right.operationId))
if (JSON.stringify(expectedOperations) !== JSON.stringify(policyOperations)) {
  fail('OpenAPI and developer capability policy operation sets differ')
}

const sdk = new TeamGridClient({ fetch: async () => new Response(null, { status: 500 }), token: syntheticToken })
for (const operation of ledger.operationPolicy) {
  if (!hasFunction(sdk, operation.sdk)) fail(`${operation.operationId} lacks SDK method ${operation.sdk}`)
}

const cliCommands = new Set(commandPaths(createProgram()))
for (const operation of ledger.operationPolicy) {
  if (!cliCommands.has(operation.cli)) fail(`${operation.operationId} lacks CLI command ${operation.cli}`)
}

const method = async () => ({ data: [], meta: {} })
const fakeClient = new Proxy({}, {
  get: () => new Proxy({}, { get: () => method }),
})
const mcpServer = createTeamGridMcpServer(fakeClient, { toolProfile: 'all' })
const mcpClient = new Client({ name: 'surface-gate', version: '1.0.0' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)])
try {
  const advertised = new Set((await mcpClient.listTools()).tools.map((tool) => tool.name))
  const expected = new Set(
    ledger.operationPolicy
      .filter((operation) => operation.mcp.exposure === 'read')
      .map((operation) => operation.mcp.tool),
  )
  if (JSON.stringify([...advertised].sort()) !== JSON.stringify([...expected].sort())) {
    fail('advertised MCP tools differ from the explicit read policy')
  }
} finally {
  await mcpClient.close()
  await mcpServer.close()
}

console.log(`${ledger.operationPolicy.length} operations have verified SDK, CLI, and MCP decisions`)
