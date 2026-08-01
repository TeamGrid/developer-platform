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

function functionReceiver(root, dottedPath) {
  const parts = dottedPath.split('.')
  const methodName = parts.pop()
  let receiver = root
  for (const part of parts) receiver = receiver?.[part]
  const method = receiver?.[methodName]
  if (typeof method !== 'function') throw new Error('sdk_surface_drift')
  return { method, receiver }
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

function automaticV1Reads(inventory) {
  return expectedV1Policy(inventory).filter(
    (operation) => operation.testability?.automaticReadProbe,
  )
}

function listArguments(operation, pageLimit) {
  return operation.parameters.some((parameter) => parameter.name === 'limit')
    ? { limit: pageLimit }
    : {}
}

export function verifySurfaceBindings({ client, cliCommands, inventory, mcpTools }) {
  const operations = expectedV1Policy(inventory)
  const sdkOperations = operations.filter(
    (operation) => operation.surfaces.sdk.exposure === 'supported',
  )
  const missingSdk = operations
    .filter((operation) => operation.surfaces.sdk.exposure === 'supported')
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
    sdkMethods: sdkOperations.length,
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
    retries: 0,
    timeoutMs: config.requestTimeoutMs,
    token: config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN,
  })
  const program = createProgram()
  const server = createTeamGridMcpServer(client, { toolProfile: 'all' })
  const mcpClient = new Client({ name: 'teamgrid-conformance', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)])
  const mcpTools = (await mcpClient.listTools()).tools.map((tool) => tool.name)

  return {
    cliCommands: commandPaths(program),
    client,
    close: () => Promise.allSettled([mcpClient.close(), server.close()]),
    mcpTools,
    runCliOperation: async (operation) => {
      const output = writableCapture()
      const errorOutput = writableCapture()
      const commandArguments = operation.surfaces.cli.command.split(' ')
      const exitCode = await runCli(
        [
          'node',
          'teamgrid',
          '--output',
          'json',
          '--base-url',
          config.target.v1BaseUrl,
          '--timeout',
          String(config.requestTimeoutMs),
          '--retries',
          '0',
          ...commandArguments,
          ...(operation.parameters.some((parameter) => parameter.name === 'limit')
            ? ['--limit', String(config.pageLimit)]
            : []),
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
      if (payload === undefined || payload === null) throw new Error('cli_response_invalid')
    },
    runMcpOperation: async (operation) => {
      const response = await mcpClient.callTool(
        {
          arguments: listArguments(operation, config.pageLimit),
          name: operation.surfaces.mcp.tool,
        },
        undefined,
        {
          maxTotalTimeout: config.requestTimeoutMs + 1_000,
          timeout: config.requestTimeoutMs + 1_000,
        },
      )
      if (response.isError || !response.structuredContent) {
        throw new Error('mcp_response_invalid')
      }
    },
    runSdkOperation: async (operation) => {
      const { method, receiver } = functionReceiver(client, operation.surfaces.sdk.method)
      await method.call(receiver, listArguments(operation, config.pageLimit))
    },
  }
}

function surfaceFailure(surface, note, operationId = 'getWorkspace', error) {
  return evidenceResult({
    note,
    ...(Number.isInteger(error?.status) ? { observedStatus: error.status } : {}),
    operationId,
    outcome: 'failed',
    ...(error?.requestId ? { requestId: error.requestId } : {}),
    surface,
    version: 'v1',
  })
}

function surfacePass(surface, note, operationId = 'getWorkspace') {
  return evidenceResult({
    note,
    operationId,
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

  try {
    const coverage = verifySurfaceBindings({
      client: runtime.client,
      cliCommands: runtime.cliCommands,
      inventory,
      mcpTools: runtime.mcpTools || [],
    })
    const reads = automaticV1Reads(inventory)
    const sdkReads = reads.filter((operation) => operation.surfaces.sdk.exposure === 'supported')
    for (const [index, operation] of sdkReads.entries()) {
      if (index > 0) await sleep(config.requestIntervalMs)
      try {
        await runtime.runSdkOperation(operation)
        results.push(surfacePass('sdk', 'live_read_succeeded', operation.operationId))
      } catch (error) {
        results.push(surfaceFailure('sdk', 'sdk_live_read_failed', operation.operationId, error))
      }
    }
    for (const [index, operation] of reads.entries()) {
      if (index > 0 || reads.length > 0) await sleep(config.requestIntervalMs)
      try {
        await runtime.runCliOperation(operation)
        results.push(surfacePass('cli', 'live_read_succeeded', operation.operationId))
      } catch (error) {
        results.push(surfaceFailure('cli', 'cli_live_read_failed', operation.operationId, error))
      }
    }
    const mcpReads = reads.filter((operation) => operation.surfaces.mcp.exposure === 'read')
    for (const [index, operation] of mcpReads.entries()) {
      if (index > 0 || reads.length > 0) await sleep(config.requestIntervalMs)
      try {
        await runtime.runMcpOperation(operation)
        results.push(surfacePass('mcp', 'live_read_succeeded', operation.operationId))
      } catch (error) {
        results.push(surfaceFailure('mcp', 'mcp_live_read_failed', operation.operationId, error))
      }
    }
    for (const surface of ['sdk', 'cli', 'mcp']) {
      const first = results.find((result) => result.surface === surface)
      if (first) first.coverage = coverage
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : 'surface_policy_drift'
    return [surfaceFailure('sdk', note), surfaceFailure('cli', note), surfaceFailure('mcp', note)]
  } finally {
    await runtime.close?.()
  }
  return results
}
