import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { TeamGridClient } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { boundToolResult, maximumToolResultBytes } from './boundedResults.js'
import { responseFixture } from './fixtures.testSupport.js'
import type { McpToolObservation } from './observability.js'
import { createTeamGridMcpServer } from './server.js'

const etag = `"ct1-${'a'.repeat(64)}"`
async function connected() {
  const response = responseFixture('getContact', 'contact1')
  response.data.attributes.notes = '😀'.repeat(150000)
  const get = vi.fn(async () => ({ ...response, transport: { headers: { etag } } }))
  const update = vi.fn(async () => ({ ...response, transport: { headers: { etag } } }))
  const observations: McpToolObservation[] = []
  const api = {
    workspace: {
      get: async () => ({
        ...responseFixture('getWorkspace', 'workspace1'),
        transport: {
          headers: {
            'x-teamgrid-resource-cas': 'required-v1',
            'x-teamgrid-snapshot-cas': 'required-v1',
          },
        },
      }),
    },
    contacts: { get, update },
  } as unknown as TeamGridClient
  const server = createTeamGridMcpServer(api, {
    toolProfile: 'full',
    toolRequestId: () => 'mcp-correlation',
    observeTool: (event) => observations.push(event),
  })
  const client = new Client({ name: 'bounded-results', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    get,
    update,
    response,
    observations,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}
describe('bounded MCP results preserve action completion', () => {
  it('reads large contact notes with version-checked Unicode-safe continuation', async () => {
    const test = await connected()
    try {
      const first = await test.client.callTool({
        name: 'teamgrid_contact_get',
        arguments: { id: 'contact1', notesLimit: 3 },
      })
      expect(first.isError).not.toBe(true)
      const value = first.structuredContent as {
        data: { attributes: { notes: string } }
        meta: { notesPage: { nextOffset: number } }
      }
      expect(value.data.attributes.notes).toBe('😀')
      expect(value.meta.notesPage.nextOffset).toBe(2)
      const next = await test.client.callTool({
        name: 'teamgrid_contact_get',
        arguments: { id: 'contact1', notesOffset: 2, expectedRevision: etag },
      })
      expect(next.isError).not.toBe(true)
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(maximumToolResultBytes)
      const changed = await test.client.callTool({
        name: 'teamgrid_contact_get',
        arguments: { id: 'contact1', notesOffset: 2, expectedRevision: `"ct1-${'b'.repeat(64)}"` },
      })
      expect(changed.isError).toBe(true)
      expect(test.observations.at(-1)).toMatchObject({
        tool: 'teamgrid_contact_get',
        outcome: 'failed',
        isError: true,
        requestId: 'mcp-correlation',
      })
      expect(JSON.stringify(test.observations)).not.toContain('contact1')
      expect(JSON.stringify(test.observations)).not.toContain('😀')
    } finally {
      await test.close()
    }
  })
  it('reports a confirmed successful large write using one compact receipt', async () => {
    const test = await connected()
    try {
      const result = await test.client.callTool({
        name: 'teamgrid_contact_update',
        arguments: {
          workspaceId: 'workspace1',
          id: 'contact1',
          expectedRevision: etag,
          data: { firstName: 'New' },
        },
      })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        data: {
          type: 'mutationReceipt',
          attributes: {
            operation: 'updateContact',
            resources: [{ id: 'contact1', type: 'contact' }],
          },
        },
        meta: { outcome: 'completed', etag, omittedFields: ['resourceAttributes'] },
      })
      expect(test.update).toHaveBeenCalledOnce()
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(maximumToolResultBytes)
      expect(test.observations.at(-1)).toMatchObject({
        outcome: 'completed',
        isError: false,
        authChallenge: false,
      })
    } finally {
      await test.close()
    }
  })
  it('does not turn an invalid large upstream response into a success receipt', async () => {
    const test = await connected()
    try {
      test.response.data.type = 'workspace'
      const result = await test.client.callTool({
        name: 'teamgrid_contact_update',
        arguments: {
          workspaceId: 'workspace1',
          id: 'contact1',
          expectedRevision: etag,
          data: { firstName: 'New' },
        },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'invalid_api_response' },
        meta: { outcome: 'unknown' },
      })
      expect(test.observations.at(-1)).toMatchObject({ outcome: 'unknown', isError: true })
    } finally {
      await test.close()
    }
  })
  it('rejects a receipt returned by the upstream API rather than generated locally', async () => {
    const test = await connected()
    try {
      test.update.mockResolvedValueOnce({
        data: {
          type: 'mutationReceipt',
          attributes: {
            operation: 'updateContact',
            resources: [{ id: 'contact1', type: 'contact' }],
          },
        },
        meta: { requestId: 'test' },
      } as never)
      const result = await test.client.callTool({
        name: 'teamgrid_contact_update',
        arguments: {
          workspaceId: 'workspace1',
          id: 'contact1',
          expectedRevision: etag,
          data: { firstName: 'New' },
        },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'invalid_api_response' },
        meta: { outcome: 'unknown' },
      })
    } finally {
      await test.close()
    }
  })
  it('preserves accepted operations and partial bulk outcomes in compact receipts', () => {
    for (const [name, data, expected] of [
      [
        'teamgrid_tasks_bulk_update',
        [
          {
            id: 'task1',
            type: 'taskBulkUpdateResult',
            attributes: { status: 'updated', task: { notes: 'x'.repeat(maximumToolResultBytes) } },
          },
          {
            id: 'task2',
            type: 'taskBulkUpdateResult',
            attributes: { status: 'conflict', error: { code: 'precondition_failed' } },
          },
        ],
        { outcome: 'partial' },
      ],
      [
        'teamgrid_project_archive',
        {
          id: 'operation1',
          type: 'projectLifecycleOperation',
          attributes: { state: 'running', notes: 'x'.repeat(maximumToolResultBytes) },
        },
        {
          outcome: 'accepted',
          resume: {
            tool: 'teamgrid_project_lifecycle_operation_get',
            arguments: { id: 'operation1' },
          },
        },
      ],
    ] as const) {
      const result = boundToolResult(
        { content: [], structuredContent: { data, meta: { requestId: 'test' } } },
        name,
      )
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({
        data: { type: 'mutationReceipt' },
        meta: expected,
      })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(maximumToolResultBytes)
    }
  })
})
