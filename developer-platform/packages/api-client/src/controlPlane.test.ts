import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import { TeamGridClientError } from './errors.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const settingsRevision = `wst1-${'a'.repeat(64)}` as const
const nextSettingsRevision = `wst1-${'b'.repeat(64)}` as const
const webhookRevision = `whk1-${'c'.repeat(64)}` as const
const nextWebhookRevision = `whk1-${'d'.repeat(64)}` as const
const signingSecret = `whsec_v2_${'A'.repeat(43)}`

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  })
}

function envelope(data: unknown, status = 200, headers: HeadersInit = {}) {
  return json({ data, meta: { requestId: 'request-control-plane' } }, status, headers)
}

function settings(revision = settingsRevision) {
  return {
    attributes: {
      currency: 'EUR',
      defaultLanguage: 'de',
      defaultPlannedTime: 60,
      defaultProductivity: 100,
      defaultShowInScheduling: true,
      name: 'TeamGrid',
      revision,
    },
    id: 'current',
    type: 'workspaceSettings',
  } as const
}

function rotation(replayed: boolean, revision = nextWebhookRevision) {
  return {
    attributes: { replayed, revision, signingSecret },
    id: 'webhook-1',
    type: 'webhookSecretRotation',
  } as const
}

function webhook(includeSecret = false) {
  return {
    attributes: {
      actions: ['task.updated'],
      disabled: false,
      failCount: 0,
      lastStatus: null,
      revision: webhookRevision,
      ...(includeSecret ? { signingSecret } : {}),
      url: 'https://hooks.example.test/teamgrid',
      version: 2,
    },
    id: 'webhook-1',
    type: 'webhook',
  } as const
}

describe('developer control-plane SDK surfaces', () => {
  it('routes all six operations with exact CAS, idempotency, and safe rotation semantics', async () => {
    const calls = new Set<string>()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      calls.add(`${method} ${url.pathname}`)
      const headers = new Headers(init?.headers)
      if (url.pathname === '/v1/system/capabilities') {
        return envelope([
          {
            attributes: { accessible: true, entitled: true },
            id: 'automation',
            type: 'systemCapability',
          },
          {
            attributes: { accessible: false, entitled: true },
            id: 'webhooks',
            type: 'systemCapability',
          },
        ])
      }
      if (url.pathname === '/v1/workspace/entitlements') {
        return envelope([
          {
            attributes: { accessible: true, enabled: true },
            id: 'automation',
            type: 'workspaceEntitlement',
          },
        ])
      }
      if (url.pathname === '/v1/events/catalog') {
        return envelope([
          {
            attributes: {
              channel: 'webhook',
              operation: null,
              requiredScopes: ['webhooks:read'],
              resourceType: null,
            },
            id: 'task.updated',
            type: 'eventDefinition',
          },
          {
            attributes: {
              channel: 'changeFeed',
              operation: 'updated',
              requiredScopes: ['tasks:read'],
              resourceType: 'task',
            },
            id: 'task.updated',
            type: 'eventDefinition',
          },
        ])
      }
      if (url.pathname === '/v1/workspace/settings' && method === 'GET') {
        return envelope(settings(), 200, { etag: `"${settingsRevision}"` })
      }
      if (url.pathname === '/v1/workspace/settings' && method === 'PATCH') {
        expect(headers.get('if-match')).toBe(`"${settingsRevision}"`)
        expect(headers.get('idempotency-key')).toBe('settings-update-1')
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'Platform' })
        return envelope(settings(nextSettingsRevision), 200, {
          etag: `"${nextSettingsRevision}"`,
          'idempotency-replayed': 'false',
        })
      }
      if (url.pathname === '/v1/webhooks/webhook-1/secret-rotation') {
        expect(method).toBe('POST')
        expect(init?.body).toBeUndefined()
        expect(headers.get('if-match')).toBe(`"${webhookRevision}"`)
        expect(headers.get('idempotency-key')).toBe('rotate-1')
        return envelope(rotation(false), 201, {
          'cache-control': 'private, no-store',
          etag: `"${nextWebhookRevision}"`,
          'idempotency-replayed': 'false',
        })
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    })
    const client = new TeamGridClient({ fetch, token })

    await client.system.getCapabilities()
    await client.workspace.getEntitlements()
    await client.workspaceSettings.get()
    const updated = await client.workspaceSettings.update(
      { name: 'Platform' },
      { idempotencyKey: 'settings-update-1', ifMatch: settingsRevision },
    )
    await client.events.getCatalog()
    const rotated = await client.webhooks.rotateSecret('webhook-1', {
      idempotencyKey: 'rotate-1',
      ifMatch: webhookRevision,
    })

    expect(updated.transport.idempotencyReplayed).toBe(false)
    expect(rotated.data.attributes.signingSecret).toBe(signingSecret)
    expect(calls).toEqual(
      new Set([
        'GET /v1/system/capabilities',
        'GET /v1/workspace/entitlements',
        'GET /v1/workspace/settings',
        'PATCH /v1/workspace/settings',
        'GET /v1/events/catalog',
        'POST /v1/webhooks/webhook-1/secret-rotation',
      ]),
    )
  })

  it('accepts only an internally consistent idempotent secret replay', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () =>
        envelope(rotation(true), 200, {
          'cache-control': 'private, no-store',
          etag: `"${nextWebhookRevision}"`,
          'idempotency-replayed': 'true',
        }),
      ),
      token,
    })
    const response = await client.webhooks.rotateSecret('webhook-1', {
      idempotencyKey: 'rotate-1',
      ifMatch: webhookRevision,
    })
    expect(response.data.attributes.replayed).toBe(true)
    expect(response.transport.idempotencyReplayed).toBe(true)
  })

  it('fails closed on extra, duplicate, or incorrectly ordered discovery data', async () => {
    const invalidBodies = [
      [
        {
          attributes: { accessible: true, entitled: true },
          id: 'webhooks',
          type: 'systemCapability',
        },
        {
          attributes: { accessible: true, entitled: true },
          id: 'automation',
          type: 'systemCapability',
        },
      ],
      [
        {
          attributes: { accessible: true, entitled: false },
          id: 'automation',
          type: 'systemCapability',
        },
      ],
      [
        {
          attributes: { accessible: true, entitled: true, rawPlan: 'enterprise' },
          id: 'automation',
          type: 'systemCapability',
        },
      ],
      [
        {
          attributes: { accessible: true, entitled: true },
          id: 'automation',
          type: 'systemCapability',
        },
        {
          attributes: { accessible: false, entitled: true },
          id: 'automation',
          type: 'systemCapability',
        },
      ],
    ]
    for (const data of invalidBodies) {
      const client = new TeamGridClient({ fetch: vi.fn(async () => envelope(data)), token })
      await expect(client.system.getCapabilities()).rejects.toMatchObject({
        code: 'invalid_api_response',
      })
    }
  })

  it('rejects an accessible workspace capability that is not enabled', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () =>
        envelope([
          {
            attributes: { accessible: true, enabled: false },
            id: 'automation',
            type: 'workspaceEntitlement',
          },
        ]),
      ),
      token,
    })
    await expect(client.workspace.getEntitlements()).rejects.toMatchObject({
      code: 'invalid_api_response',
    })
  })

  it('rejects malformed settings and event envelopes plus mismatched settings ETags', async () => {
    const cases = [
      envelope(
        { ...settings(), attributes: { ...settings().attributes, internalPlan: 'private' } },
        200,
        { etag: `"${settingsRevision}"` },
      ),
      envelope(settings(), 200, { etag: `"wst1-${'0'.repeat(64)}"` }),
      envelope([
        {
          attributes: {
            channel: 'webhook',
            operation: 'updated',
            requiredScopes: ['webhooks:read'],
            resourceType: 'task',
          },
          id: 'task.updated',
          type: 'eventDefinition',
        },
      ]),
    ]
    for (const [index, response] of cases.entries()) {
      const client = new TeamGridClient({ fetch: vi.fn(async () => response), token })
      const request = index < 2 ? client.workspaceSettings.get() : client.events.getCatalog()
      await expect(request).rejects.toMatchObject({ code: 'invalid_api_response' })
    }
  })

  it('validates workspace mutation inputs and all secret-rotation response invariants', async () => {
    const neverFetch = vi.fn(async () => envelope(settings()))
    const client = new TeamGridClient({ fetch: neverFetch, token })
    await expect(
      client.workspaceSettings.update({}, { ifMatch: settingsRevision }),
    ).rejects.toBeInstanceOf(TeamGridClientError)
    await expect(
      client.workspaceSettings.update(
        { name: 'Platform' },
        { idempotencyKey: 'contains space', ifMatch: settingsRevision },
      ),
    ).rejects.toBeInstanceOf(TeamGridClientError)
    await expect(
      Reflect.apply(client.workspaceSettings.update, client.workspaceSettings, [
        { currency: { toString: () => 'EUR' } },
        { ifMatch: settingsRevision },
      ]),
    ).rejects.toBeInstanceOf(TeamGridClientError)
    expect(neverFetch).not.toHaveBeenCalled()

    const unsafeResponses = [
      envelope(rotation(false), 201, {
        etag: `"${nextWebhookRevision}"`,
        'idempotency-replayed': 'false',
      }),
      envelope(rotation(false), 200, {
        'cache-control': 'private, no-store',
        etag: `"${nextWebhookRevision}"`,
        'idempotency-replayed': 'true',
      }),
      envelope(
        {
          ...rotation(false),
          attributes: { ...rotation(false).attributes, signingSecret: 'not-a-secret' },
        },
        201,
        {
          'cache-control': 'private, no-store',
          etag: `"${nextWebhookRevision}"`,
          'idempotency-replayed': 'false',
        },
      ),
      envelope(rotation(false), 201, {
        'cache-control': 'private, no-store',
        etag: `"whk1-${'0'.repeat(64)}"`,
        'idempotency-replayed': 'false',
      }),
    ]
    for (const response of unsafeResponses) {
      const unsafe = new TeamGridClient({ fetch: vi.fn(async () => response), token })
      await expect(
        unsafe.webhooks.rotateSecret('webhook-1', {
          idempotencyKey: 'rotate-1',
          ifMatch: webhookRevision,
        }),
      ).rejects.toMatchObject({ code: 'invalid_api_response' })
    }
  })

  it('keeps webhook reads secret-free and validates URLs, exact fields, and read ETags', async () => {
    const validFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/webhooks') {
        return json({
          data: [webhook()],
          meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-webhooks' },
        })
      }
      return envelope(webhook(), 200, { etag: `"${webhookRevision}"` })
    })
    const valid = new TeamGridClient({ fetch: validFetch, token })
    await expect(valid.webhooks.list()).resolves.toMatchObject({ data: [webhook()] })
    await expect(valid.webhooks.get('webhook-1')).resolves.toMatchObject({ data: webhook() })

    const invalidReads: Array<{ list: boolean; value: unknown; etag?: string }> = [
      { list: true, value: webhook(true) },
      { list: false, value: webhook(true), etag: `"${webhookRevision}"` },
      {
        list: false,
        value: {
          ...webhook(),
          attributes: { ...webhook().attributes, url: 'https://user:pass@hooks.example.test/x' },
        },
        etag: `"${webhookRevision}"`,
      },
      {
        list: false,
        value: { ...webhook(), internalCredentialId: 'private' },
        etag: `"${webhookRevision}"`,
      },
      { list: false, value: webhook(), etag: `"whk1-${'0'.repeat(64)}"` },
    ]
    for (const testCase of invalidReads) {
      const response = testCase.list
        ? json({
            data: [testCase.value],
            meta: { page: { limit: 50, nextCursor: null }, requestId: 'request-webhooks' },
          })
        : envelope(testCase.value, 200, { etag: testCase.etag || '' })
      const invalid = new TeamGridClient({ fetch: vi.fn(async () => response), token })
      const request = testCase.list ? invalid.webhooks.list() : invalid.webhooks.get('webhook-1')
      await expect(request).rejects.toMatchObject({ code: 'invalid_api_response' })
    }
  })
})
