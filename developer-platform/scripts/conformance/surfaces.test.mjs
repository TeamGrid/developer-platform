import { describe, expect, it } from 'vitest'
import { executeSurfaceConformance, verifySurfaceBindings } from './surfaces.mjs'

function inventory() {
  return {
    operations: [
      {
        operationId: 'getWorkspace',
        surfaces: {
          cli: { command: 'workspace' },
          mcp: { exposure: 'read', tool: 'teamgrid_workspace_get' },
          sdk: { method: 'workspace.get' },
        },
        version: 'v1',
      },
      {
        operationId: 'updateWorkspaceSettings',
        surfaces: {
          cli: { command: 'workspace-settings update' },
          mcp: { exposure: 'forbidden' },
          sdk: { method: 'workspaceSettings.update' },
        },
        version: 'v1',
      },
    ],
  }
}

function runtime(overrides = {}) {
  return {
    cliCommands: ['workspace', 'workspace-settings', 'workspace-settings update'],
    client: {
      workspace: { get: () => undefined },
      workspaceSettings: { update: () => undefined },
    },
    runCliWorkspace: async () => undefined,
    runMcpWorkspace: async () => ['teamgrid_workspace_get'],
    runSdkWorkspace: async () => undefined,
    ...overrides,
  }
}

const config = { requestIntervalMs: 250 }

describe('SDK, CLI, and MCP conformance', () => {
  it('requires every V1 operation to be bound and the exact MCP allowlist', () => {
    expect(
      verifySurfaceBindings({
        cliCommands: runtime().cliCommands,
        client: runtime().client,
        inventory: inventory(),
        mcpTools: ['teamgrid_workspace_get'],
      }),
    ).toEqual({
      cliCommands: 2,
      mcpTools: 1,
      sdkMethods: 2,
    })

    expect(() =>
      verifySurfaceBindings({
        cliCommands: ['workspace'],
        client: runtime().client,
        inventory: inventory(),
        mcpTools: ['teamgrid_workspace_get'],
      }),
    ).toThrow('cli_surface_drift')
  })

  it('combines complete static bindings with one live read through every client surface', async () => {
    const results = await executeSurfaceConformance({
      config,
      inventory: inventory(),
      runtimeLoader: async () => runtime(),
      sleep: () => Promise.resolve(),
    })

    expect(results).toMatchObject([
      {
        coverage: { cliCommands: 2, mcpTools: 1, sdkMethods: 2 },
        outcome: 'passed',
        surface: 'sdk',
      },
      { outcome: 'passed', surface: 'cli' },
      { outcome: 'passed', surface: 'mcp' },
    ])
  })

  it('returns redacted failures and fails all surfaces on policy drift', async () => {
    const requestFailure = await executeSurfaceConformance({
      config,
      inventory: inventory(),
      runtimeLoader: async () =>
        runtime({
          runCliWorkspace: async () => {
            throw new Error('secret upstream response')
          },
        }),
      sleep: () => Promise.resolve(),
    })
    expect(requestFailure[1]).toMatchObject({
      note: 'cli_workspace_check_failed',
      outcome: 'failed',
    })
    expect(JSON.stringify(requestFailure)).not.toContain('secret upstream response')

    const drift = await executeSurfaceConformance({
      config,
      inventory: inventory(),
      runtimeLoader: async () => runtime({ cliCommands: ['workspace'] }),
      sleep: () => Promise.resolve(),
    })
    expect(drift.every((result) => result.outcome === 'failed')).toBe(true)
    expect(drift.every((result) => result.note === 'cli_surface_drift')).toBe(true)
  })
})
