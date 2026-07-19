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

function commandsByPath(command, prefix = [], result = new Map()) {
  for (const child of command.commands) {
    const current = [...prefix, child.name()]
    result.set(current.join(' '), child)
    commandsByPath(child, current, result)
  }
  return result
}

function hasFunction(root, dottedPath) {
  const parts = dottedPath.split('.')
  let current = root
  for (const part of parts) current = current?.[part]
  return typeof current === 'function'
}

const [openapi, ledger, manifest] = await Promise.all([
  readFile(new URL('../../openapi/v1.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../../openapi/developer-capabilities.json', import.meta.url), 'utf8').then(
    JSON.parse,
  ),
  readFile(new URL('../../openapi/developer-platform-manifest.json', import.meta.url), 'utf8').then(
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

const expectedCasOperationIds = [
  'archiveProject',
  'archiveProjectTemplate',
  'archiveTask',
  'completeProject',
  'completeTask',
  'instantiateProjectTemplate',
  'reopenProject',
  'reopenTask',
  'restoreProject',
  'restoreProjectTemplate',
  'restoreTask',
  'updateProject',
  'updateProjectTemplate',
  'updateTask',
]
const casOperations = Object.values(openapi.paths)
  .flatMap((pathItem) => Object.values(pathItem))
  .filter((operation) => operation?.['x-teamgrid-resource-cas'] === 'resource-cas-v1')
  .sort((left, right) => left.operationId.localeCompare(right.operationId))
if (
  casOperations.length !== 14 ||
  JSON.stringify(casOperations.map((operation) => operation.operationId)) !==
    JSON.stringify(expectedCasOperationIds) ||
  manifest.summary?.resourceCasMutationOperations !== 14
) {
  fail('resource-cas-v1 must cover exactly the governed 14 mutation operations')
}
if (manifest.contractVersion !== openapi.info.version) {
  fail('contract manifest and OpenAPI versions differ')
}
for (const operation of casOperations) {
  const ifMatchParameters = (operation.parameters || []).filter((parameter) =>
    /^#\/components\/parameters\/IfMatch(?:Project|ProjectTemplate|Task)$/.test(
      parameter.$ref || '',
    ),
  )
  if (
    ifMatchParameters.length !== 1 ||
    operation.responses?.['412'] === undefined ||
    operation.responses?.['428'] === undefined
  ) {
    fail(`${operation.operationId} lacks its exact If-Match/412/428 contract`)
  }
}
const casOperationReadIds = ['getProjectLifecycleOperation', 'getProjectTemplateInstantiation']
const casOperationReads = Object.values(openapi.paths)
  .flatMap((pathItem) => Object.values(pathItem))
  .filter((operation) => casOperationReadIds.includes(operation?.operationId))
  .sort((left, right) => left.operationId.localeCompare(right.operationId))
if (
  casOperationReads.length !== 2 ||
  manifest.summary?.resourceCasOperationReads !== 2 ||
  casOperationReads.some((operation) => operation.responses?.['410'] === undefined)
) {
  fail('resource CAS operation reads must be exactly two and define legacy-revision 410 responses')
}

const finalExpansionRoots = new Set([
  'automation-actions',
  'automation-definitions',
  'automation-runs',
  'exports',
  'groups',
  'integration-installations',
  'invitations',
  'members',
  'roles',
  'search',
])
const finalExpansionPolicy = ledger.operationPolicy.filter((operation) =>
  finalExpansionRoots.has(operation.path.split('/').filter(Boolean)[0]),
)
const finalExpansionReads = finalExpansionPolicy.filter(
  (operation) => operation.mcp.exposure === 'read',
)
const finalExpansionForbidden = finalExpansionPolicy.filter(
  (operation) => operation.mcp.exposure === 'forbidden',
)
const finalExpansionRead = finalExpansionReads[0]
if (
  finalExpansionPolicy.length !== 36 ||
  finalExpansionForbidden.length !== 35 ||
  finalExpansionReads.length !== 1 ||
  finalExpansionRead.operationId !== 'searchResources' ||
  finalExpansionRead.mcp.exposure !== 'read' ||
  finalExpansionRead.mcp.tool !== 'teamgrid_search' ||
  finalExpansionRead.mcp.curated !== true ||
  finalExpansionRead.mcp.sensitive !== true ||
  Object.keys(finalExpansionRead.mcp).length !== 4
) {
  fail('final MCP expansion must expose only the sensitive curated teamgrid_search read')
}

const sdk = new TeamGridClient({ fetch: async () => new Response(null, { status: 500 }), token: syntheticToken })
for (const operation of ledger.operationPolicy) {
  if (!hasFunction(sdk, operation.sdk)) fail(`${operation.operationId} lacks SDK method ${operation.sdk}`)
}

const cliCommands = new Set(commandPaths(createProgram()))
const cliCommandMap = commandsByPath(createProgram())
for (const operation of ledger.operationPolicy) {
  if (!cliCommands.has(operation.cli)) fail(`${operation.operationId} lacks CLI command ${operation.cli}`)
}
for (const operation of casOperations) {
  const policy = ledger.operationPolicy.find((entry) => entry.operationId === operation.operationId)
  const command = policy && cliCommandMap.get(policy.cli)
  const ifMatchOptions = command?.options.filter((option) => option.long === '--if-match') || []
  if (
    !policy ||
    policy.mcp.exposure !== 'forbidden' ||
    ifMatchOptions.length !== 1 ||
    ifMatchOptions[0].mandatory !== true
  ) {
    fail(`${operation.operationId} must have one required CLI --if-match and no MCP exposure`)
  }
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
