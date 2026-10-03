import { AsyncLocalStorage } from 'node:async_hooks'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { TeamGridClient } from '@teamgrid/api-client'
import { z } from 'zod'
import { domainWriteTools } from './domainTools.js'
import { createTeamGridMcpServer } from './server.js'
import { usesChatGptToolChallenges } from './toolAuthorization.js'
import { type McpToolProfile, parseMcpToolProfile } from './toolProfiles.js'
import { supportedOAuthScopes } from './toolScopes.js'
import { workWriteTools } from './workTools.js'

/** Valid authority blocked by workspace policy; another login cannot repair it. */
export class McpAccessDeniedError extends Error {}

const initialScopes = ['workspace:read', 'projects:read', 'tasks:read', 'time-entries:read']

/** Safe transport signal: keep the provider's wait time without prompting another login. */
export class McpRateLimitError extends Error {
  readonly retryAfter: string

  constructor(value: string | null = null) {
    super('MCP request quota exceeded.')
    this.retryAfter =
      value &&
      value.length <= 128 &&
      (/^\d+$/.test(value) || /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))
        ? value
        : '60'
  }
}

const identifier = z.string().min(1).max(128)
export const authorizationSchema = z
  .object({
    active: z.literal(true),
    audience: z.string().url(),
    issuer: z.string().url(),
    expiresAt: z.number().int().positive(),
    clientId: z.string().min(1).max(2048),
    subjectId: identifier,
    workspaceId: identifier,
    grantId: identifier,
    region: identifier,
    cellId: identifier,
    scopes: z.array(z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/)).max(128),
  })
  .strict()

export type McpAuthorization = Readonly<z.infer<typeof authorizationSchema>>
export type McpHttpOptions = {
  resourceUrl: string
  issuerUrl: string
  region: string
  cellId: string
  toolProfile?: McpToolProfile
  allowedOrigins?: readonly string[]
  /** Read dynamically so operators can close remote access without a restart. */
  enabled: () => boolean
  /** Required for the work profile; false leaves its context reads available. */
  writesEnabled?: () => boolean
  /** Implement at the regional edge/shared store; false returns 429. */
  admitRequest: (request: Request) => Promise<boolean>
  /** Verify signature/opaque token, current grant, revocation and audience. No caching here. */
  verifyAccessToken: (token: string, signal: AbortSignal) => Promise<unknown>
  /** Exchange the verified grant for a distinct, scoped API delegation. Never forward the MCP token. */
  createDelegatedClient: (
    authorization: McpAuthorization,
    signal: AbortSignal,
  ) => Promise<TeamGridClient>
  /** Entire admission, verification and delegation budget; maximum 30 seconds. */
  requestTimeoutMs?: number
  now?: () => number
}

/** Bound even injected adapters that do not cooperate with cancellation. */
function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Request interrupted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

function httpsUrl(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value
  ) {
    throw new Error(
      'MCP resource and issuer must be canonical HTTPS URLs without credentials, query or fragment.',
    )
  }
  return url
}

/** Transport boundary only. A qualified regional OAuth provider must supply verification and delegation. */
export function createTeamGridMcpHttpHandler(options: McpHttpOptions) {
  const timeoutMs = options.requestTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error('HTTP request timeout must be 1–30000 milliseconds.')
  const requestSignals = new AsyncLocalStorage<AbortSignal>()
  const resource = httpsUrl(options.resourceUrl)
  const issuer = httpsUrl(options.issuerUrl)
  const profile = parseMcpToolProfile(options.toolProfile)
  const metadataUrl = new URL(
    `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`,
    resource.origin,
  )
  const origins = new Set([resource.origin, ...(options.allowedOrigins || [])])
  for (const origin of origins) {
    if (new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:')
      throw new Error('Allowed origins must be exact HTTPS origins.')
  }
  const handler = createMcpHandler(
    async (context) => {
      const authorization = authorizationSchema.parse(context.authInfo?.extra?.authorization)
      try {
        const signal = requestSignals.getStore()
        if (!signal) throw new Error('Missing request lifetime')
        const client = await withinSignal(
          options.createDelegatedClient(Object.freeze(authorization), signal),
          signal,
        )
        signal.throwIfAborted()
        const workspace = await withinSignal(client.workspace.get({ signal }), signal)
        if (workspace.data.id !== authorization.workspaceId)
          throw new Error('Wrong delegation workspace')
        return createTeamGridMcpServer(client, {
          toolProfile: profile,
          ...(!options.writesEnabled?.()
            ? { denyTools: [...workWriteTools, ...domainWriteTools] }
            : {}),
          requireGrantedScopes: true,
          scopeChallengeTransport: usesChatGptToolChallenges(authorization.clientId)
            ? 'tool-result'
            : 'http',
        })
      } catch {
        throw new Error('MCP delegation is unavailable.')
      }
    },
    {
      legacy: 'stateless',
      responseMode: 'auto',
      maxRequestBodySize: 8 * 1024 * 1024,
      maxSubscriptions: 0,
    },
  )

  function response(status: number, error: string, challenge?: string) {
    return Response.json(
      { error },
      {
        status,
        headers: {
          'Cache-Control': 'no-store',
          ...(challenge
            ? {
                'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl.href}", scope="${initialScopes.join(' ')}"${challenge === 'missing' ? '' : `, error="${challenge}"`}`,
              }
            : {}),
        },
      },
    )
  }

  async function dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (
      url.origin !== resource.origin ||
      (request.headers.has('host') && request.headers.get('host') !== resource.host)
    )
      return response(421, 'wrong_host')
    const origin = request.headers.get('origin')
    if (origin && !origins.has(origin)) return response(403, 'origin_not_allowed')
    if (url.searchParams.has('access_token') || url.username || url.password)
      return response(400, 'invalid_request')
    if (url.pathname !== resource.pathname && url.pathname !== metadataUrl.pathname)
      return response(404, 'not_found')
    if (!options.enabled()) return response(503, 'remote_mcp_disabled')
    if (!(await withinSignal(options.admitRequest(request), request.signal)))
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
      })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
    if (url.pathname === metadataUrl.pathname) {
      if (request.method !== 'GET') return response(405, 'method_not_allowed')
      return Response.json({
        resource: resource.href,
        authorization_servers: [issuer.href],
        // The catalog describes support, not a request for every permission.
        // The initial 401 explicitly requests basic reads; tools request precise additions.
        scopes_supported: [...supportedOAuthScopes],
        bearer_methods_supported: ['header'],
      })
    }
    if (request.method !== 'POST') return response(405, 'method_not_allowed')
    const bearer = request.headers.get('authorization')?.match(/^Bearer ([\x21-\x7e]{1,8192})$/i)
    if (!bearer) return response(401, 'authentication_required', 'missing')
    // Native API secrets have a separate audience and must never authenticate remote MCP.
    if (/^tg_(?:pat|sa|sk)_v[0-9]_/.test(bearer[1] || ''))
      return response(401, 'invalid_token', 'invalid_token')
    // Verifier outages are 503, not an invalid-token prompt that encourages
    // users to create another connection. Invalid/revoked tokens return null.
    const verified = await withinSignal(
      options.verifyAccessToken(bearer[1] as string, request.signal),
      request.signal,
    )
    const parsed = authorizationSchema.safeParse(verified)
    if (!parsed.success) return response(401, 'invalid_token', 'invalid_token')
    const authorization = parsed.data
    if (
      authorization.audience !== resource.href ||
      authorization.issuer !== issuer.href ||
      authorization.region !== options.region ||
      authorization.cellId !== options.cellId ||
      authorization.expiresAt <= Math.floor((options.now?.() ?? Date.now()) / 1000)
    ) {
      return response(401, 'invalid_token', 'invalid_token')
    }
    if (!authorization.scopes.includes('workspace:read')) {
      return Response.json(
        { error: 'insufficient_scope' },
        {
          status: 403,
          headers: {
            'WWW-Authenticate': `Bearer error="insufficient_scope", resource_metadata="${metadataUrl.href}", scope="workspace:read"`,
          },
        },
      )
    }
    return handler.fetch(request, {
      authInfo: {
        token: bearer[1] as string,
        clientId: authorization.clientId,
        scopes: [...authorization.scopes],
        expiresAt: authorization.expiresAt,
        resource,
        resourceMetadataUrl: metadataUrl.href,
        extra: { authorization },
      },
    })
  }

  return {
    close: () => handler.close(),
    fetch: async (request: Request) => {
      const deadline = new AbortController()
      const signal = AbortSignal.any([request.signal, deadline.signal])
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      timer.unref?.()
      let result: Response
      try {
        result = await requestSignals.run(signal, () =>
          withinSignal(dispatch(new Request(request, { signal })), signal),
        )
      } catch (error) {
        result =
          error instanceof McpAccessDeniedError && !signal.aborted
            ? response(403, 'access_denied')
            : error instanceof McpRateLimitError && !signal.aborted
              ? Response.json(
                  { error: 'rate_limited' },
                  {
                    status: 429,
                    headers: { 'Retry-After': error.retryAfter },
                  },
                )
              : response(503, signal.aborted ? 'request_interrupted' : 'temporarily_unavailable')
      } finally {
        clearTimeout(timer)
      }
      const headers = new Headers(result.headers)
      headers.set('Cache-Control', 'no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Vary', 'Origin, Authorization')
      const origin = request.headers.get('origin')
      if (origin && origins.has(origin)) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        headers.set(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, MCP-Protocol-Version, MCP-Method, Mcp-Name',
        )
        headers.set(
          'Access-Control-Expose-Headers',
          'WWW-Authenticate, Retry-After, MCP-Protocol-Version, X-Request-Id',
        )
      }
      return new Response(result.body, { status: result.status, headers })
    },
  }
}
