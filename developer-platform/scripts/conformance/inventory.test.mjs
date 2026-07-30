import { describe, expect, it } from 'vitest'
import { buildConformanceInventory, formatInventorySummary } from './inventory.mjs'

describe('Developer Platform conformance inventory', () => {
  it('joins all published operations with their governance and client surfaces', async () => {
    const inventory = await buildConformanceInventory()

    expect(inventory).toMatchObject({
      contractVersion: '1.0.0',
      schemaVersion: 1,
      summary: {
        byVersion: { v0: 87, v1: 206 },
        mcp: { forbidden: 177, read: 29, total: 206 },
        total: 293,
      },
    })
    expect(inventory.inventoryDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      Object.values(inventory.contracts).every(
        (contract) => contract.bytes > 0 && /^[a-f0-9]{64}$/.test(contract.sha256),
      ),
    ).toBe(true)
  })

  it('preserves V0 compatibility expectations instead of treating documented 501s as drift', async () => {
    const inventory = await buildConformanceInventory()
    const unavailable = inventory.operations.find(
      (operation) => operation.operationId === 'v0_delete_contactgroups',
    )
    const alias = inventory.operations.find(
      (operation) => operation.operationId === 'v0_delete_callnotes',
    )

    expect(unavailable).toMatchObject({
      compatibility: { contractStatus: 'unavailable', expectedUnavailable: true },
      surfaces: { api: { exposure: 'unavailable' } },
    })
    expect(alias).toMatchObject({
      compatibility: {
        classification: 'adaptation-required',
        contractStatus: 'deprecated-alias',
        expectedUnavailable: false,
        replacement: { operationId: 'archiveCallNote' },
      },
    })
  })

  it('classifies V1 preconditions, scopes, and surface decisions', async () => {
    const inventory = await buildConformanceInventory()
    const taskUpdate = inventory.operations.find(
      (operation) => operation.operationId === 'updateTask',
    )
    const workspace = inventory.operations.find(
      (operation) => operation.operationId === 'getWorkspace',
    )

    expect(taskUpdate).toMatchObject({
      authenticated: true,
      cleanupRequired: true,
      ifMatchRequired: true,
      requiredScopes: ['tasks:write'],
      risk: 'mutation',
      surfaces: {
        api: { exposure: 'supported' },
        cli: { command: 'tasks update', exposure: 'supported' },
        mcp: { exposure: 'forbidden' },
        sdk: { exposure: 'supported', method: 'tasks.update' },
      },
    })
    expect(workspace).toMatchObject({
      cleanupRequired: false,
      risk: 'read',
      surfaces: {
        mcp: { exposure: 'read', tool: 'teamgrid_workspace_get' },
      },
      testability: { automaticReadProbe: true, requiresFixture: false },
    })
  })

  it('prints a deterministic human-readable planning summary', async () => {
    const summary = formatInventorySummary(await buildConformanceInventory())
    expect(summary).toContain('293 API operations (87 V0, 206 V1)')
    expect(summary).toContain('29 MCP reads; 177 operations intentionally forbidden')
  })
})
