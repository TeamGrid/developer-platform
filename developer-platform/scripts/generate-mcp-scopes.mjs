import { readFile, writeFile } from 'node:fs/promises'

const ledger = JSON.parse(await readFile(new URL('../../openapi/developer-capabilities.json', import.meta.url), 'utf8'))
const scopeCatalog = JSON.parse(await readFile(new URL('../../openapi/developer-scopes.json', import.meta.url), 'utf8'))
const supportedScopes = scopeCatalog.scopes.filter(scope => scope.availability === 'issuable').map(scope => scope.name).sort()
const entries = ledger.operationPolicy.filter((operation) => operation.mcp.exposure !== 'forbidden')
const scopes = Object.fromEntries(entries.map((operation) => [operation.mcp.tool, [
  ...new Set([operation.scope, ...(operation.additionalScopes || []),
    ...(operation.mcp.exposure === 'gated-write' ? ['workspace:read'] : [])].filter(Boolean)),
]]).sort(([a], [b]) => a.localeCompare(b)))
const source = `// Generated from the canonical capability contract. Run generate:mcp-scopes.\nimport type { McpToolName } from './toolProfiles.js'\n\nexport const toolScopes = ${JSON.stringify(scopes, null, 2)} as const satisfies Record<McpToolName, readonly [string, ...string[]]>\n\n/** Advertised support is distinct from initial consent and never grants authority. */\nexport const supportedOAuthScopes = ${JSON.stringify(supportedScopes, null, 2)} as const\n`
const destination = new URL('../packages/mcp-server/src/toolScopes.ts', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== source) throw new Error('Generated MCP scopes are stale.')
} else {
  await writeFile(destination, source)
}
