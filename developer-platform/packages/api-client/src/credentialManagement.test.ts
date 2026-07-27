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
})
