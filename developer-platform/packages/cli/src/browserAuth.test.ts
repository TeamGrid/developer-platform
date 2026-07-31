import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  loginWithSystemBrowser,
  normalizeBrowserAuthorizationScopes,
  sensitiveBrowserAuthorizationScopes,
  startCliBrowserCallbackServer,
} from './browserAuth.js'

const credentialId = '0123456789abcdef01234567'
const accessToken =
  // gitleaks:allow -- synthetic fixed-format test credential
  `tg_pat_v2_de_de-nbg-001_${credentialId}_${'a'.repeat(64)}`
const installationId = 'i'.repeat(43)

function requestStatus(url: string, host: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode || 0))
    })
    request.once('error', reject)
    request.end()
  })
}

function authorizationResponse() {
  return new Response(
    JSON.stringify({
      data: {
        attributes: {
          accessToken,
          cellId: 'de-nbg-001',
          expiresAt: '2026-10-29T12:00:00.000Z',
          grantId: 'authorization_request_1234567890',
          region: 'de',
          replayed: false,
          scopes: ['workspace:read', 'tasks:read'],
          tokenType: 'Bearer',
        },
        id: credentialId,
        type: 'cliAuthorization',
      },
      meta: { requestId: 'request-1' },
    }),
    {
      headers: { 'content-type': 'application/vnd.api+json' },
      status: 200,
    },
  )
}

describe('TeamGrid CLI browser authorization', () => {
  it('builds a fragment-only PKCE request and exchanges the callback regionally', async () => {
    const opened: string[] = []
    const statuses: string[] = []
    const requests: Array<{ body: Record<string, unknown>; url: string }> = []
    const result = await loginWithSystemBrowser(
      {
        cliInstallationId: installationId,
        cliVersion: '1.0.1',
        platform: 'darwin',
        scopes: ['workspace:read', 'tasks:read'],
        writeStatus: (message) => statuses.push(message),
      },
      {
        fetch: vi.fn(async (input, init) => {
          requests.push({
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
            url: String(input),
          })
          return authorizationResponse()
        }),
        openBrowser: vi.fn(async (url) => {
          opened.push(url)
        }),
        now: () => new Date('2026-07-31T00:00:00.000Z'),
        randomBytes: (size) => Buffer.alloc(size, 7),
        startCallbackServer: vi.fn(async (_state, callbackPath) => ({
          callback: Promise.resolve({
            authorizationCode: 'z'.repeat(43),
            cellId: 'de-nbg-001',
            region: 'de',
          }),
          close: vi.fn(async () => undefined),
          redirectUri: `http://127.0.0.1:49152${callbackPath}`,
        })),
      },
    )

    expect(result).toMatchObject({
      accessToken,
      cellId: 'de-nbg-001',
      credentialId,
      region: 'de',
    })
    expect(opened).toHaveLength(1)
    const authorizationUrl = new URL(opened[0] || '')
    expect(authorizationUrl.origin).toBe('https://login.teamgrid.app')
    expect(authorizationUrl.search).toBe('')
    const fragment = new URLSearchParams(authorizationUrl.hash.slice(1))
    expect(fragment.get('cli_installation_id')).toBe(installationId)
    expect(fragment.get('code_challenge')).toHaveLength(43)
    expect(fragment.getAll('scope')).toEqual(['workspace:read', 'tasks:read'])
    expect(fragment.get('request_secret')).toHaveLength(43)
    expect(requests).toEqual([
      {
        body: expect.objectContaining({
          authorizationCode: 'z'.repeat(43),
          clientId: 'teamgrid-cli',
          codeVerifier: expect.any(String),
          grantType: 'authorization_code',
        }),
        url: 'https://api.de.teamgrid.app/v1/auth/cli/token',
      },
    ])
    expect(JSON.stringify(statuses)).not.toContain(accessToken)
  })

  it('prints the browser URL only when no-browser is explicit', async () => {
    const statuses: string[] = []
    const openBrowser = vi.fn(async () => undefined)
    await loginWithSystemBrowser(
      {
        cliInstallationId: installationId,
        cliVersion: '1.0.1',
        noBrowser: true,
        platform: 'linux',
        scopes: ['workspace:read', 'tasks:read'],
        writeStatus: (message) => statuses.push(message),
      },
      {
        fetch: vi.fn(async () => authorizationResponse()),
        now: () => new Date('2026-07-31T00:00:00.000Z'),
        openBrowser,
        randomBytes: (size) => Buffer.alloc(size, 9),
        startCallbackServer: vi.fn(async (_state, callbackPath) => ({
          callback: Promise.resolve({
            authorizationCode: 'y'.repeat(43),
            cellId: 'de-nbg-001',
            region: 'de',
          }),
          close: vi.fn(async () => undefined),
          redirectUri: `http://127.0.0.1:49153${callbackPath}`,
        })),
      },
    )
    expect(openBrowser).not.toHaveBeenCalled()
    expect(statuses.join('\n')).toContain('https://login.teamgrid.app/developer/cli/authorize#')
  })

  it('falls back to an explicit URL when the system browser cannot be opened', async () => {
    const statuses: string[] = []
    const result = await loginWithSystemBrowser(
      {
        cliInstallationId: installationId,
        cliVersion: '1.0.1',
        platform: 'darwin',
        scopes: ['workspace:read', 'tasks:read'],
        writeStatus: (message) => statuses.push(message),
      },
      {
        fetch: vi.fn(async () => authorizationResponse()),
        now: () => new Date('2026-07-31T00:00:00.000Z'),
        openBrowser: vi.fn(async () => {
          throw new Error('No default browser')
        }),
        randomBytes: (size) => Buffer.alloc(size, 10),
        startCallbackServer: vi.fn(async (_state, callbackPath) => ({
          callback: Promise.resolve({
            authorizationCode: 'w'.repeat(43),
            cellId: 'de-nbg-001',
            region: 'de',
          }),
          close: vi.fn(async () => undefined),
          redirectUri: `http://127.0.0.1:49155${callbackPath}`,
        })),
      },
    )

    expect(result.credentialId).toBe(credentialId)
    expect(statuses.join('\n')).toContain('could not be opened automatically')
    expect(statuses.join('\n')).toContain('https://login.teamgrid.app/developer/cli/authorize#')
  })

  it('accepts one exact loopback callback and rejects a wrong state first', async () => {
    const state = 's'.repeat(43)
    const callbackPath = `/teamgrid/callback/${'c'.repeat(22)}`
    const callbackServer = await startCliBrowserCallbackServer(state, callbackPath, 5_000)
    try {
      const wrong = await fetch(
        `${callbackServer.redirectUri}?code=${'a'.repeat(43)}` +
          `&state=${'x'.repeat(43)}&region=de&cell_id=de-nbg-001`,
      )
      expect(wrong.status).toBe(400)

      const validRequest = fetch(
        `${callbackServer.redirectUri}?code=${'b'.repeat(43)}` +
          `&state=${state}&region=de&cell_id=de-nbg-001`,
      )
      await expect(callbackServer.callback).resolves.toEqual({
        authorizationCode: 'b'.repeat(43),
        cellId: 'de-nbg-001',
        region: 'de',
      })
      expect((await validRequest).status).toBe(200)
    } finally {
      await callbackServer.close()
    }
  })

  it('rejects wrong callback methods, paths, and hosts without consuming the listener', async () => {
    const state = 's'.repeat(43)
    const callbackPath = `/teamgrid/callback/${'d'.repeat(22)}`
    const callbackServer = await startCliBrowserCallbackServer(state, callbackPath, 5_000)
    const validQuery = `code=${'a'.repeat(43)}&state=${state}&region=de&cell_id=de-nbg-001`
    try {
      const wrongMethod = await fetch(`${callbackServer.redirectUri}?${validQuery}`, {
        method: 'POST',
      })
      expect(wrongMethod.status).toBe(400)

      const wrongPath = await fetch(
        `${new URL(callbackServer.redirectUri).origin}/teamgrid/callback/wrong?${validQuery}`,
      )
      expect(wrongPath.status).toBe(404)

      const callbackUrl = new URL(callbackServer.redirectUri)
      expect(
        await requestStatus(
          `${callbackServer.redirectUri}?${validQuery}`,
          `localhost:${callbackUrl.port}`,
        ),
      ).toBe(400)

      const validRequest = fetch(`${callbackServer.redirectUri}?${validQuery}`)
      await expect(callbackServer.callback).resolves.toEqual({
        authorizationCode: 'a'.repeat(43),
        cellId: 'de-nbg-001',
        region: 'de',
      })
      expect((await validRequest).status).toBe(200)
    } finally {
      await callbackServer.close()
    }
  })

  it('times out an unused loopback callback and closes it cleanly', async () => {
    const callbackServer = await startCliBrowserCallbackServer(
      's'.repeat(43),
      `/teamgrid/callback/${'e'.repeat(22)}`,
      1_000,
    )
    try {
      await expect(callbackServer.callback).rejects.toMatchObject({
        code: 'browser_authorization_timeout',
      })
    } finally {
      await callbackServer.close()
    }
  })

  it('treats SIGINT as a bounded interruption and always closes the listener', async () => {
    const interruption = new AbortController()
    const close = vi.fn(async () => undefined)
    const exchange = vi.fn(async () => authorizationResponse())
    await expect(
      loginWithSystemBrowser(
        {
          cliInstallationId: installationId,
          cliVersion: '1.0.1',
          platform: 'darwin',
          scopes: ['workspace:read'],
          signal: interruption.signal,
          writeStatus: () => undefined,
        },
        {
          fetch: exchange,
          openBrowser: vi.fn(async () => interruption.abort()),
          randomBytes: (size) => Buffer.alloc(size, 11),
          startCallbackServer: vi.fn(async (_state, callbackPath) => ({
            callback: new Promise<never>(() => undefined),
            close,
            redirectUri: `http://127.0.0.1:49156${callbackPath}`,
          })),
        },
      ),
    ).rejects.toMatchObject({ code: 'browser_authorization_interrupted' })
    expect(close).toHaveBeenCalledOnce()
    expect(exchange).not.toHaveBeenCalled()
  })

  it('rejects a token response that broadens the approved scopes', async () => {
    const response = authorizationResponse()
    const document = (await response.json()) as {
      data: { attributes: { scopes: string[] } }
    }
    document.data.attributes.scopes.push('tasks:write')

    await expect(
      loginWithSystemBrowser(
        {
          cliInstallationId: installationId,
          cliVersion: '1.0.1',
          scopes: ['workspace:read', 'tasks:read'],
          writeStatus: () => undefined,
        },
        {
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify(document), {
                headers: { 'content-type': 'application/json' },
                status: 200,
              }),
          ),
          now: () => new Date('2026-07-31T00:00:00.000Z'),
          openBrowser: vi.fn(async () => undefined),
          randomBytes: (size) => Buffer.alloc(size, 8),
          startCallbackServer: vi.fn(async (_state, callbackPath) => ({
            callback: Promise.resolve({
              authorizationCode: 'x'.repeat(43),
              cellId: 'de-nbg-001',
              region: 'de',
            }),
            close: vi.fn(async () => undefined),
            redirectUri: `http://127.0.0.1:49154${callbackPath}`,
          })),
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_api_response' })
  })

  it('keeps scope presets explicit, unique, and bounded', () => {
    expect(normalizeBrowserAuthorizationScopes({ preset: 'read-only' })).toEqual([
      'workspace:read',
      'projects:read',
      'tasks:read',
      'time-entries:read',
    ])
    expect(normalizeBrowserAuthorizationScopes({ preset: 'daily-work' })).toContain('tasks:write')
    expect(
      normalizeBrowserAuthorizationScopes({
        scopes: ['tasks:read', 'tasks:read'],
      }),
    ).toEqual(['tasks:read'])
    expect(() =>
      normalizeBrowserAuthorizationScopes({
        scopes: ['invalid'],
      }),
    ).toThrow('valid TeamGrid scopes')
  })

  it('fails closed for sensitive scopes until browser step-up authentication is available', async () => {
    const contract = JSON.parse(
      await readFile(new URL('../../../../openapi/developer-scopes.json', import.meta.url), 'utf8'),
    ) as { scopes: Array<{ name: string; sensitive?: boolean }> }
    const contractSensitiveScopes = contract.scopes
      .filter((scope) => scope.sensitive === true)
      .map((scope) => scope.name)
      .sort()

    expect([...sensitiveBrowserAuthorizationScopes].sort()).toEqual(contractSensitiveScopes)
    expect(() =>
      normalizeBrowserAuthorizationScopes({
        scopes: ['workspace:read', 'members:read'],
      }),
    ).toThrow('Create a narrowly scoped personal credential')
  })
})
