#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { redactDeveloperSecrets } from '@teamgrid/api-client'
import { createMcpApiClient, parseMcpArguments } from './config.js'
import { createTeamGridMcpServer } from './server.js'
import { checkMcpAccess, describeMcpAccess } from './setup.js'
import { parseMcpToolFilter, parseMcpToolProfile } from './toolProfiles.js'

const helpText = `Usage: teamgrid-mcp [--profile <name>] [--tool-profile <profile>] [--allow-tool <name>] [--deny-tool <name>]

Starts the TeamGrid MCP server over stdio. Read-only by default; work, full and domain profiles explicitly enable writes.

Options:
  --profile <name>  Use a TeamGrid CLI keychain profile
  --tool-profile    core (default), collaboration, governance, all, context, work, full,
                    tasks-write, projects-write, schedule-write, time-write, content-write,
                    crm-write, catalog-write, finance-write, admin-write, integrations-write
  --allow-tool      Narrow the profile to an exact tool; repeat or comma-separate
  --deny-tool       Remove an exact tool; repeat or comma-separate
  --explain-scopes  Print exact required permissions without reading credentials or contacting TeamGrid
  --check           Verify the current credential, workspace and tool scopes, then exit
  -h, --help        Show this help
`

async function main() {
  const args = process.argv.slice(2)
  const firstArgument = args[0]
  if (args.length === 1 && firstArgument && ['-h', '--help'].includes(firstArgument)) {
    process.stdout.write(helpText)
    return
  }
  const parsed = parseMcpArguments(args)
  const toolProfile =
    parsed.toolProfile || parseMcpToolProfile(process.env.TEAMGRID_MCP_TOOL_PROFILE)
  const allowTools =
    parsed.allowTools ||
    (process.env.TEAMGRID_MCP_ALLOW_TOOLS === undefined
      ? undefined
      : parseMcpToolFilter(process.env.TEAMGRID_MCP_ALLOW_TOOLS, 'MCP allow filter'))
  const denyTools =
    parsed.denyTools || parseMcpToolFilter(process.env.TEAMGRID_MCP_DENY_TOOLS, 'MCP deny filter')
  const options = { allowTools, denyTools, toolProfile }
  if (parsed.diagnostic === 'explain-scopes') {
    process.stdout.write(`${JSON.stringify(describeMcpAccess(options), null, 2)}\n`)
    return
  }
  const client = await createMcpApiClient(args)
  if (parsed.diagnostic === 'check') {
    const report = await checkMcpAccess(client, options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.ready) process.exitCode = 1
    return
  }
  const server = serveStdio(() =>
    createTeamGridMcpServer(client, { allowTools, denyTools, toolProfile }),
  )
  const shutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

try {
  await main()
} catch (error) {
  process.stderr.write(
    `teamgrid-mcp: ${redactDeveloperSecrets(
      error instanceof Error ? error.message : 'Failed to start.',
    )}\n`,
  )
  process.exitCode = 1
}
