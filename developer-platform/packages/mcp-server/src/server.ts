import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TeamGridClient } from '@teamgrid/api-client'
import { z } from 'zod'

const listInput = {
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}

function toolResult(value: unknown) {
  return {
    content: [{ text: JSON.stringify(value), type: 'text' as const }],
  }
}

export function createReadOnlyHandlers(client: TeamGridClient) {
  return Object.freeze({
    auditEventsList: (input: {
      credentialId?: string
      cursor?: string
      eventType?: string
      limit?: number
      outcome?: 'denied' | 'failure' | 'success'
    }) => client.auditEvents.list(input),
    contactsList: (input: {
      archived?: boolean
      cursor?: string
      limit?: number
      type?: 'company' | 'person'
    }) => client.contacts.list(input),
    projectsList: (input: {
      archived?: boolean
      completed?: boolean
      cursor?: string
      limit?: number
    }) => client.projects.list(input),
    taskGet: (input: { id: string }) => client.tasks.get(input.id),
    tasksList: (input: {
      archived?: boolean
      assigneeId?: string
      completed?: boolean
      cursor?: string
      limit?: number
      projectId?: string
    }) => client.tasks.list(input),
    timeEntriesList: (input: {
      archived?: boolean
      cursor?: string
      from?: string
      limit?: number
      taskId?: string
      to?: string
      userId?: string
    }) => client.timeEntries.list(input),
    usersList: (input: { cursor?: string; limit?: number }) => client.users.list(input),
    webhooksList: (input: { cursor?: string; limit?: number }) => client.webhooks.list(input),
    workspaceGet: () => client.workspace.get(),
  })
}

export function createTeamGridMcpServer(client: TeamGridClient) {
  const server = new McpServer(
    { name: 'teamgrid', version: '1.0.0-alpha.1' },
    {
      instructions:
        'Read-only TeamGrid access. Results are tenant-scoped by the API credential and paginated; pass returned opaque cursors to continue.',
    },
  )
  const handlers = createReadOnlyHandlers(client)

  server.registerTool(
    'teamgrid_workspace_get',
    {
      description: 'Get the authenticated TeamGrid workspace and its region/cell metadata.',
      inputSchema: z.object({}).strict(),
    },
    async () => toolResult(await handlers.workspaceGet()),
  )
  server.registerTool(
    'teamgrid_projects_list',
    {
      description: 'List TeamGrid projects with stable cursor pagination.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          completed: z.boolean().optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.projectsList(input)),
  )
  server.registerTool(
    'teamgrid_tasks_list',
    {
      description: 'List TeamGrid tasks with optional project, assignee, and status filters.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          assigneeId: z.string().max(128).optional(),
          completed: z.boolean().optional(),
          projectId: z.string().max(128).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.tasksList(input)),
  )
  server.registerTool(
    'teamgrid_task_get',
    {
      description: 'Get one TeamGrid task by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.taskGet(input)),
  )
  server.registerTool(
    'teamgrid_time_entries_list',
    {
      description: 'List TeamGrid time entries with stable cursor pagination.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          from: z.string().optional(),
          taskId: z.string().max(128).optional(),
          to: z.string().optional(),
          userId: z.string().max(128).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.timeEntriesList(input)),
  )
  server.registerTool(
    'teamgrid_contacts_list',
    {
      description: 'List TeamGrid contacts.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          type: z.enum(['person', 'company']).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.contactsList(input)),
  )
  server.registerTool(
    'teamgrid_users_list',
    {
      description: 'List users in the authenticated TeamGrid workspace.',
      inputSchema: z.object(listInput).strict(),
    },
    async (input) => toolResult(await handlers.usersList(input)),
  )
  server.registerTool(
    'teamgrid_webhooks_list',
    {
      description: 'List configured TeamGrid webhooks without modifying them.',
      inputSchema: z.object(listInput).strict(),
    },
    async (input) => toolResult(await handlers.webhooksList(input)),
  )
  server.registerTool(
    'teamgrid_audit_events_list',
    {
      description: 'List Developer Platform audit events.',
      inputSchema: z
        .object({
          ...listInput,
          credentialId: z.string().max(128).optional(),
          eventType: z.string().max(128).optional(),
          outcome: z.enum(['success', 'denied', 'failure']).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.auditEventsList(input)),
  )
  return server
}
