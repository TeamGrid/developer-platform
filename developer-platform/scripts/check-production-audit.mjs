import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const acceptedAdvisory = 'https://github.com/advisories/GHSA-frvp-7c67-39w9'
const acceptedPackages = new Set(['@hono/node-server', '@modelcontextprotocol/sdk'])
const allowedProductionSdkImports = new Set([
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
])

function fail(message) {
  throw new Error(`Production dependency audit failed: ${message}`)
}

function sourceFiles(directory) {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) return sourceFiles(path)
      return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
    })
}

const mcpSourceDirectory = resolve('packages/mcp-server/src')
const sdkImports = sourceFiles(mcpSourceDirectory).flatMap((path) => {
  const source = readFileSync(path, 'utf8')
  return [...source.matchAll(/from\s+['"](@modelcontextprotocol\/sdk\/[^'"]+)['"]/g)]
    .map((match) => ({ path, specifier: match[1] }))
})

for (const { path, specifier } of sdkImports) {
  if (!allowedProductionSdkImports.has(specifier)) {
    fail(`${path} imports unreviewed MCP SDK surface ${specifier}`)
  }
}
for (const requiredImport of allowedProductionSdkImports) {
  if (!sdkImports.some(({ specifier }) => specifier === requiredImport)) {
    fail(`expected MCP stdio-only import ${requiredImport} is missing`)
  }
}

const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (!result.stdout.trim()) fail(`npm audit returned no JSON: ${result.stderr.trim()}`)

let report
try {
  report = JSON.parse(result.stdout)
} catch {
  fail(`npm audit returned invalid JSON: ${result.stdout.slice(0, 240)}`)
}

const vulnerabilities = report.vulnerabilities || {}
for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (!acceptedPackages.has(name)) fail(`${name} has an unaccepted vulnerability`)
  if (!['moderate'].includes(vulnerability.severity)) {
    fail(`${name} has unexpected ${vulnerability.severity} severity`)
  }
  const advisoryUrls = (vulnerability.via || [])
    .filter((entry) => typeof entry === 'object' && entry !== null)
    .map((entry) => entry.url)
  const aliases = (vulnerability.via || []).filter(entry => typeof entry === 'string')
  if (
    !advisoryUrls.includes(acceptedAdvisory)
    && !(name === '@modelcontextprotocol/sdk' && aliases.includes('@hono/node-server'))
  ) {
    fail(`${name} is not exclusively explained by the reviewed Hono advisory`)
  }
}

if (report.metadata?.vulnerabilities?.high || report.metadata?.vulnerabilities?.critical) {
  fail('high or critical production vulnerabilities remain')
}

const names = Object.keys(vulnerabilities).sort()
console.log(names.length === 0
  ? 'Production dependencies contain no known vulnerabilities.'
  : 'Production dependencies contain no high/critical findings; every reported moderate '
    + 'finding is the reviewed unreachable Hono advisory and the shipped MCP binary imports '
    + 'only stdio transport.')
