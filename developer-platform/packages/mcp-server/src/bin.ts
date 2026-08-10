#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { redactDeveloperSecrets } from '@teamgrid/api-client'
import { createMcpApiClient, parseMcpArguments } from './config.js'
import { createTeamGridMcpServer } from './server.js'
import { parseMcpToolFilter, parseMcpToolProfile } from './toolProfiles.js'

const helpText = `Usage: teamgrid-mcp [--profile <name>] [--tool-profile <profile>] [--allow-tool <name>] [--deny-tool <name>]

Starts the optional read-only TeamGrid MCP server over stdio.

Options:
  --profile <name>  Use a TeamGrid CLI keychain profile
  --tool-profile    core (default), collaboration, governance, or all
  --allow-tool      Narrow the profile to an exact tool; repeat or comma-separate
  --deny-tool       Remove an exact tool; repeat or comma-separate
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
  const client = await createMcpApiClient(args)
  const toolProfile =
    parsed.toolProfile || parseMcpToolProfile(process.env.TEAMGRID_MCP_TOOL_PROFILE)
  const allowTools =
    parsed.allowTools ||
    (process.env.TEAMGRID_MCP_ALLOW_TOOLS === undefined
      ? undefined
      : parseMcpToolFilter(process.env.TEAMGRID_MCP_ALLOW_TOOLS, 'MCP allow filter'))
  const denyTools =
    parsed.denyTools || parseMcpToolFilter(process.env.TEAMGRID_MCP_DENY_TOOLS, 'MCP deny filter')
  const server = createTeamGridMcpServer(client, { allowTools, denyTools, toolProfile })
  process.on('SIGINT', async () => {
    await server.close()
    process.exit(0)
  })
  await server.connect(new StdioServerTransport())
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
