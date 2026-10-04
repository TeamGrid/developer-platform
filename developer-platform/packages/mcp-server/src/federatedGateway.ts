import { createHash } from 'node:crypto'
import { createRegionalMcpGateway, type RegionalMcpGatewayOptions } from './gateway.js'
import { createTeamGridMcpHttpHandler, withinSignal } from './http.js'
import { bufferMcpHttpResponse } from './httpResponse.js'

export type FederatedMcpCell = Pick<
  RegionalMcpGatewayOptions,
  'region' | 'cellId' | 'apiBaseUrl' | 'apiOriginSecret' | 'serviceSecret'
> & { providerUrl: string }

export type FederatedMcpGatewayOptions = Omit<
  RegionalMcpGatewayOptions,
  'region' | 'cellId' | 'apiBaseUrl' | 'apiOriginSecret' | 'serviceSecret' | 'providerUrl'
> & {
  cells: readonly FederatedMcpCell[]
  /** Strongly consistent access-hash lookup, bound to this issuer/resource. Never supplies authority. */
  resolveAccessTokenCell(tokenHash: string, signal: AbortSignal): Promise<string | null>
}

/** One public identity; each bearer reaches at most one fixed regional provider. */
export function createFederatedMcpGateway(options: FederatedMcpGatewayOptions) {
  if (
    !Array.isArray(options.cells) ||
    options.cells.length < 1 ||
    options.cells.length > 16 ||
    options.cells.some(
      (cell) =>
        !cell ||
        typeof cell !== 'object' ||
        Array.isArray(cell) ||
        Object.keys(cell).some(
          (key) =>
            ![
              'region',
              'cellId',
              'apiBaseUrl',
              'apiOriginSecret',
              'serviceSecret',
              'providerUrl',
            ].includes(key),
        ),
    ) ||
    new Set(options.cells.map((cell) => cell.cellId)).size !== options.cells.length ||
    new Set(options.cells.map((cell) => cell.providerUrl)).size !== options.cells.length ||
    options.cells.some(
      (cell) =>
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cell.cellId) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cell.region),
    )
  )
    throw new Error('Invalid federated MCP cell registry.')
  for (const cell of options.cells) {
    const provider = new URL(cell.providerUrl)
    if (
      !/^\/internal\/developer\/oauth\/integrations\/(?!regional\/)[a-z][a-z0-9-]{0,31}\/access$/.test(
        provider.pathname,
      )
    ) {
      throw new Error('Federated cells require an additional OAuth integration endpoint.')
    }
  }
  const timeout = options.requestTimeoutMs ?? 30_000
  // The fallback owns public discovery and all normal HTTP rejection rules. It has no API client.
  const fallback = createTeamGridMcpHttpHandler({
    ...options,
    region: 'unrouted',
    cellId: 'unrouted',
    verifyAccessToken: async () => null,
    createDelegatedClient: async () => {
      throw new Error('No authorized regional route.')
    },
  })
  const cells = new Map(
    options.cells.map((cell) => [
      cell.cellId,
      createRegionalMcpGateway({ ...options, ...cell, admitRequest: async () => true }),
    ]),
  )
  const resource = new URL(options.resourceUrl)
  const metadataUrl = new URL(
    `/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`,
    resource.origin,
  )
  const origins = new Set([resource.origin, ...(options.allowedOrigins ?? [])])
  const publicResponse = (request: Request, result: Response) => {
    const headers = new Headers(result.headers)
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
  }
  const response = (request: Request, status: number, error: string) =>
    publicResponse(
      request,
      Response.json(
        { error },
        {
          status,
          headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        },
      ),
    )

  function bearerForRouting(request: Request) {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')
    if (
      url.origin !== resource.origin ||
      url.pathname !== resource.pathname ||
      url.username ||
      url.password ||
      url.searchParams.has('access_token') ||
      (request.headers.has('host') && request.headers.get('host') !== resource.host) ||
      (origin && !origins.has(origin)) ||
      request.method !== 'POST'
    )
      return null
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    return token && /^tg_mcp_at_v1_[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  }

  return {
    close: async () => {
      await Promise.all([fallback.close(), ...[...cells.values()].map((cell) => cell.close())])
    },
    fetch: async (request: Request): Promise<Response> => {
      const token = bearerForRouting(request)
      if (!token) return fallback.fetch(request)
      const deadline = new AbortController()
      const signal = AbortSignal.any([request.signal, deadline.signal])
      const timer = setTimeout(() => deadline.abort(), timeout)
      timer.unref?.()
      try {
        const incoming = new Request(request, { signal })
        if (!options.enabled()) return await fallback.fetch(incoming)
        if (!(await withinSignal(options.admitRequest(incoming), signal))) {
          return publicResponse(
            request,
            new Response(null, {
              status: 429,
              headers: {
                'Retry-After': '60',
                'Cache-Control': 'no-store',
              },
            }),
          )
        }
        const hash = createHash('sha256').update(token).digest('hex')
        const cellId = await withinSignal(options.resolveAccessTokenCell(hash, signal), signal)
        signal.throwIfAborted()
        if (cellId === null) {
          return publicResponse(
            request,
            Response.json(
              { error: 'invalid_token' },
              {
                status: 401,
                headers: {
                  'Cache-Control': 'no-store',
                  'X-Content-Type-Options': 'nosniff',
                  'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${metadataUrl.href}"`,
                },
              },
            ),
          )
        }
        const cell = cells.get(cellId)
        if (!cell) throw new Error('Unknown regional route.')
        const result = await withinSignal(cell.fetch(incoming), signal)
        // Stateless SSE can return headers before a tool completes. Keep the routing
        // deadline active through completion for every host, including OpenAI.
        return await withinSignal(bufferMcpHttpResponse(result, signal), signal)
      } catch {
        return response(
          request,
          503,
          signal.aborted ? 'request_interrupted' : 'temporarily_unavailable',
        )
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
