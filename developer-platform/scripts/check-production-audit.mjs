import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const allowedProductionSdkImports = new Set([
  '@modelcontextprotocol/server',
  '@modelcontextprotocol/server/stdio',
  // Explicit Draft 2020-12 entry; the MCP bundled Ajv export uses Draft 7.
  // Only reviewed local schemas are compiled. No network or caller schemas.
  'ajv/dist/2020.js',
  'ajv-formats/dist/formats.js',
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
  return [...source.matchAll(/from\s+['"]((?:@modelcontextprotocol\/|ajv\/|ajv-formats\/)[^'"]+)['"]/g)]
    .map((match) => ({ path, specifier: match[1] }))
})

for (const { path, specifier } of sdkImports) {
  if (!allowedProductionSdkImports.has(specifier)) {
    fail(`${path} imports unreviewed MCP SDK surface ${specifier}`)
  }
}
for (const requiredImport of allowedProductionSdkImports) {
  if (!sdkImports.some(({ specifier }) => specifier === requiredImport)) {
    fail(`expected reviewed MCP import ${requiredImport} is missing`)
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
if (Object.keys(vulnerabilities).length > 0) {
  fail(`unreviewed production vulnerabilities: ${Object.keys(vulnerabilities).sort().join(', ')}`)
}
console.log('Production dependencies contain no known vulnerabilities.')
