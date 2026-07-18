import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createReadOnlyHandlers, createTeamGridMcpServer } from './server.js'

describe('TeamGrid read-only MCP adapter', () => {
  it('exposes only bounded reads from the shared API client', async () => {
    const list = vi.fn(async (input) => ({ data: [], meta: { input } }))
    const get = vi.fn(async (id) => ({ data: { id }, meta: {} }))
    const handlers = createReadOnlyHandlers({
      auditEvents: { list },
      contacts: { list },
      projects: { list },
      tasks: { get, list },
      timeEntries: { list },
      users: { list },
      webhooks: { list },
      workspace: { get: vi.fn(async () => ({ data: {}, meta: {} })) },
    } as never)

    await handlers.tasksList({ limit: 25, projectId: 'project-1' })
    await handlers.taskGet({ id: 'task-1' })
    expect(list).toHaveBeenCalledWith({ limit: 25, projectId: 'project-1' })
    expect(get).toHaveBeenCalledWith('task-1')
    expect(Object.keys(handlers).every((name) => /(?:Get|List)$/.test(name))).toBe(true)
    expect(JSON.stringify(Object.keys(handlers))).not.toMatch(/create|update|remove|archive/i)
  })

  it('negotiates MCP and advertises only read-only tools', async () => {
    const apiClient = {
      auditEvents: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      contacts: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      projects: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      tasks: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      timeEntries: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      users: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      webhooks: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      workspace: {
        get: vi.fn(async () => ({ data: { id: 'team-1', type: 'workspace' }, meta: {} })),
      },
    }
    const server = createTeamGridMcpServer(apiClient as never)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const packageManifest = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string }
      expect(client.getServerVersion()).toEqual({
        name: 'teamgrid',
        version: packageManifest.version,
      })
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'teamgrid_audit_events_list',
        'teamgrid_contacts_list',
        'teamgrid_projects_list',
        'teamgrid_task_get',
        'teamgrid_tasks_list',
        'teamgrid_time_entries_list',
        'teamgrid_users_list',
        'teamgrid_webhooks_list',
        'teamgrid_workspace_get',
      ])
      expect(tools.tools.map((tool) => tool.name).join(' ')).not.toMatch(
        /create|update|remove|archive/i,
      )
      const response = await client.callTool({
        arguments: {},
        name: 'teamgrid_workspace_get',
      })
      expect(JSON.stringify(response)).toContain('team-1')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
