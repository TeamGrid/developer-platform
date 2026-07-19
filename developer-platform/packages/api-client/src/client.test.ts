import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import { TeamGridApiError, TeamGridClientError } from './errors.js'
import { buildRegionalApiBaseUrl, normalizeApiBaseUrl, parseCredentialLocation } from './routing.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

function taskPage(nextCursor: string | null) {
  return {
    data: [{ attributes: { name: 'Task' }, id: 'task-1', type: 'task' }],
    meta: { page: { limit: 1, nextCursor }, requestId: 'request-1' },
  }
}

describe('TeamGrid API client', () => {
  it('exposes the API discovery operation through the typed system client', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe('/v1/')
      return json({
        data: { documentation: 'https://developer.teamgridapp.com/api/v1', version: '1' },
        meta: { requestId: 'request-version' },
      })
    })
    const client = new TeamGridClient({ fetch, token })
    await expect(client.system.getApiVersion()).resolves.toMatchObject({
      data: { version: '1' },
      meta: { requestId: 'request-version' },
    })
  })

  it('derives a regional endpoint without exposing the credential secret', () => {
    expect(parseCredentialLocation(token)).toEqual({
      cellId: 'us-mnz-001',
      credentialId: '0123456789abcdef01234567',
      region: 'us',
    })
    expect(buildRegionalApiBaseUrl('us')).toBe('https://api.us.teamgrid.app/v1')
    expect(normalizeApiBaseUrl('http://localhost:2201/v1/')).toBe('http://localhost:2201/v1')
    expect(normalizeApiBaseUrl('http://[::1]:2201/v1/')).toBe('http://[::1]:2201/v1')
    expect(() => normalizeApiBaseUrl('http://api.teamgrid.app/v1')).toThrow(TeamGridClientError)
  })

  it('sends tenant credentials in headers and preserves response metadata', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(`${url.origin}${url.pathname}`).toBe('https://api.us.teamgrid.app/v1/tasks')
      expect(Object.fromEntries(url.searchParams)).toEqual({ completed: 'false', limit: '1' })
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('x-request-id')).toBe('client-request')
      expect(headers.get('x-teamgrid-client')).toBe('@teamgrid/api-client')
      expect(headers.get('x-teamgrid-client-version')).toBe('1.0.0-alpha.2')
      return json(taskPage(null), 200, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '99',
        'x-ratelimit-reset': '1700000000000',
        'x-request-id': 'request-transport',
      })
    })
    const client = new TeamGridClient({ fetch, token })
    const page = await client.tasks.list({
      completed: false,
      limit: 1,
      requestId: 'client-request',
    })
    expect(page.meta.requestId).toBe('request-1')
    expect(page.data[0]?.id).toBe('task-1')
    expect(page.transport).toMatchObject({
      attempts: 1,
      rateLimit: { limit: 100, remaining: 99, reset: 1_700_000_000_000 },
      requestId: 'request-transport',
      status: 200,
    })
    expect(JSON.stringify(page)).not.toContain('transport')
  })

  it('retries safe reads and idempotent creates but not patches', async () => {
    const sleep = vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => undefined)
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ errors: [] }, 503, { 'retry-after': '1' }))
      .mockResolvedValueOnce(json(taskPage(null)))
      .mockResolvedValueOnce(json({ errors: [] }, 503))
      .mockResolvedValueOnce(
        json(
          {
            data: { attributes: { name: 'Created' }, id: 'task-2', type: 'task' },
            meta: { requestId: 'request-2' },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            errors: [
              {
                code: 'upstream_error',
                detail: 'Unavailable',
                status: '503',
                title: 'Unavailable',
              },
            ],
            meta: { requestId: 'request-3' },
          },
          503,
        ),
      )
    const client = new TeamGridClient({ fetch, random: () => 0, sleep, token })

    const retriedPage = await client.tasks.list()
    await client.tasks.create({ name: 'Created' }, { idempotencyKey: 'stable-key' })
    await expect(client.tasks.update('task-2', { name: 'Changed' })).rejects.toBeInstanceOf(
      TeamGridApiError,
    )
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(retriedPage.transport.attempts).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls[0]?.[0]).toBe(1000)
  })

  it('iterates stable pages and detects cursor cycles', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(taskPage('next')))
      .mockResolvedValueOnce(json(taskPage(null)))
    const client = new TeamGridClient({ fetch, token })
    const pages = []
    for await (const page of client.tasks.pages({ limit: 1 })) pages.push(page)
    expect(pages).toHaveLength(2)

    const cyclic = new TeamGridClient({
      fetch: vi.fn(async () => json(taskPage('same'))),
      token,
    })
    await expect(async () => {
      for await (const _page of cyclic.tasks.pages()) {
        // exhaust the iterator
      }
    }).rejects.toMatchObject({ code: 'pagination_cycle' })
  })

  it('surfaces versioned API errors without retaining the bearer token', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () =>
        json(
          {
            errors: [
              {
                code: 'insufficient_scope',
                detail: 'Missing scope.',
                status: '403',
                title: 'Forbidden',
              },
            ],
            meta: { requestId: 'request-error' },
          },
          403,
        ),
      ),
      token,
    })
    const error = await client.tasks.list().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TeamGridApiError)
    expect(error).toMatchObject({ requestId: 'request-error', status: 403 })
    expect(error).toMatchObject({ transport: { attempts: 1, status: 403 } })
    expect(JSON.stringify(error)).not.toContain(token)
  })

  it('rejects oversized and structurally invalid successful responses', async () => {
    const oversized = new TeamGridClient({
      fetch: vi.fn(async () => json({ padding: 'x'.repeat(2000) })),
      maxResponseBytes: 1024,
      token,
    })
    await expect(oversized.tasks.list()).rejects.toMatchObject({ code: 'response_too_large' })

    const wrongResource = new TeamGridClient({
      fetch: vi.fn(async () =>
        json({
          data: [{ attributes: {}, id: 'call-1', type: 'call' }],
          meta: { page: { limit: 1, nextCursor: null }, requestId: 'request-invalid' },
        }),
      ),
      token,
    })
    await expect(wrongResource.tasks.list()).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })

  it('uses the same typed transport for idempotent webhook management', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v1/webhooks')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('webhook-request-1')
      expect(JSON.parse(String(init?.body))).toEqual({
        actions: ['task_created'],
        url: 'https://hooks.example.com/teamgrid',
      })
      return json(
        {
          data: {
            attributes: {
              actions: ['task_created'],
              disabled: false,
              failCount: 0,
              lastStatus: null,
              url: 'https://hooks.example.com/teamgrid',
            },
            id: 'webhook-1',
            type: 'webhook',
          },
          meta: { requestId: 'request-webhook' },
        },
        201,
        { 'idempotency-replayed': 'true', 'x-request-id': 'request-webhook-header' },
      )
    })
    const client = new TeamGridClient({ fetch, token })
    const result = await client.webhooks.create(
      { actions: ['task_created'], url: 'https://hooks.example.com/teamgrid' },
      { idempotencyKey: 'webhook-request-1' },
    )
    expect(result.data.id).toBe('webhook-1')
    expect(result.transport).toMatchObject({
      idempotencyReplayed: true,
      requestId: 'request-webhook-header',
      status: 201,
    })
  })

  it('routes commerce and credential-owned delivery filters through bounded list requests', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/products') {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          disabled: 'false',
          productGroupId: 'group-1',
        })
        return json({
          data: [{ attributes: { name: 'Consulting' }, id: 'product-1', type: 'product' }],
          meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-products' },
        })
      }
      expect(url.pathname).toBe('/v1/webhook-deliveries')
      expect(Object.fromEntries(url.searchParams)).toEqual({
        event: 'task.created',
        state: 'failed',
        webhookId: 'webhook-1',
      })
      return json({
        data: [
          {
            attributes: { event: 'task.created', state: 'failed', webhookId: 'webhook-1' },
            id: 'delivery-1',
            type: 'webhookDelivery',
          },
        ],
        meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-deliveries' },
      })
    })
    const client = new TeamGridClient({ fetch, token })
    await expect(
      client.products.list({ disabled: false, productGroupId: 'group-1' }),
    ).resolves.toMatchObject({ data: [{ id: 'product-1' }] })
    await expect(
      client.webhookDeliveries.list({
        event: 'task.created',
        state: 'failed',
        webhookId: 'webhook-1',
      }),
    ).resolves.toMatchObject({ data: [{ id: 'delivery-1' }] })
  })

  it.each([
    {
      create: (client: TeamGridClient) =>
        client.projects.create(
          { name: 'Integration project' },
          { idempotencyKey: 'project-create-1' },
        ),
      createBody: { name: 'Integration project' },
      createPath: '/v1/projects',
      idempotencyKey: 'project-create-1',
      resource: { attributes: { name: 'Integration project' }, id: 'project-1', type: 'project' },
      update: (client: TeamGridClient) => client.projects.update('project-1', { color: '#123456' }),
      updateBody: { color: '#123456' },
      updatePath: '/v1/projects/project-1',
    },
    {
      create: (client: TeamGridClient) =>
        client.contacts.create(
          { firstName: 'Ada', lastName: 'Lovelace', type: 'person' },
          { idempotencyKey: 'contact-create-1' },
        ),
      createBody: { firstName: 'Ada', lastName: 'Lovelace', type: 'person' },
      createPath: '/v1/contacts',
      idempotencyKey: 'contact-create-1',
      resource: {
        attributes: { firstName: 'Ada', lastName: 'Lovelace' },
        id: 'contact-1',
        type: 'contact',
      },
      update: (client: TeamGridClient) => client.contacts.update('contact-1', { nickname: 'Ada' }),
      updateBody: { nickname: 'Ada' },
      updatePath: '/v1/contacts/contact-1',
    },
  ])(
    'supports idempotent create and typed update for $createPath',
    async ({
      create,
      createBody,
      createPath,
      idempotencyKey,
      resource,
      update,
      updateBody,
      updatePath,
    }) => {
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        if (init?.method === 'POST') {
          expect(url.pathname).toBe(createPath)
          expect(new Headers(init.headers).get('idempotency-key')).toBe(idempotencyKey)
          expect(JSON.parse(String(init.body))).toEqual(createBody)
          return json({ data: resource, meta: { requestId: 'request-create' } }, 201)
        }
        expect(init?.method).toBe('PATCH')
        expect(url.pathname).toBe(updatePath)
        expect(JSON.parse(String(init?.body))).toEqual(updateBody)
        return json({ data: resource, meta: { requestId: 'request-update' } })
      })
      const client = new TeamGridClient({ fetch, token })

      await expect(create(client)).resolves.toMatchObject({ data: resource })
      await expect(update(client)).resolves.toMatchObject({ data: resource })
      expect(fetch).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    {
      create: (client: TeamGridClient) =>
        client.lists.create(
          { name: 'Delivery', parentId: 'project-1', type: 'tasks' },
          { idempotencyKey: 'list-create-1' },
        ),
      createBody: { name: 'Delivery', parentId: 'project-1', type: 'tasks' },
      id: 'list-1',
      list: (client: TeamGridClient) =>
        client.lists.list({ archived: false, parentId: 'project-1', type: 'tasks' }),
      listQuery: { archived: 'false', parentId: 'project-1', type: 'tasks' },
      path: '/v1/lists',
      resource: {
        attributes: {
          archived: false,
          createdAt: null,
          name: 'Delivery',
          order: 100,
          parentId: 'project-1',
          type: 'tasks',
          updatedAt: null,
        },
        id: 'list-1',
        type: 'list',
      },
      surface: 'lists' as const,
      updateBody: { name: 'Shipping' },
    },
    {
      create: (client: TeamGridClient) =>
        client.services.create(
          { billable: true, billingRate: 175, title: 'Consulting' },
          { idempotencyKey: 'service-create-1' },
        ),
      createBody: { billable: true, billingRate: 175, title: 'Consulting' },
      id: 'service-1',
      list: (client: TeamGridClient) => client.services.list({ archived: false }),
      listQuery: { archived: 'false' },
      path: '/v1/services',
      resource: {
        attributes: {
          archived: false,
          billable: true,
          billingRate: 175,
          createdAt: null,
          title: 'Consulting',
          updatedAt: null,
        },
        id: 'service-1',
        type: 'service',
      },
      surface: 'services' as const,
      updateBody: { billingRate: 190 },
    },
    {
      create: (client: TeamGridClient) =>
        client.tags.create(
          { color: '#123456', name: 'Priority' },
          { idempotencyKey: 'tag-create-1' },
        ),
      createBody: { color: '#123456', name: 'Priority' },
      id: 'tag-1',
      list: (client: TeamGridClient) => client.tags.list({ archived: false }),
      listQuery: { archived: 'false' },
      path: '/v1/tags',
      resource: {
        attributes: {
          archived: false,
          color: '#123456',
          createdAt: null,
          name: 'Priority',
          updatedAt: null,
          usage: 0,
        },
        id: 'tag-1',
        type: 'tag',
      },
      surface: 'tags' as const,
      updateBody: { color: '#654321' },
    },
  ])(
    'supports the complete metadata lifecycle for $surface',
    async ({ create, createBody, id, list, listQuery, path, resource, surface, updateBody }) => {
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const itemPath = `${path}/${id}`

        if (url.pathname === path && init?.method === 'POST') {
          expect(new Headers(init.headers).get('idempotency-key')).toBe(
            `${surface.slice(0, -1)}-create-1`,
          )
          expect(JSON.parse(String(init.body))).toEqual(createBody)
          return json({ data: resource, meta: { requestId: 'request-create' } }, 201)
        }
        if (url.pathname === path) {
          expect(init?.method).toBe('GET')
          expect(Object.fromEntries(url.searchParams)).toEqual(listQuery)
          return json({
            data: [resource],
            meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
          })
        }
        if (url.pathname === `${itemPath}/restore`) {
          expect(init?.method).toBe('POST')
          return json({ data: resource, meta: { requestId: 'request-restore' } })
        }
        if (init?.method === 'PATCH') {
          expect(url.pathname).toBe(itemPath)
          expect(JSON.parse(String(init.body))).toEqual(updateBody)
          return json({ data: resource, meta: { requestId: 'request-update' } })
        }
        if (init?.method === 'DELETE') {
          expect(url.pathname).toBe(itemPath)
          return new Response(null, { status: 204 })
        }
        expect(init?.method).toBe('GET')
        expect(url.pathname).toBe(itemPath)
        return json({ data: resource, meta: { requestId: 'request-get' } })
      })
      const client = new TeamGridClient({ fetch, token })

      await expect(list(client)).resolves.toMatchObject({ data: [resource] })
      await expect(client[surface].get(id)).resolves.toMatchObject({ data: resource })
      await expect(create(client)).resolves.toMatchObject({ data: resource })
      await expect(client[surface].update(id, updateBody as never)).resolves.toMatchObject({
        data: resource,
      })
      await expect(client[surface].archive(id)).resolves.toMatchObject({ status: 204 })
      await expect(client[surface].restore(id)).resolves.toMatchObject({ data: resource })
      expect(fetch).toHaveBeenCalledTimes(6)
    },
  )

  it.each([
    {
      invoke: (client: TeamGridClient) => client.tasks.complete('task-1'),
      path: '/v1/tasks/task-1/complete',
      resource: { attributes: { completed: true }, id: 'task-1', type: 'task' },
    },
    {
      invoke: (client: TeamGridClient) => client.tasks.reopen('task-1'),
      path: '/v1/tasks/task-1/reopen',
      resource: { attributes: { completed: false }, id: 'task-1', type: 'task' },
    },
    {
      invoke: (client: TeamGridClient) => client.tasks.restore('task-1'),
      path: '/v1/tasks/task-1/restore',
      resource: { attributes: { archived: false }, id: 'task-1', type: 'task' },
    },
    {
      invoke: (client: TeamGridClient) => client.timeEntries.restore('time-1'),
      path: '/v1/time-entries/time-1/restore',
      resource: { attributes: { archived: false }, id: 'time-1', type: 'timeEntry' },
    },
  ])('executes lifecycle commands with POST $path', async ({ invoke, path, resource }) => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(path)
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
      return json({ data: resource, meta: { requestId: 'request-restore' } })
    })
    await expect(invoke(new TeamGridClient({ fetch, token }))).resolves.toMatchObject({
      data: resource,
    })
  })

  it.each([
    {
      action: 'start',
      invoke: (client: TeamGridClient) =>
        client.tasks.startTimer('task-1', { at: '2026-07-19T10:00:00.000Z', userId: 'user-1' }),
    },
    {
      action: 'stop',
      invoke: (client: TeamGridClient) =>
        client.tasks.stopTimer('task-1', { at: '2026-07-19T10:30:00.000Z', userId: 'user-1' }),
    },
  ])('uses the time-entry response contract for task timer $action', async ({ action, invoke }) => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(`/v1/tasks/task-1/timer/${action}`)
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({ userId: 'user-1' })
      return json({
        data: {
          attributes: { endAt: action === 'stop' ? '2026-07-19T10:30:00.000Z' : null },
          id: 'time-1',
          type: 'timeEntry',
        },
        meta: { requestId: 'request-timer' },
      })
    })
    await expect(invoke(new TeamGridClient({ fetch, token }))).resolves.toMatchObject({
      data: { id: 'time-1', type: 'timeEntry' },
    })
  })

  it('supports custom-field definition list and lifecycle operations', async () => {
    const resource = {
      attributes: {
        archived: false,
        compatibility: 'writable',
        configuration: { type: 'text' },
        createdAt: null,
        defaultEnabled: false,
        description: '',
        fieldType: 'text',
        required: false,
        targetType: 'task',
        title: 'Reference',
        updatedAt: null,
      },
      id: 'field-1',
      type: 'customFieldDefinition',
    }
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/custom-field-definitions') {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          archived: 'false',
          fieldType: 'text',
          targetType: 'task',
        })
        return json({
          data: [resource],
          meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-list' },
        })
      }
      if (url.pathname.endsWith('/restore')) {
        expect(init?.method).toBe('POST')
        return json({ data: resource, meta: { requestId: 'request-restore' } })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    })
    const client = new TeamGridClient({ fetch, token })
    await expect(
      client.customFieldDefinitions.list({
        archived: false,
        fieldType: 'text',
        targetType: 'task',
      }),
    ).resolves.toMatchObject({ data: [resource] })
    await expect(client.customFieldDefinitions.restore('field-1')).resolves.toMatchObject({
      data: resource,
    })
  })

  it('supports bounded call-note and contact-group resources', async () => {
    const callNote = {
      attributes: { archived: false, callId: 'call-1', content: 'Follow up tomorrow.' },
      id: 'note-1',
      type: 'callNote',
    }
    const contactGroup = {
      attributes: { archived: false, parentId: null, title: 'Customers' },
      id: 'group-1',
      type: 'contactGroup',
    }
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/call-notes') {
        expect(url.searchParams.get('archived')).toBe('false')
        return json({
          data: [callNote],
          meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-notes' },
        })
      }
      if (url.pathname === '/v1/contact-groups/group-1') {
        expect(init?.method).toBe('PATCH')
        expect(JSON.parse(String(init?.body))).toEqual({ title: 'Key customers' })
        return json({ data: contactGroup, meta: { requestId: 'request-group' } })
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    })
    const client = new TeamGridClient({ fetch, token })
    await expect(client.callNotes.list({ archived: false })).resolves.toMatchObject({
      data: [callNote],
    })
    await expect(
      client.contactGroups.update('group-1', { title: 'Key customers' }),
    ).resolves.toMatchObject({ data: contactGroup })
  })

  it('starts and polls a durable project lifecycle operation', async () => {
    const pending = {
      attributes: {
        action: 'complete',
        attempts: 0,
        checkpoints: {},
        createdAt: '2026-07-19T10:00:00.000Z',
        noOp: false,
        projectId: 'project-1',
        state: 'pending',
        updatedAt: '2026-07-19T10:00:00.000Z',
      },
      id: 'operation-1',
      type: 'projectLifecycleOperation',
    }
    const succeeded = {
      ...pending,
      attributes: { ...pending.attributes, state: 'succeeded' },
    }
    const fetch = vi
      .fn()
      .mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(input)).pathname).toBe('/v1/projects/project-1/complete')
        expect(init?.method).toBe('POST')
        expect(new Headers(init?.headers).get('idempotency-key')).toBe('lifecycle-1')
        return json({ data: pending, meta: { requestId: 'request-start' } }, 202, {
          location: '/v1/project-lifecycle-operations/operation-1',
        })
      })
      .mockImplementationOnce(async (input: RequestInfo | URL) => {
        expect(new URL(String(input)).pathname).toBe('/v1/project-lifecycle-operations/operation-1')
        return json({ data: succeeded, meta: { requestId: 'request-poll' } })
      })
    const sleep = vi.fn(async () => undefined)
    const client = new TeamGridClient({ fetch, sleep, token })
    const started = await client.projects.complete('project-1', {
      idempotencyKey: 'lifecycle-1',
    })
    expect(started.data).toEqual(pending)
    const completed = await client.projectLifecycleOperations.wait(started.data.id, {
      maxWaitMs: 1000,
      pollIntervalMs: 100,
    })
    expect(completed.data.attributes.state).toBe('succeeded')
    expect(sleep).not.toHaveBeenCalled()
  })
})
