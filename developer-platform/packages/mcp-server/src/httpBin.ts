#!/usr/bin/env node
import { createRegionalMcpAdmission } from './admission.js'
import { createRegionalMcpGateway } from './gateway.js'
import { parseMcpHostClients } from './hostProfiles.js'
import { createMcpNodeServer } from './httpServer.js'
import { createMcpReadinessProbe } from './readiness.js'
import { parseMcpToolProfile } from './toolProfiles.js'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}
function flag(name: string) {
  const value = process.env[name] ?? 'false'
  if (value !== 'true' && value !== 'false') throw new Error(`Invalid ${name}.`)
  return value === 'true'
}

async function main() {
  const resourceUrl = required('TEAMGRID_MCP_RESOURCE')
  const issuerUrl = required('TEAMGRID_OAUTH_ISSUER')
  const serviceSecret = required('TEAMGRID_MCP_SERVICE_SECRET')
  const enabled = flag('TEAMGRID_MCP_ENABLED')
  const writes = flag('TEAMGRID_MCP_WRITES_ENABLED')
  const port = Number(process.env.PORT ?? '8080')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.')
  const host = process.env.TEAMGRID_MCP_LISTEN_HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) throw new Error('Invalid listen host.')
  const gateway = createRegionalMcpGateway({
    resourceUrl,
    issuerUrl,
    serviceSecret,
    apiBaseUrl: required('TEAMGRID_API_BASE_URL'),
    apiOriginSecret: required('TEAMGRID_API_ORIGIN_SECRET'),
    region: required('TEAMGRID_REGION'),
    cellId: required('TEAMGRID_CELL_ID'),
    toolProfile: parseMcpToolProfile(process.env.TEAMGRID_MCP_TOOL_PROFILE),
    hostClients: parseMcpHostClients(process.env.TEAMGRID_MCP_HOST_CLIENTS),
    allowedOrigins: (process.env.TEAMGRID_MCP_ALLOWED_ORIGINS ?? '').split(' ').filter(Boolean),
    enabled: () => enabled,
    writesEnabled: () => writes,
    admitRequest: createRegionalMcpAdmission(issuerUrl, serviceSecret),
    observe: (event) => {
      process.stderr.write(`${JSON.stringify(event)}\n`)
    },
  })
  const runtime = createMcpNodeServer(resourceUrl, gateway, {
    ready: createMcpReadinessProbe(issuerUrl, () => enabled),
  })
  await new Promise<void>((resolve, reject) => {
    runtime.server.once('error', reject)
    runtime.server.listen(port, host, resolve)
  })
  // No request URLs, headers, bodies, subjects or raw errors are logged.
  process.stderr.write('teamgrid-mcp-http: listening\n')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await runtime.close()
  }
  for (const name of ['SIGINT', 'SIGTERM'] as const)
    process.once(name, () => {
      void stop().catch(() => {
        process.exitCode = 1
      })
    })
}

main().catch(() => {
  process.stderr.write('teamgrid-mcp-http: startup failed; check the regional configuration.\n')
  process.exitCode = 1
})
