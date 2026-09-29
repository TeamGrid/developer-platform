import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { TeamGridApiError } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { createTeamGridMcpServer } from './server.js'
import { enabledMcpTools, type McpToolProfile } from './toolProfiles.js'
import { workWriteTools } from './workTools.js'

const revision = `tsk1-${'a'.repeat(64)}`
function fixture(workspaceId = 'workspace-1') {
  const resource = async () => ({ data: { id: 'task-1' }, meta: {} })
  return {
    comments: { create: vi.fn(resource), list: vi.fn(resource) },
    appointments: { list: vi.fn(resource) },
    customFieldValues: { get: vi.fn(resource) },
    projects: { update: vi.fn(resource) },
    tasks: {
      create: vi.fn(resource),
      update: vi.fn(resource),
      move: vi.fn(resource),
      complete: vi.fn(resource),
      reopen: vi.fn(resource),
      get: vi.fn(resource),
    },
    workspace: { get: vi.fn(async () => ({ data: { id: workspaceId }, meta: {} })) },
  }
}
async function connected(api = fixture(), toolProfile: McpToolProfile = 'work') {
  const server = createTeamGridMcpServer(api as never, { toolProfile })
  const client = new Client({ name: 'work-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, api, close: () => Promise.all([client.close(), server.close()]) }
}

describe('explicit MCP work profile', () => {
  it.each([
    ['core', 22],
    ['collaboration', 29],
    ['governance', 28],
    ['all', 36],
    ['context', 34],
  ] as const)('keeps %s read-only with %s tools', async (profile, count) => {
    const connection = await connected(fixture(), profile)
    try {
      const { tools } = await connection.client.listTools()
      expect(tools).toHaveLength(count)
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)
      expect(() => enabledMcpTools(profile, { allowTools: ['teamgrid_task_create'] })).toThrow(
        'outside',
      )
      await expect(
        connection.client.callTool({ name: 'teamgrid_task_create', arguments: {} }),
      ).rejects.toThrow('disabled')
      expect(connection.api.tasks.create).not.toHaveBeenCalled()
    } finally {
      await connection.close()
    }
  })

  it('advertises exactly the approved writes only in work, with accurate annotations', async () => {
    const connection = await connected()
    try {
      const { tools } = await connection.client.listTools()
      expect(tools).toHaveLength(41)
      expect(
        tools
          .filter((tool) => !tool.annotations?.readOnlyHint)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual([...workWriteTools].sort())
      expect(
        tools.find((tool) => tool.name === 'teamgrid_comment_create')?.annotations,
      ).toMatchObject({ destructiveHint: false, idempotentHint: true })
      expect(tools.find((tool) => tool.name === 'teamgrid_task_update')?.annotations).toMatchObject(
        { destructiveHint: true, idempotentHint: true },
      )
    } finally {
      await connection.close()
    }
  })

  it('checks the workspace before every mutation and does not send a mismatched action', async () => {
    const connection = await connected()
    try {
      const result = await connection.client.callTool({
        name: 'teamgrid_task_create',
        arguments: {
          workspaceId: 'another-workspace',
          idempotencyKey: 'intent-1',
          data: { name: 'Task' },
        },
      })
      expect(result.structuredContent).toMatchObject({ error: { code: 'workspace_mismatch' } })
      expect(connection.api.tasks.create).not.toHaveBeenCalled()
    } finally {
      await connection.close()
    }
  })

  it.each([
    ['teamgrid_task_create', { workspaceId: 'workspace-1', data: { name: 'Task' } }],
    ['teamgrid_task_update', { workspaceId: 'workspace-1', id: 'task-1', data: { name: 'Task' } }],
    [
      'teamgrid_task_update',
      { workspaceId: 'workspace-1', id: 'task-1', expectedRevision: revision, data: {} },
    ],
    [
      'teamgrid_task_create',
      {
        workspaceId: 'workspace-1',
        idempotencyKey: 'intent',
        data: { name: 'Task', assigneeIds: ['a'], primaryAssigneeId: 'b' },
      },
    ],
    [
      'teamgrid_task_create',
      {
        workspaceId: 'workspace-1',
        idempotencyKey: 'intent',
        data: { name: 'Task', assigneeIds: ['a'], groupId: 'g' },
      },
    ],
    [
      'teamgrid_task_create',
      {
        workspaceId: 'workspace-1',
        idempotencyKey: 'intent',
        data: { name: 'Task', billable: true },
      },
    ],
  ])('rejects invalid %s before reading credentials or calling the API', async (name, args) => {
    const connection = await connected()
    try {
      expect((await connection.client.callTool({ name, arguments: args })).isError).toBe(true)
      expect(connection.api.workspace.get).not.toHaveBeenCalled()
      expect(connection.api.tasks.create).not.toHaveBeenCalled()
      expect(connection.api.tasks.update).not.toHaveBeenCalled()
    } finally {
      await connection.close()
    }
  })

  it('forwards a stable creation key across repeated calls', async () => {
    const connection = await connected()
    try {
      const args = {
        workspaceId: 'workspace-1',
        idempotencyKey: 'intent-1',
        data: { name: 'Task' },
      }
      for (let index = 0; index < 2; index++) {
        expect(
          (await connection.client.callTool({ name: 'teamgrid_task_create', arguments: args }))
            .isError,
        ).not.toBe(true)
      }
      expect(connection.api.tasks.create.mock.calls).toEqual([
        [args.data, { idempotencyKey: 'intent-1' }],
        [args.data, { idempotencyKey: 'intent-1' }],
      ])
      expect(connection.api.workspace.get).toHaveBeenCalledTimes(2)
    } finally {
      await connection.close()
    }
  })

  it.each([
    [403, 'insufficient_scope'],
    [409, 'workspace_locked'],
    [412, 'revision_conflict'],
  ])('preserves %s and never fetches a replacement revision or retries', async (status, code) => {
    const api = fixture()
    api.tasks.update.mockRejectedValue(
      new TeamGridApiError({
        status: Number(status),
        errors: [
          {
            code: String(code),
            detail: 'Action refused.',
            status: String(status),
            title: 'Action refused',
          },
        ],
        requestId: 'request-1',
      }),
    )
    const connection = await connected(api)
    try {
      const result = await connection.client.callTool({
        name: 'teamgrid_task_update',
        arguments: {
          workspaceId: 'workspace-1',
          id: 'task-1',
          expectedRevision: revision,
          data: { name: 'Task' },
        },
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code, status, requestId: 'request-1' },
      })
      expect(api.tasks.update).toHaveBeenCalledExactlyOnceWith(
        'task-1',
        { name: 'Task' },
        { ifMatch: revision },
      )
      expect(api.tasks.get).not.toHaveBeenCalled()
    } finally {
      await connection.close()
    }
  })

  it('keeps concurrently connected workspaces isolated', async () => {
    const a = await connected(fixture('workspace-a'))
    const b = await connected(fixture('workspace-b'))
    try {
      await Promise.all(
        [a, b].map((connection, index) =>
          connection.client.callTool({
            name: 'teamgrid_task_complete',
            arguments: {
              workspaceId: `workspace-${index === 0 ? 'a' : 'b'}`,
              id: `task-${index}`,
              expectedRevision: revision,
            },
          }),
        ),
      )
      expect(a.api.tasks.complete).toHaveBeenCalledExactlyOnceWith('task-0', { ifMatch: revision })
      expect(b.api.tasks.complete).toHaveBeenCalledExactlyOnceWith('task-1', { ifMatch: revision })
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })

  it('bounds calendar reads and uses the API custom-field discriminator', async () => {
    const connection = await connected()
    try {
      expect(
        (
          await connection.client.callTool({
            name: 'teamgrid_appointments_list',
            arguments: { start: '2026-01-01T00:00:00Z', end: '2026-03-01T00:00:00Z' },
          })
        ).isError,
      ).toBe(true)
      expect(connection.api.appointments.list).not.toHaveBeenCalled()
      await connection.client.callTool({
        name: 'teamgrid_custom_field_value_get',
        arguments: {
          targetType: 'project-journal-entry',
          resourceId: 'entry-1',
          fieldId: 'field-1',
        },
      })
      expect(connection.api.customFieldValues.get).toHaveBeenCalledExactlyOnceWith(
        'project-journal-entry',
        'entry-1',
        'field-1',
      )
    } finally {
      await connection.close()
    }
  })
})
