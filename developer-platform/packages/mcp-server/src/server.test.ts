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
      callNotes: { get, list },
      contacts: { get, list },
      contactGroups: { get, list },
      customFieldDefinitions: { get, list },
      lists: { get, list },
      projects: { get, list },
      services: { get, list },
      tags: { get, list },
      tasks: { get, list },
      timeEntries: { get, list },
      users: { list },
      webhooks: { get, list },
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
      callNotes: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      contacts: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      contactGroups: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      customFieldDefinitions: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      lists: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      projects: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      products: {
        get: vi.fn(async (id) => ({
          data: {
            attributes: { name: 'Consulting', purchasePrice: 75, retailPrice: 140 },
            id,
            type: 'product',
          },
          meta: {},
        })),
        list: vi.fn(async () => ({
          data: [
            {
              attributes: { name: 'Consulting', purchasePrice: 75, retailPrice: 140 },
              id: 'product-1',
              type: 'product',
            },
          ],
          meta: {},
        })),
      },
      services: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      tags: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      tasks: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      timeEntries: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      users: { list: vi.fn(async () => ({ data: [], meta: {} })) },
      webhooks: {
        get: vi.fn(async (id) => ({ data: { id }, meta: {} })),
        list: vi.fn(async () => ({ data: [], meta: {} })),
      },
      workspace: {
        get: vi.fn(async () => ({ data: { id: 'team-1', type: 'workspace' }, meta: {} })),
      },
    }
    const server = createTeamGridMcpServer(apiClient as never, { toolProfile: 'all' })
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
        'teamgrid_call_note_get',
        'teamgrid_call_notes_list',
        'teamgrid_contact_get',
        'teamgrid_contact_group_get',
        'teamgrid_contact_groups_list',
        'teamgrid_contacts_list',
        'teamgrid_custom_field_definition_get',
        'teamgrid_custom_field_definitions_list',
        'teamgrid_list_get',
        'teamgrid_lists_list',
        'teamgrid_product_get',
        'teamgrid_product_group_get',
        'teamgrid_product_groups_list',
        'teamgrid_products_list',
        'teamgrid_project_get',
        'teamgrid_projects_list',
        'teamgrid_service_get',
        'teamgrid_services_list',
        'teamgrid_tag_get',
        'teamgrid_tags_list',
        'teamgrid_task_get',
        'teamgrid_tasks_list',
        'teamgrid_time_entries_list',
        'teamgrid_time_entry_get',
        'teamgrid_users_list',
        'teamgrid_webhook_get',
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
      expect(response.structuredContent).toMatchObject({ data: { id: 'team-1' } })
      const productResponse = await client.callTool({
        arguments: { id: 'product-1' },
        name: 'teamgrid_product_get',
      })
      expect(JSON.stringify(productResponse)).not.toContain('purchasePrice')
      expect(JSON.stringify(productResponse)).toContain('retailPrice')
      expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)
    } finally {
      await client.close()
      await server.close()
    }

    const coreServer = createTeamGridMcpServer(apiClient as never)
    const coreClient = new Client({ name: 'core-test-client', version: '1.0.0' })
    const [coreClientTransport, coreServerTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      coreServer.connect(coreServerTransport),
      coreClient.connect(coreClientTransport),
    ])
    try {
      const names = (await coreClient.listTools()).tools.map((tool) => tool.name)
      expect(names).toHaveLength(15)
      expect(names.join(' ')).not.toMatch(/audit|contact|users|webhook/)
      expect(names.join(' ')).not.toMatch(/service/)
    } finally {
      await coreClient.close()
      await coreServer.close()
    }
  })
})
