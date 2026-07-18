#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpApiClient } from './config.js'
import { createTeamGridMcpServer } from './server.js'

const helpText = `Usage: teamgrid-mcp [--profile <name>]

Starts the optional read-only TeamGrid MCP server over stdio.

Options:
  --profile <name>  Use a TeamGrid CLI keychain profile
  -h, --help        Show this help
`

async function main() {
  const args = process.argv.slice(2)
  const firstArgument = args[0]
  if (args.length === 1 && firstArgument && ['-h', '--help'].includes(firstArgument)) {
    process.stdout.write(helpText)
    return
  }
  const client = await createMcpApiClient()
  const server = createTeamGridMcpServer(client)
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
    `teamgrid-mcp: ${error instanceof Error ? error.message : 'Failed to start.'}\n`,
  )
  process.exitCode = 1
}
