import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { TeamGridApiError, type TeamGridClient } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { domainCatalog, domainInputSchema, domainToolNames } from './domainTools.js'
import { createTeamGridMcpServer } from './server.js'
import { describeMcpAccess } from './setup.js'

const revision = (prefix: string) => `"${prefix}-${'a'.repeat(64)}"`
const workspaceId = 'workspace-a'
const envelope = { data: { id: 'result', type: 'test', attributes: {} }, meta: {} }
async function connected() {
  const calls = new Map<string, ReturnType<typeof vi.fn>>()
  const api = new Proxy(
    {},
    {
      get: (_, group: string) =>
        new Proxy(
          {},
          {
            get: (_, method: string) => {
              const key = `${group}.${method}`
              if (!calls.has(key))
                calls.set(
                  key,
                  vi
                    .fn()
                    .mockResolvedValue(
                      key === 'workspace.get' ? { data: { id: workspaceId }, meta: {} } : envelope,
                    ),
                )
              return calls.get(key)
            },
          },
        ),
    },
  ) as TeamGridClient
  const server = createTeamGridMcpServer(api, { toolProfile: 'full' })
  const client = new Client({ name: 'domain-contract-test', version: '1.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return {
    client,
    calls,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

describe('complete domain MCP', () => {
  it.each([
    [
      'teamgrid_task_create',
      {
        workspaceId,
        idempotencyKey: 'create-1',
        data: { name: 'Task', descriptionFormat: 'markdown-v1' },
      },
    ],
    [
      'teamgrid_task_update',
      {
        workspaceId,
        id: 't1',
        expectedRevision: revision('tsk1'),
        data: { descriptionFormat: 'markdown-v1' },
      },
    ],
    [
      'teamgrid_tasks_bulk_update',
      {
        workspaceId,
        data: {
          items: [
            { id: 't1', revision: 'a'.repeat(64), data: { descriptionFormat: 'markdown-v1' } },
          ],
        },
      },
    ],
  ] as const)(
    'enforces field dependencies in the actual %s MCP request',
    async (name, arguments_) => {
      const c = await connected()
      try {
        const result = await c.client.callTool({ name, arguments: arguments_ })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain('dependentRequired')
        expect(c.calls.size).toBe(0)
      } finally {
        await c.close()
      }
    },
  )
  it('advertises every reviewed tool with executable strict schemas and truthful mutation metadata', async () => {
    const c = await connected()
    try {
      const { tools } = await c.client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual([...domainToolNames].sort())
      for (const tool of tools) {
        const entry = domainCatalog[tool.name as keyof typeof domainCatalog]
        expect(tool.inputSchema.additionalProperties).toBe(false)
        expect(tool.annotations?.readOnlyHint).toBe(!entry.write)
        if (entry.write) expect(tool.inputSchema.required).toContain('workspaceId')
        if (entry.idempotency) expect(tool.inputSchema.required).toContain('idempotencyKey')
      }
      expect(
        tools.some((t) =>
          /credential|personal_access_token|download_intent|upload_intent|secret_rotate/.test(
            t.name,
          ),
        ),
      ).toBe(false)
    } finally {
      await c.close()
    }
  })

  it('reads a large document completely in revision-bound chunks and returns a compact write receipt', async () => {
    const c = await connected()
    try {
      await c.client.callTool({ name: 'teamgrid_document_get', arguments: { id: 'doc1' } })
      const content = 'Hello 🦊\n'.repeat(40000)
      const response = {
        data: { id: 'doc1', type: 'document', attributes: { name: 'Large', content } },
        meta: { requestId: 'document-read' },
        transport: { headers: { etag: '"doc1-version-1"' } },
      }
      c.calls.get('documents.get')?.mockResolvedValue(response)
      let offset = 0
      let reconstructed = ''
      do {
        const result = await c.client.callTool({
          name: 'teamgrid_document_get',
          arguments: {
            id: 'doc1',
            contentOffset: offset,
            ...(offset ? { expectedRevision: '"doc1-version-1"' } : {}),
          },
        })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        const value = result.structuredContent as typeof response & {
          meta: { contentPage: { nextOffset: number | null } }
        }
        reconstructed += value.data.attributes.content
        offset = value.meta.contentPage.nextOffset ?? 0
      } while (offset)
      expect(reconstructed).toBe(content)
      c.calls
        .get('documents.get')
        ?.mockResolvedValue({ ...response, transport: { headers: { etag: '"doc1-version-2"' } } })
      const changed = await c.client.callTool({
        name: 'teamgrid_document_get',
        arguments: {
          id: 'doc1',
          contentOffset: 100,
          expectedRevision: '"doc1-version-1"',
        },
      })
      expect(changed.structuredContent).toMatchObject({ error: { code: 'revision_conflict' } })
      await c.client.callTool({
        name: 'teamgrid_document_update',
        arguments: {
          workspaceId,
          id: 'doc1',
          expectedRevision: '"doc1-version-1"',
          data: { name: 'Renamed' },
        },
      })
      c.calls.get('documents.update')?.mockResolvedValue(response)
      const updated = await c.client.callTool({
        name: 'teamgrid_document_update',
        arguments: {
          workspaceId,
          id: 'doc1',
          expectedRevision: '"doc1-version-1"',
          data: { name: 'Renamed' },
        },
      })
      expect(updated.isError).not.toBe(true)
      expect(updated.structuredContent).toMatchObject({
        data: { id: 'doc1' },
        meta: { outcome: 'completed', etag: '"doc1-version-1"' },
      })
      expect(JSON.stringify(updated)).not.toContain('Hello')
    } finally {
      await c.close()
    }
  })

  it.each([
    [
      'teamgrid_document_create',
      { data: { name: 'Note', content: 'Hello' }, idempotencyKey: 'document-intent' },
      'documents.create',
      [{ name: 'Note', content: 'Hello' }, { idempotencyKey: 'document-intent' }],
    ],
    [
      'teamgrid_document_update',
      { id: 'd1', data: { content: 'Changed' }, expectedRevision: revision('doc1') },
      'documents.update',
      ['d1', { content: 'Changed' }, { ifMatch: revision('doc1') }],
    ],
    [
      'teamgrid_file_rename',
      { id: 'f1', data: { name: 'renamed.pdf' }, expectedRevision: '"file-1"' },
      'files.rename',
      ['f1', { name: 'renamed.pdf' }, { ifMatch: '"file-1"' }],
    ],
    [
      'teamgrid_contact_create',
      {
        data: { type: 'person', firstName: 'Test', lastName: 'Person' },
        idempotencyKey: 'contact-intent',
      },
      'contacts.create',
      [
        { type: 'person', firstName: 'Test', lastName: 'Person' },
        { idempotencyKey: 'contact-intent' },
      ],
    ],
    [
      'teamgrid_tag_create',
      { data: { name: 'Test' }, idempotencyKey: 'tag-intent' },
      'tags.create',
      [{ name: 'Test' }, { idempotencyKey: 'tag-intent' }],
    ],
    [
      'teamgrid_time_entry_create',
      {
        data: {
          taskId: 'task1',
          userId: 'user1',
          startAt: '2026-09-29T08:00:00Z',
          endAt: '2026-09-29T09:00:00Z',
        },
        idempotencyKey: 'time-intent',
      },
      'timeEntries.create',
      [
        {
          taskId: 'task1',
          userId: 'user1',
          startAt: '2026-09-29T08:00:00Z',
          endAt: '2026-09-29T09:00:00Z',
        },
        { idempotencyKey: 'time-intent' },
      ],
    ],
    [
      'teamgrid_task_timer_start',
      { id: 'task1', data: { userId: 'user1' } },
      'tasks.startTimer',
      ['task1', { userId: 'user1' }, {}],
    ],
    [
      'teamgrid_task_recurrence_pause',
      { id: 'series1', expectedRevision: revision('tr1') },
      'taskRecurrences.pause',
      ['series1', { ifMatch: revision('tr1') }],
    ],
    [
      'teamgrid_custom_field_value_set',
      {
        targetType: 'task',
        resourceId: 'task1',
        fieldId: 'field1',
        expectedRevision: revision('cfv1'),
        data: { value: 'Blue' },
      },
      'customFieldValues.set',
      ['task', 'task1', 'field1', { value: 'Blue' }, { ifMatch: revision('cfv1') }],
    ],
  ] as const)(
    'dispatches %s with exact SDK arguments and stable retry data',
    async (name, args, sdk, expected) => {
      const c = await connected()
      try {
        for (let i = 0; i < 2; i++) {
          const result = await c.client.callTool({ name, arguments: { workspaceId, ...args } })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
        }
        expect(c.calls.get(sdk)?.mock.calls).toEqual([expected, expected])
      } finally {
        await c.close()
      }
    },
  )

  it('blocks wrong workspace and unknown transport fields before a mutation', async () => {
    const c = await connected()
    try {
      for (const args of [
        { workspaceId: 'wrong', idempotencyKey: 'i1', data: { name: 'Note' } },
        {
          workspaceId,
          idempotencyKey: 'i1',
          data: { name: 'Note' },
          headers: { authorization: 'not-allowed' },
        },
        { workspaceId, idempotencyKey: 'i1', data: { name: 'Note', teamId: 'wrong' } },
      ])
        expect(
          (await c.client.callTool({ name: 'teamgrid_document_create', arguments: args })).isError,
        ).toBe(true)
      expect(c.calls.get('documents.create')).toBeUndefined()
    } finally {
      await c.close()
    }
  })

  it('refuses core and bulk mutations before dispatch when the API lacks strict-CAS acknowledgement', async () => {
    const c = await connected()
    try {
      const result = await c.client.callTool({
        name: 'teamgrid_task_update',
        arguments: {
          workspaceId,
          id: 'task1',
          data: { name: 'Reviewed change' },
          expectedRevision: revision('tsk1'),
        },
      })
      expect(result.structuredContent).toMatchObject({ error: { code: 'resource_cas_required' } })
      expect(c.calls.get('tasks.update')).toBeUndefined()
      expect(domainCatalog.teamgrid_tasks_bulk_update.coreCas).toBe(true)
    } finally {
      await c.close()
    }
  })

  it('dispatches a core mutation with the caller revision after strict-CAS acknowledgement', async () => {
    const c = await connected()
    try {
      await c.client.callTool({ name: 'teamgrid_workspace_get', arguments: {} })
      const get = c.calls.get('workspace.get')
      if (!get) throw new Error('Missing workspace dispatch')
      get.mockResolvedValue({
        data: { id: workspaceId },
        meta: {},
        transport: { headers: { 'x-teamgrid-resource-cas': 'required-v1' } },
      })
      const result = await c.client.callTool({
        name: 'teamgrid_task_update',
        arguments: {
          workspaceId,
          id: 'task1',
          expectedRevision: revision('tsk1'),
          data: { name: 'Reviewed change' },
        },
      })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(c.calls.get('tasks.update')?.mock.calls).toEqual([
        ['task1', { name: 'Reviewed change' }, { ifMatch: revision('tsk1') }],
      ])
    } finally {
      await c.close()
    }
  })

  it('rejects malformed, ambiguous and missing preconditions', async () => {
    const schema = domainInputSchema('teamgrid_task_recurrence_occurrence_override')['~standard']
    const base = {
      workspaceId,
      seriesId: 'series1',
      occurrenceKey: `occ1-${'a'.repeat(64)}`,
      data: { action: 'skip' },
    }
    expect((await schema.validate(base)).issues).toBeDefined()
    expect((await schema.validate({ ...base, createIfMissing: true })).issues).toBeUndefined()
    expect(
      (await schema.validate({ ...base, expectedRevision: revision('tro1') })).issues,
    ).toBeUndefined()
    expect(
      (await schema.validate({ ...base, expectedRevision: '*', createIfMissing: true })).issues,
    ).toBeDefined()
    expect(
      (
        await domainInputSchema('teamgrid_document_update')['~standard'].validate({
          workspaceId,
          id: 'd1',
          expectedRevision: 'W/"weak"',
          data: { name: 'X' },
        })
      ).issues,
    ).toBeDefined()
  })

  it('returns the exact strong ETag for follow-up writes without transport or signing secrets', async () => {
    const c = await connected()
    try {
      await c.client.callTool({ name: 'teamgrid_webhook_get', arguments: { id: 'hook1' } })
      const get = c.calls.get('webhooks.get')
      if (!get) throw new Error('Missing webhook dispatch')
      get.mockResolvedValue({
        data: {
          id: 'hook1',
          type: 'webhook',
          attributes: { signingSecret: 'private-signing-secret', revision: 'r1' },
        },
        meta: { requestId: 'request1' },
        transport: {
          headers: {
            etag: revision('whk1'),
            authorization: 'private-bearer',
            'set-cookie': 'private-cookie',
          },
        },
      })
      const result = await c.client.callTool({
        name: 'teamgrid_webhook_get',
        arguments: { id: 'hook1' },
      })
      expect(result.structuredContent).toEqual({
        data: { id: 'hook1', type: 'webhook', attributes: { revision: 'r1' } },
        meta: { requestId: 'request1', etag: revision('whk1') },
      })
      expect(JSON.stringify(result)).not.toMatch(/private|transport|signingSecret/)
    } finally {
      await c.close()
    }
  })

  it('maps both future-occurrence precondition forms without silently replacing a revision', async () => {
    const c = await connected()
    try {
      const args = {
        workspaceId,
        seriesId: 'series1',
        occurrenceKey: `occ1-${'a'.repeat(64)}`,
        data: { action: 'skip' },
      }
      for (const precondition of [
        { createIfMissing: true },
        { expectedRevision: revision('tro1') },
      ]) {
        const result = await c.client.callTool({
          name: 'teamgrid_task_recurrence_occurrence_override',
          arguments: { ...args, ...precondition },
        })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
      }
      expect(c.calls.get('taskRecurrenceOccurrences.override')?.mock.calls).toEqual([
        [
          args.seriesId,
          args.occurrenceKey,
          args.data,
          { ifMatch: undefined, createIfMissing: true },
        ],
        [args.seriesId, args.occurrenceKey, args.data, { ifMatch: revision('tro1') }],
      ])
    } finally {
      await c.close()
    }
  })

  it('does not leak SDK transport headers from a successful 204', async () => {
    const c = await connected()
    try {
      await c.client.callTool({
        name: 'teamgrid_tag_archive',
        arguments: { workspaceId, id: 'tag1' },
      })
      const archive = c.calls.get('tags.archive')
      if (!archive) throw new Error('Missing archive dispatch')
      archive.mockResolvedValue({
        status: 204,
        headers: { authorization: 'private', 'set-cookie': 'private' },
      })
      const result = await c.client.callTool({
        name: 'teamgrid_tag_archive',
        arguments: { workspaceId, id: 'tag1' },
      })
      expect(JSON.stringify(result)).not.toMatch(/private|headers|set-cookie/)
      expect(result.structuredContent).toMatchObject({ data: { attributes: { completed: true } } })
      for (const invalid of [undefined, {}, { status: 202 }, { status: 500 }]) {
        archive.mockResolvedValue(invalid)
        const uncertain = await c.client.callTool({
          name: 'teamgrid_tag_archive',
          arguments: { workspaceId, id: 'tag1' },
        })
        expect(uncertain.isError).toBe(true)
        expect(uncertain.structuredContent).toMatchObject({
          error: { code: 'invalid_api_response' },
        })
      }
    } finally {
      await c.close()
    }
  })

  it('reports API denial and conflict without fetching a new revision or replaying a write', async () => {
    const c = await connected()
    try {
      const args = { workspaceId, id: 'tag1', data: { name: 'Tag' } }
      await c.client.callTool({ name: 'teamgrid_tag_update', arguments: args })
      for (const status of [401, 403, 409, 412]) {
        const method = c.calls.get('tags.update')
        if (!method) throw new Error('Missing update dispatch')
        method.mockClear().mockRejectedValue(
          new TeamGridApiError({
            status,
            errors: [
              { status: String(status), code: 'denied', title: 'Denied', detail: 'Refused' },
            ],
            requestId: 'request1',
          }),
        )
        expect(
          (await c.client.callTool({ name: 'teamgrid_tag_update', arguments: args }))
            .structuredContent,
        ).toMatchObject({ error: { status } })
        expect(method).toHaveBeenCalledTimes(1)
      }
      expect(c.calls.get('tags.get')).toBeUndefined()
    } finally {
      await c.close()
    }
  })

  it('includes all writes and exact compound scopes in setup diagnostics', () => {
    const plan = describeMcpAccess({ toolProfile: 'full' })
    expect(plan.tools).toHaveLength(208)
    expect(plan.writeTools).toHaveLength(
      domainToolNames.filter((n) => domainCatalog[n].write).length,
    )
    expect(plan.requiredScopes).toEqual(
      expect.arrayContaining([
        'workspace:read',
        'tasks:write',
        'task-recurrences:write',
        'members:write',
        'documents:write',
      ]),
    )
    expect(plan.browserLogin.supported).toBe(false)
  })
})
