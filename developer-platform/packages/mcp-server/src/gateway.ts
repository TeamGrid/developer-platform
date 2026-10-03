import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { parseCredentialLocation, TeamGridClient } from '@teamgrid/api-client'
import { z } from 'zod'
import {
  authorizationSchema,
  createTeamGridMcpHttpHandler,
  McpAccessDeniedError,
  type McpHttpOptions,
  McpRateLimitError,
} from './http.js'

const delegationSchema = z
  .object({
    token: z.string().regex(/^tg_oa_v2_[a-z0-9-]+_[a-z0-9-]+_[a-f0-9]{24}_[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(),
    scopes: z.array(z.string()).min(1).max(128),
    workspaceId: z.string().min(1).max(128),
  })
  .strict()
const providerSchema = z
  .object({
    authorization: authorizationSchema,
    delegation: delegationSchema,
  })
  .strict()
export type ProviderResult = z.infer<typeof providerSchema>

export type RegionalMcpGatewayOptions = Omit<
  McpHttpOptions,
  'verifyAccessToken' | 'createDelegatedClient'
> & {
  /** Fixed regional App issuer owns introspection and delegation. No client-provided URLs. */
  serviceSecret: string
  apiBaseUrl: string
  apiOriginSecret?: string
  fetch?: typeof fetch
  observe?(event: {
    event: 'teamgrid.mcp.request'
    requestId: string
    region: string
    cellId: string
    statusCode: number
    durationMs: number
  }): void
}

function canonicalHttps(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  )
    throw new Error('Gateway URLs must be canonical HTTPS URLs.')
  return url
}

async function boundedProviderJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('OAuth provider unavailable.')
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 32768) {
        abort()
        throw new Error('OAuth provider unavailable.')
      }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

/** Regional provider integration. Each HTTP request owns its own temporary delegation. */
export function createRegionalMcpGateway(options: RegionalMcpGatewayOptions) {
  const issuer = canonicalHttps(options.issuerUrl)
  const api = canonicalHttps(options.apiBaseUrl)
  if (
    issuer.pathname !== '/' ||
    api.pathname !== '/v1' ||
    options.serviceSecret.length < 32 ||
    options.serviceSecret.length > 256
  ) {
    throw new Error('Invalid regional MCP gateway configuration.')
  }
  const provider = new URL('/internal/developer/oauth/access', issuer)
  const fetcher = options.fetch ?? fetch
  const requests = new AsyncLocalStorage<{ requestId: string; verified?: ProviderResult }>()
  const handler = createTeamGridMcpHttpHandler({
    ...options,
    async verifyAccessToken(token, signal) {
      if (!/^tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/.test(token)) return null
      const current = requests.getStore()
      if (!current) throw new Error('Missing gateway request context.')
      const response = await fetcher(provider, {
        method: 'POST',
        signal,
        redirect: 'error',
        credentials: 'omit',
        headers: {
          Authorization: `Bearer ${options.serviceSecret}`,
          'Content-Type': 'application/json',
          'X-Request-Id': current.requestId,
        },
        body: JSON.stringify({ access_token: token }),
      })
      if (!response.ok) {
        if (response.status === 429) {
          void response.body?.cancel().catch(() => {})
          throw new McpRateLimitError(response.headers.get('retry-after'))
        }
        if (response.status === 403) {
          const error = await boundedProviderJson(response, signal)
          if (
            error &&
            typeof error === 'object' &&
            'error' in error &&
            error.error === 'access_denied'
          )
            throw new McpAccessDeniedError('Workspace access is unavailable.')
        }
        if (response.status === 400) {
          const error = await boundedProviderJson(response, signal)
          if (
            error &&
            typeof error === 'object' &&
            'error' in error &&
            error.error === 'invalid_grant'
          )
            return null
        } else void response.body?.cancel().catch(() => {})
        throw new Error('OAuth provider unavailable.')
      }
      const verified = providerSchema.parse(await boundedProviderJson(response, signal))
      const { authorization, delegation } = verified
      const location = parseCredentialLocation(delegation.token)
      const now = options.now?.() ?? Date.now()
      if (
        authorization.issuer !== options.issuerUrl ||
        authorization.audience !== options.resourceUrl ||
        authorization.region !== options.region ||
        authorization.cellId !== options.cellId ||
        location.region !== authorization.region ||
        location.cellId !== authorization.cellId ||
        delegation.workspaceId !== authorization.workspaceId ||
        Date.parse(delegation.expiresAt) <= now ||
        Math.floor(Date.parse(delegation.expiresAt) / 1000) > authorization.expiresAt ||
        JSON.stringify([...new Set(delegation.scopes)].sort()) !==
          JSON.stringify([...new Set(authorization.scopes)].sort())
      ) {
        throw new Error('OAuth delegation binding mismatch.')
      }
      current.verified = verified
      return authorization
    },
    async createDelegatedClient(authorization, signal) {
      const verified = requests.getStore()?.verified
      if (!verified || JSON.stringify(verified.authorization) !== JSON.stringify(authorization)) {
        throw new Error('OAuth delegation is unavailable.')
      }
      signal.throwIfAborted()
      const token = verified.delegation.token
      return new TeamGridClient({
        token,
        baseUrl: api.href,
        requireResourceCas: true,
        requestContext: () => ({ signal, requestId: requests.getStore()?.requestId }),
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (
            url.origin !== api.origin ||
            !(url.pathname === '/v1' || url.pathname.startsWith('/v1/'))
          ) {
            throw new Error('Delegation may only access the configured regional API.')
          }
          const headers = new Headers(init?.headers)
          if (options.apiOriginSecret)
            headers.set('X-TeamGrid-Edge-Origin-Authorization', options.apiOriginSecret)
          return fetcher(input, { ...init, headers, credentials: 'omit', redirect: 'error' })
        },
      })
    },
  })
  return {
    close: () => handler.close(),
    fetch: (request: Request) => {
      const requestId = `mcp-${randomUUID()}`
      const start = performance.now()
      return requests.run({ requestId }, async () => {
        const response = await handler.fetch(request)
        const headers = new Headers(response.headers)
        headers.set('X-Request-Id', requestId)
        try {
          options.observe?.({
            event: 'teamgrid.mcp.request',
            requestId,
            region: options.region,
            cellId: options.cellId,
            statusCode: response.status,
            durationMs: Math.round(performance.now() - start),
          })
        } catch {
          // Telemetry cannot affect authorization or request delivery.
        }
        return new Response(response.body, { status: response.status, headers })
      })
    },
  }
}
