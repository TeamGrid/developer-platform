import { describe, expect, it, vi } from 'vitest'
import { TeamGridClient } from './client.js'
import type { TeamGridClientError } from './errors.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_pat_v2_de_de-nbg-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const credentialId = '0123456789abcdef01234567'
const personalToken = `tg_pat_v2_de_de-nbg-001_${credentialId}_${'a'.repeat(64)}`
const serviceToken = `tg_sa_v2_de_de-nbg-001_${credentialId}_${'b'.repeat(64)}`

function envelope(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(
    JSON.stringify({
      data,
      meta: { requestId: 'credential-request' },
    }),
    {
      headers: { 'content-type': 'application/json', ...headers },
      status,
    },
  )
}

function credential(type: 'personalAccessToken' | 'serviceAccountCredential') {
  return {
    attributes: {
      createdAt: '2026-07-27T12:00:00.000Z',
      description: null,
      expiresAt: '2026-10-27T12:00:00.000Z',
      generation: 1,
      graceEndsAt: null,
      lastFour: 'cafe',
      lastUsedAt: null,
      name: 'Automation',
      notBeforeAt: null,
      principalId: type === 'personalAccessToken' ? `pat:${credentialId}` : `sa:${credentialId}`,
      scopes: ['credentials:read'],
      status: 'active',
      token: type === 'personalAccessToken' ? personalToken : serviceToken,
    },
    id: credentialId,
    type,
  } as const
}

describe('native credential SDK surfaces', () => {
  it('preserves no-store reveal semantics for personal and service credentials', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const type = url.pathname.includes('/service-accounts')
        ? 'serviceAccountCredential'
        : 'personalAccessToken'
      return envelope(credential(type), 201, {
        'cache-control': 'private, no-store',
        'idempotency-replayed': 'false',
      })
    })
    const client = new TeamGridClient({ fetch, token })
    const personal = await client.personalAccessTokens.create(
      {
        name: 'Automation',
        scopes: ['credentials:read'],
      },
      { idempotencyKey: 'personal-1' },
    )
    const service = await client.serviceAccounts.create(
      {
        name: 'ERP',
        scopes: ['credentials:read'],
      },
      { idempotencyKey: 'service-1' },
    )
    expect(personal.data.attributes.token).toBe(personalToken)
    expect(service.data.attributes.token).toBe(serviceToken)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects reveal responses without the exact private cache contract', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () =>
        envelope(credential('personalAccessToken'), 201, {
          'cache-control': 'public, max-age=60',
          'idempotency-replayed': 'false',
        }),
      ),
      token,
    })
    await expect(
      client.personalAccessTokens.create({
        name: 'Automation',
        scopes: ['credentials:read'],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_api_response',
    } satisfies Partial<TeamGridClientError>)
  })

  it('fails closed if metadata responses contain reveal-once tokens', async () => {
    const client = new TeamGridClient({
      fetch: vi.fn(async () => envelope([credential('personalAccessToken')])),
      token,
    })
    await expect(client.personalAccessTokens.list()).rejects.toMatchObject({
      code: 'invalid_api_response',
    } satisfies Partial<TeamGridClientError>)
  })

  it('reads and conditionally replaces exact service-account resource-grant sets', async () => {
    const serviceAccountId = 'f'.repeat(24)
    const firstRevision = 'a'.repeat(64)
    const secondRevision = 'b'.repeat(64)
    const requests: Request[] = []
    const resource = (revision: string, policyVersion: number) => ({
      attributes: {
        grants: [
          {
            anchorId: null,
            anchorType: 'workspace',
            capabilities: ['api.v1.getWorkspace'],
            expiresAt: null,
            id: 'grant-1',
            inheritance: 'none',
            resourceKey: 'workspace',
          },
        ],
        policyVersion,
        revision,
      },
      id: serviceAccountId,
      type: 'serviceAccountResourceGrantSet',
    })
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const replacing = request.method === 'PUT'
      const revision = replacing ? secondRevision : firstRevision
      return envelope(resource(revision, replacing ? 2 : 1), 200, {
        'cache-control': 'private, no-store, no-transform',
        etag: `"dgr1-${revision}"`,
      })
    })
    const client = new TeamGridClient({ fetch, token })

    const current = await client.serviceAccounts.getResourceGrants(serviceAccountId)
    const replacement = {
      grants: [
        {
          anchorType: 'workspace' as const,
          capabilities: ['api.v1.getWorkspace'],
          inheritance: 'none' as const,
          resourceKey: 'workspace',
        },
      ],
    }
    const replaced = await client.serviceAccounts.replaceResourceGrants(
      serviceAccountId,
      replacement,
      `"dgr1-${firstRevision}"`,
    )

    expect(current.data.attributes.policyVersion).toBe(1)
    expect(replaced.data.attributes.policyVersion).toBe(2)
    expect(requests[1]?.headers.get('if-match')).toBe(`"dgr1-${firstRevision}"`)
    await expect(requests[1]?.json()).resolves.toEqual(replacement)
  })

  it('rejects malformed resource-grant replacements before transport', async () => {
    const fetch = vi.fn()
    const client = new TeamGridClient({ fetch, token })
    await expect(
      client.serviceAccounts.replaceResourceGrants(
        'f'.repeat(24),
        {
          grants: [
            {
              anchorId: 'not-allowed',
              anchorType: 'workspace',
              capabilities: ['api.v1.getWorkspace'],
              inheritance: 'none',
              resourceKey: 'workspace',
            },
          ],
        },
        `dgr1-${'a'.repeat(64)}`,
      ),
    ).rejects.toMatchObject({
      code: 'invalid_arguments',
    } satisfies Partial<TeamGridClientError>)
    expect(fetch).not.toHaveBeenCalled()
  })
})
