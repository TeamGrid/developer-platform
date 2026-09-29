import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { TeamGridClientError } from '@teamgrid/api-client'
import { describe, expect, it } from 'vitest'
import { responseFixture } from './fixtures.testSupport.js'
import { operationOutcome } from './outcomes.js'
import { createTeamGridMcpServer } from './server.js'

describe('MCP action outcomes', () => {
  it('does not equate accepted export work or mixed bulk results with completion', () => {
    expect(
      operationOutcome({ type: 'export', id: 'export1', attributes: { replayed: true } }, true),
    ).toEqual({
      outcome: 'accepted',
      resume: { tool: 'teamgrid_export_get', arguments: { id: 'export1' } },
    })
    expect(
      operationOutcome(
        { type: 'projectLifecycleOperation', id: 'op1', attributes: { state: 'failed' } },
        false,
      ),
    ).toMatchObject({ outcome: 'failed', resume: { arguments: { id: 'op1' } } })
    const item = (status: string) => ({ type: 'taskBulkUpdateResult', attributes: { status } })
    expect(operationOutcome([item('updated'), item('conflict')], true)).toEqual({
      outcome: 'partial',
    })
    expect(operationOutcome([item('unavailable')], true)).toEqual({ outcome: 'unknown' })
  })
  it.each(['lost-response', 'malformed-response'])(
    'reports uncertain completion and never retries a mutation after %s',
    async (mode) => {
      let writes = 0
      const server = createTeamGridMcpServer(
        {
          workspace: { get: async () => responseFixture('getWorkspace', 'workspace1') },
          documents: {
            create: async () => {
              writes += 1
              if (mode === 'lost-response')
                throw new TeamGridClientError('request_timeout', 'Response lost.')
              return {
                data: { id: 'doc1', privateInternalField: 'private-canary' },
                meta: { requestId: 'r1' },
              }
            },
          },
        } as never,
        { toolProfile: 'full' },
      )
      const client = new Client({ name: 'outcome-test', version: '1.0.0' })
      const [a, b] = InMemoryTransport.createLinkedPair()
      try {
        await Promise.all([server.connect(a), client.connect(b)])
        const result = await client.callTool({
          name: 'teamgrid_document_create',
          arguments: {
            workspaceId: 'workspace1',
            idempotencyKey: 'stable-intent',
            data: { name: 'Test', content: 'Test' },
          },
        })
        expect(result.isError).toBe(true)
        expect(result.structuredContent).toMatchObject({ meta: { outcome: 'unknown' } })
        expect(JSON.stringify(result)).not.toContain('private-canary')
        expect(writes).toBe(1)
      } finally {
        await client.close()
        await server.close()
      }
    },
  )
})
