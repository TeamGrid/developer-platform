import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8')
}

function requireFragments(label, source, fragments) {
  const missing = fragments.filter((fragment) => !source.includes(fragment))
  if (missing.length > 0) {
    throw new Error(`${label} is missing release documentation: ${missing.join(', ')}`)
  }
}

const [
  apiClientPackage,
  cliPackage,
  mcpPackage,
  capabilities,
  openApi,
  repositoryReadme,
  workspaceReadme,
  apiClientReadme,
  cliReadme,
] = await Promise.all([
  read('packages/api-client/package.json').then(JSON.parse),
  read('packages/cli/package.json').then(JSON.parse),
  read('packages/mcp-server/package.json').then(JSON.parse),
  read('../openapi/developer-capabilities.json').then(JSON.parse),
  read('../openapi/v1.json').then(JSON.parse),
  read('../README.md'),
  read('README.md'),
  read('packages/api-client/README.md'),
  read('packages/cli/README.md'),
])

const version = apiClientPackage.version
if (cliPackage.version !== version || mcpPackage.version !== version) {
  throw new Error('All public package versions must remain synchronized.')
}

const operations = capabilities.operationPolicy
const operationCount = operations.length
const sdkMethodCount = operations.filter((operation) => operation.sdk).length
const cliMappingCount = operations.filter((operation) => operation.cli).length
const mcpToolCount = operations.filter((operation) => operation.mcp?.exposure === 'read').length

requireFragments('repository README', repositoryReadme, [
  `the ${operationCount}-operation action-policy`,
  `npm install @teamgrid/api-client@${version}`,
  `npm install --global @teamgrid/cli@${version}`,
  `npm install --global @teamgrid/mcp-server@${version}`,
])

if (!new RegExp(`all 87 V0 and\\s+${operationCount} V1 operations`).test(workspaceReadme)) {
  throw new Error('Workspace README operation counts are stale.')
}
requireFragments('workspace README', workspaceReadme, [
  `all ${sdkMethodCount} SDK methods, all ${cliMappingCount} CLI operation mappings`,
  `exact ${mcpToolCount}-tool MCP allowlist`,
  'auth status --check',
  'auth logout --revoke',
  'webhooks test webhook-id',
  'teamgrid doctor',
])

requireFragments('API client README', apiClientReadme, [
  '`tg_pat_v2`',
  '`tg_sa_v2`',
  '`tg_sk_v1`',
  'authorization.getContext()',
  'authorization.revokeCurrentCredential()',
  "webhooks.testDelivery('webhook-id'",
  'exports.downloadStream',
])

requireFragments('CLI README', cliReadme, [
  'auth status --check',
  'auth logout --revoke',
  'webhooks test webhook-id',
  'teamgrid doctor',
])

const bearerAuth = openApi.components?.securitySchemes?.bearerAuth
if (
  bearerAuth?.bearerFormat !== 'tg_pat_v2 | tg_sa_v2 | tg_sk_v1 (legacy)' ||
  !bearerAuth.description?.includes('personal-access') ||
  !bearerAuth.description?.includes('service-account') ||
  !bearerAuth.description?.includes('Legacy tg_sk_v1')
) {
  throw new Error('OpenAPI bearer authentication documentation is incomplete.')
}

console.log(
  `Release documentation is current for ${operationCount} operations and package ${version}.`,
)
