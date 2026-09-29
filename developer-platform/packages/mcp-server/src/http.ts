import { createMcpHandler } from '@modelcontextprotocol/server'
import type { TeamGridClient } from '@teamgrid/api-client'
import { z } from 'zod'
import { domainWriteTools } from './domainTools.js'
import { createTeamGridMcpServer } from './server.js'
import { enabledMcpTools, type McpToolProfile, parseMcpToolProfile } from './toolProfiles.js'
import { toolScopes } from './toolScopes.js'
import { workWriteTools } from './workTools.js'

const identifier = z.string().min(1).max(128)
const authorizationSchema = z
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
  createDelegatedClient: (authorization: McpAuthorization) => Promise<TeamGridClient>
  now?: () => number
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
        const client = await options.createDelegatedClient(Object.freeze(authorization))
        const workspace = await client.workspace.get()
        if (workspace.data.id !== authorization.workspaceId)
          throw new Error('Wrong delegation workspace')
        return createTeamGridMcpServer(client, {
          toolProfile: profile,
          ...(!options.writesEnabled?.()
            ? { denyTools: [...workWriteTools, ...domainWriteTools] }
            : {}),
          requireGrantedScopes: true,
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
                'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl.href}", scope="workspace:read"${challenge === 'missing' ? '' : `, error="${challenge}"`}`,
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
    if (!(await options.admitRequest(request)))
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' },
      })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
    if (url.pathname === metadataUrl.pathname) {
      if (request.method !== 'GET') return response(405, 'method_not_allowed')
      return Response.json({
        resource: resource.href,
        authorization_servers: [issuer.href],
        scopes_supported: [
          ...new Set(
            enabledMcpTools(profile, {
              ...(!options.writesEnabled?.()
                ? { denyTools: [...workWriteTools, ...domainWriteTools] }
                : {}),
            }).flatMap((name) => toolScopes[name]),
          ),
        ].sort(),
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
    const verified = await options.verifyAccessToken(bearer[1] as string, request.signal)
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
      let result: Response
      try {
        result = await dispatch(request)
      } catch {
        result = response(503, 'temporarily_unavailable')
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
          'WWW-Authenticate, Retry-After, MCP-Protocol-Version',
        )
      }
      return new Response(result.body, { status: result.status, headers })
    },
  }
}
