import { Writable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { evidenceResult } from './evidence.mjs'

function commandPaths(command, prefix = []) {
  const result = []
  for (const child of command.commands || []) {
    const current = [...prefix, child.name()]
    result.push(current.join(' '), ...commandPaths(child, current))
  }
  return result
}

function hasFunction(root, dottedPath) {
  let current = root
  for (const part of dottedPath.split('.')) current = current?.[part]
  return typeof current === 'function'
}

function writableCapture() {
  let content = ''
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        content += chunk.toString()
        callback()
      },
    }),
    text: () => content,
  }
}

function expectedV1Policy(inventory) {
  return inventory.operations.filter((operation) => operation.version === 'v1')
}

export function verifySurfaceBindings({ client, cliCommands, inventory, mcpTools }) {
  const operations = expectedV1Policy(inventory)
  const missingSdk = operations
    .filter((operation) => !hasFunction(client, operation.surfaces.sdk.method))
    .map((operation) => operation.operationId)
  const commandSet = new Set(cliCommands)
  const missingCli = operations
    .filter((operation) => !commandSet.has(operation.surfaces.cli.command))
    .map((operation) => operation.operationId)
  const expectedMcp = operations
    .filter((operation) => operation.surfaces.mcp.exposure === 'read')
    .map((operation) => operation.surfaces.mcp.tool)
    .sort()
  const actualMcp = [...mcpTools].sort()

  if (missingSdk.length > 0) throw new Error('sdk_surface_drift')
  if (missingCli.length > 0) throw new Error('cli_surface_drift')
  if (JSON.stringify(expectedMcp) !== JSON.stringify(actualMcp)) {
    throw new Error('mcp_surface_drift')
  }
  return {
    cliCommands: operations.length,
    mcpTools: expectedMcp.length,
    sdkMethods: operations.length,
  }
}

async function loadDefaultRuntime(config) {
  const [{ TeamGridClient }, { createProgram, runCli }, { createTeamGridMcpServer }] =
    await Promise.all([
      import('../../packages/api-client/dist/index.js'),
      import('../../packages/cli/dist/index.js'),
      import('../../packages/mcp-server/dist/index.js'),
    ])
  const client = new TeamGridClient({
    baseUrl: config.target.v1BaseUrl,
    retries: 2,
    timeoutMs: config.requestTimeoutMs,
    token: config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN,
  })
  const program = createProgram()

  return {
    cliCommands: commandPaths(program),
    client,
    runCliWorkspace: async () => {
      const output = writableCapture()
      const errorOutput = writableCapture()
      const exitCode = await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          '--base-url',
          config.target.v1BaseUrl,
          'workspace',
        ],
        {
          configStore: {
            load: async () => ({ profiles: {}, version: 1 }),
          },
          environment: {
            TEAMGRID_API_TOKEN: config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN,
          },
          errorOutput: errorOutput.output,
          output: output.output,
        },
      )
      if (exitCode !== 0) throw new Error('cli_request_failed')
      const payload = JSON.parse(output.text())
      if (!payload?.id || payload.type !== 'workspace') throw new Error('cli_response_invalid')
    },
    runMcpWorkspace: async () => {
      const server = createTeamGridMcpServer(client, { toolProfile: 'all' })
      const mcpClient = new Client({ name: 'teamgrid-conformance', version: '1.0.0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)])
      try {
        const tools = await mcpClient.listTools()
        const response = await mcpClient.callTool({
          arguments: {},
          name: 'teamgrid_workspace_get',
        })
        if (response.isError || !response.structuredContent) {
          throw new Error('mcp_response_invalid')
        }
        return tools.tools.map((tool) => tool.name)
      } finally {
        await Promise.allSettled([mcpClient.close(), server.close()])
      }
    },
    runSdkWorkspace: async () => {
      const response = await client.workspace.get()
      if (!response?.data?.id || response.data.type !== 'workspace') {
        throw new Error('sdk_response_invalid')
      }
    },
  }
}

function surfaceFailure(surface, note) {
  return evidenceResult({
    note,
    operationId: 'getWorkspace',
    outcome: 'failed',
    surface,
    version: 'v1',
  })
}

function surfacePass(surface, note) {
  return evidenceResult({
    note,
    operationId: 'getWorkspace',
    outcome: 'passed',
    surface,
    version: 'v1',
  })
}

export async function executeSurfaceConformance({
  config,
  inventory,
  runtimeLoader = loadDefaultRuntime,
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const results = []
  let runtime
  try {
    runtime = await runtimeLoader(config)
  } catch {
    return [
      surfaceFailure('sdk', 'package_runtime_unavailable'),
      surfaceFailure('cli', 'package_runtime_unavailable'),
      surfaceFailure('mcp', 'package_runtime_unavailable'),
    ]
  }

  let mcpTools
  try {
    await runtime.runSdkWorkspace()
    results.push(surfacePass('sdk', 'all_methods_bound_and_workspace_live'))
  } catch {
    results.push(surfaceFailure('sdk', 'sdk_workspace_check_failed'))
  }

  await sleep(config.requestIntervalMs)
  try {
    await runtime.runCliWorkspace()
    results.push(surfacePass('cli', 'all_commands_bound_and_workspace_live'))
  } catch {
    results.push(surfaceFailure('cli', 'cli_workspace_check_failed'))
  }

  await sleep(config.requestIntervalMs)
  try {
    mcpTools = await runtime.runMcpWorkspace()
    results.push(surfacePass('mcp', 'exact_read_tools_bound_and_workspace_live'))
  } catch {
    results.push(surfaceFailure('mcp', 'mcp_workspace_check_failed'))
  }

  try {
    const coverage = verifySurfaceBindings({
      client: runtime.client,
      cliCommands: runtime.cliCommands,
      inventory,
      mcpTools: mcpTools || [],
    })
    for (const result of results) result.coverage = coverage
  } catch (error) {
    const note = error instanceof Error ? error.message : 'surface_policy_drift'
    for (const result of results) {
      result.note = note
      result.outcome = 'failed'
    }
  }
  return results
}
