import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TeamGridClient } from '@teamgrid/api-client'
import { z } from 'zod'
import { type McpToolProfile, toolsByProfile } from './toolProfiles.js'

const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version
const maxToolResultBytes = 256 * 1024
const readOnlyAnnotations = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
})

const listInput = {
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}
const searchResourceTypes = ['contacts', 'projects', 'tasks'] as const
const searchInput = z
  .object({
    limit: z.number().int().min(1).max(50).default(25),
    term: z
      .string()
      .trim()
      .min(2)
      .max(160)
      .refine(
        (term) =>
          Array.from(term).every((character) => {
            const codePoint = character.codePointAt(0)
            return codePoint !== undefined && codePoint > 31 && (codePoint < 127 || codePoint > 159)
          }),
        { message: 'Search terms cannot contain control characters.' },
      ),
    types: z
      .array(z.enum(searchResourceTypes))
      .min(1)
      .max(searchResourceTypes.length)
      .refine((types) => new Set(types).size === types.length, {
        message: 'Search resource types must be unique.',
      }),
  })
  .strict()

function toolResult(value: unknown) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, 'utf8') > maxToolResultBytes) {
    const error = {
      error: {
        code: 'result_too_large',
        detail: 'The TeamGrid result exceeds the MCP context safety limit. Use a smaller page.',
      },
    }
    return {
      content: [{ text: JSON.stringify(error), type: 'text' as const }],
      isError: true,
      structuredContent: error,
    }
  }
  const structuredContent: Record<string, unknown> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value }
  return {
    content: [{ text, type: 'text' as const }],
    structuredContent,
  }
}

function withoutProductPurchasePrices<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const envelope = value as Record<string, unknown>
  const redact = (item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const resource = item as Record<string, unknown>
    if (!resource.attributes || typeof resource.attributes !== 'object') return item
    const { purchasePrice: _purchasePrice, ...attributes } = resource.attributes as Record<
      string,
      unknown
    >
    return { ...resource, attributes }
  }
  return {
    ...envelope,
    data: Array.isArray(envelope.data) ? envelope.data.map(redact) : redact(envelope.data),
  } as T
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
    callNoteGet: (input: { id: string }) => client.callNotes.get(input.id),
    callNotesList: (input: { archived?: boolean; cursor?: string; limit?: number }) =>
      client.callNotes.list(input),
    contactsList: (input: {
      archived?: boolean
      cursor?: string
      limit?: number
      type?: 'company' | 'person'
    }) => client.contacts.list(input),
    contactGet: (input: { id: string }) => client.contacts.get(input.id),
    contactGroupGet: (input: { id: string }) => client.contactGroups.get(input.id),
    contactGroupsList: (input: { archived?: boolean; cursor?: string; limit?: number }) =>
      client.contactGroups.list(input),
    customFieldDefinitionGet: (input: { id: string }) =>
      client.customFieldDefinitions.get(input.id),
    customFieldDefinitionsList: (input: {
      archived?: boolean
      cursor?: string
      defaultEnabled?: boolean
      fieldType?:
        | 'contact'
        | 'date'
        | 'dropdown'
        | 'number'
        | 'project'
        | 'switcher'
        | 'tag'
        | 'text'
        | 'textarea'
        | 'user'
      limit?: number
      targetType?: 'contact' | 'project' | 'projectJournalEntry' | 'task'
    }) => client.customFieldDefinitions.list(input),
    listGet: (input: { id: string }) => client.lists.get(input.id),
    listsList: (input: {
      archived?: boolean
      cursor?: string
      limit?: number
      parentId?: string
      type?: 'personal' | 'projects' | 'tasks'
    }) => client.lists.list(input),
    productGet: async (input: { id: string }) =>
      withoutProductPurchasePrices(await client.products.get(input.id)),
    productGroupGet: (input: { id: string }) => client.productGroups.get(input.id),
    productGroupsList: (input: {
      archived?: boolean
      cursor?: string
      limit?: number
      parentId?: string
    }) => client.productGroups.list(input),
    productsList: async (input: {
      archived?: boolean
      cursor?: string
      disabled?: boolean
      limit?: number
      productGroupId?: string
    }) => withoutProductPurchasePrices(await client.products.list(input)),
    searchQuery: (input: {
      limit?: number
      term: string
      types: readonly (typeof searchResourceTypes)[number][]
    }) => client.search.query(input),
    projectGet: (input: { id: string }) => client.projects.get(input.id),
    projectsList: (input: {
      archived?: boolean
      completed?: boolean
      cursor?: string
      limit?: number
    }) => client.projects.list(input),
    servicesList: (input: { archived?: boolean; cursor?: string; limit?: number }) =>
      client.services.list(input),
    serviceGet: (input: { id: string }) => client.services.get(input.id),
    tagsList: (input: { archived?: boolean; cursor?: string; limit?: number }) =>
      client.tags.list(input),
    tagGet: (input: { id: string }) => client.tags.get(input.id),
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
    timeEntryGet: (input: { id: string }) => client.timeEntries.get(input.id),
    usersList: (input: { cursor?: string; limit?: number }) => client.users.list(input),
    webhooksList: (input: { cursor?: string; limit?: number }) => client.webhooks.list(input),
    webhookGet: (input: { id: string }) => client.webhooks.get(input.id),
    workspaceGet: () => client.workspace.get(),
  })
}

export function createTeamGridMcpServer(
  client: TeamGridClient,
  { toolProfile = 'core' }: { toolProfile?: McpToolProfile } = {},
) {
  const server = new McpServer(
    { name: 'teamgrid', version: packageVersion },
    {
      instructions:
        'Read-only TeamGrid access. Results are tenant-scoped by the API credential and paginated; pass returned opaque cursors to continue.',
    },
  )
  const handlers = createReadOnlyHandlers(client)
  const enabledTools = new Set(toolsByProfile[toolProfile])
  const registerTool: McpServer['registerTool'] = (name, config, callback) => {
    const registration = server.registerTool(name, config, callback)
    if (!enabledTools.has(name)) registration.disable()
    return registration
  }

  registerTool(
    'teamgrid_workspace_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get the authenticated TeamGrid workspace and its region/cell metadata.',
      inputSchema: z.object({}).strict(),
    },
    async () => toolResult(await handlers.workspaceGet()),
  )
  registerTool(
    'teamgrid_search',
    {
      annotations: readOnlyAnnotations,
      description:
        'Search authorized TeamGrid contacts, projects, and tasks. Returns at most 50 curated metadata-only results; contact matches can contain personal data.',
      inputSchema: searchInput,
    },
    async (input) => toolResult(await handlers.searchQuery(input)),
  )
  registerTool(
    'teamgrid_projects_list',
    {
      annotations: readOnlyAnnotations,
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
  registerTool(
    'teamgrid_project_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid project by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.projectGet(input)),
  )
  registerTool(
    'teamgrid_products_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid products without exposing purchase prices.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          disabled: z.boolean().optional(),
          productGroupId: z.string().max(128).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.productsList(input)),
  )
  registerTool(
    'teamgrid_product_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid product without exposing its purchase price.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.productGet(input)),
  )
  registerTool(
    'teamgrid_product_groups_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid product groups with stable cursor pagination.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          parentId: z.string().max(128).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.productGroupsList(input)),
  )
  registerTool(
    'teamgrid_product_group_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid product group by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.productGroupGet(input)),
  )
  registerTool(
    'teamgrid_tasks_list',
    {
      annotations: readOnlyAnnotations,
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
  registerTool(
    'teamgrid_task_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid task by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.taskGet(input)),
  )
  registerTool(
    'teamgrid_time_entries_list',
    {
      annotations: readOnlyAnnotations,
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
  registerTool(
    'teamgrid_time_entry_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid time entry by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.timeEntryGet(input)),
  )
  registerTool(
    'teamgrid_call_notes_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid call notes. Results can contain sensitive conversation data.',
      inputSchema: z.object({ ...listInput, archived: z.boolean().optional() }).strict(),
    },
    async (input) => toolResult(await handlers.callNotesList(input)),
  )
  registerTool(
    'teamgrid_call_note_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid call note. The result can contain conversation data.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.callNoteGet(input)),
  )
  registerTool(
    'teamgrid_contacts_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid contacts. Results can contain personal data.',
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
  registerTool(
    'teamgrid_contact_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid contact by id. The result can contain personal data.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.contactGet(input)),
  )
  registerTool(
    'teamgrid_contact_groups_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid contact groups with stable cursor pagination.',
      inputSchema: z.object({ ...listInput, archived: z.boolean().optional() }).strict(),
    },
    async (input) => toolResult(await handlers.contactGroupsList(input)),
  )
  registerTool(
    'teamgrid_contact_group_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid contact group by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.contactGroupGet(input)),
  )
  registerTool(
    'teamgrid_users_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List users in the authenticated TeamGrid workspace.',
      inputSchema: z.object(listInput).strict(),
    },
    async (input) => toolResult(await handlers.usersList(input)),
  )
  registerTool(
    'teamgrid_custom_field_definitions_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List canonical TeamGrid custom-field definitions without exposing defaults.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          defaultEnabled: z.boolean().optional(),
          fieldType: z
            .enum([
              'contact',
              'date',
              'dropdown',
              'number',
              'project',
              'switcher',
              'tag',
              'text',
              'textarea',
              'user',
            ])
            .optional(),
          targetType: z.enum(['contact', 'project', 'projectJournalEntry', 'task']).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.customFieldDefinitionsList(input)),
  )
  registerTool(
    'teamgrid_custom_field_definition_get',
    {
      annotations: readOnlyAnnotations,
      description:
        'Get one canonical TeamGrid custom-field definition without exposing legacy defaults.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.customFieldDefinitionGet(input)),
  )
  registerTool(
    'teamgrid_lists_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid task lists.',
      inputSchema: z
        .object({
          ...listInput,
          archived: z.boolean().optional(),
          parentId: z.string().max(128).optional(),
          type: z.enum(['tasks', 'projects', 'personal']).optional(),
        })
        .strict(),
    },
    async (input) => toolResult(await handlers.listsList(input)),
  )
  registerTool(
    'teamgrid_list_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid list by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.listGet(input)),
  )
  registerTool(
    'teamgrid_services_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid services.',
      inputSchema: z.object({ ...listInput, archived: z.boolean().optional() }).strict(),
    },
    async (input) => toolResult(await handlers.servicesList(input)),
  )
  registerTool(
    'teamgrid_service_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid service and its potentially sensitive billing rate.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.serviceGet(input)),
  )
  registerTool(
    'teamgrid_tags_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List TeamGrid tags.',
      inputSchema: z.object({ ...listInput, archived: z.boolean().optional() }).strict(),
    },
    async (input) => toolResult(await handlers.tagsList(input)),
  )
  registerTool(
    'teamgrid_tag_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid tag by id.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.tagGet(input)),
  )
  registerTool(
    'teamgrid_webhooks_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List configured TeamGrid webhooks without modifying them.',
      inputSchema: z.object(listInput).strict(),
    },
    async (input) => toolResult(await handlers.webhooksList(input)),
  )
  registerTool(
    'teamgrid_webhook_get',
    {
      annotations: readOnlyAnnotations,
      description: 'Get one TeamGrid webhook without exposing its signing secret.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }).strict(),
    },
    async (input) => toolResult(await handlers.webhookGet(input)),
  )
  registerTool(
    'teamgrid_audit_events_list',
    {
      annotations: readOnlyAnnotations,
      description: 'List sensitive Developer Platform audit events for security review.',
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
