import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mcpOperationPolicy } from './mcp-exposure-policy.mjs'

describe('MCP exclusion of the disabled legacy workflow product', () => {
  it('excludes all eleven workflow operations while preserving the canonical API and SDK/CLI bindings', () => {
    const operations = JSON.parse(readFileSync(new URL('../../../openapi/developer-capabilities.json', import.meta.url))).operationPolicy
    const before = structuredClone(operations)
    const result = mcpOperationPolicy(operations)
    const excluded = result.filter(operation => /^automations:/.test(operation.scope || ''))
    expect(excluded).toHaveLength(11)
    for (const operation of excluded) {
      expect(operation.mcp).toEqual({ exposure: 'forbidden', reason: expect.stringContaining('separate product rebuild') })
      const original = operations.find(entry => entry.operationId === operation.operationId)
      expect({ ...operation, mcp: original.mcp }).toEqual(original)
    }
    expect(operations).toEqual(before)
    expect(result.filter(operation => operation.mcp.exposure !== 'forbidden')).toHaveLength(197)
    expect(result.find(operation => operation.operationId === 'createTask')).toBe(operations.find(operation => operation.operationId === 'createTask'))
    expect(result.find(operation => operation.operationId === 'createTaskRecurrence').mcp.exposure).toBe('gated-write')
  })

  it.each([
    { scope: 'automations:future' },
    { path: '/automation-runs/future' },
    { sdk: 'automationDefinitions.future' },
    { mcp: { exposure: 'read', domain: 'automation-write' } },
  ])('also excludes future workflow entries matched by %j', matching => {
    const operation = { operationId: 'futureWorkflowOperation', mcp: { exposure: 'read', tool: 'teamgrid_future_workflow' }, ...matching }
    expect(mcpOperationPolicy([operation])[0].mcp).toEqual({ exposure: 'forbidden', reason: expect.any(String) })
  })
})
