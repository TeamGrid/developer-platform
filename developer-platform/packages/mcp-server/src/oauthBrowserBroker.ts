import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { withinSignal } from './http.js'
import {
  OAUTH_BROWSER_TTL_MS,
  type OAuthBrowserRecord,
  type OAuthBrowserStore,
  oauthBrowserHash,
} from './oauthBrowserStore.js'
import {
  type OAuthRoutingDirectory,
  oauthRoutingRecordId,
  oauthRoutingRecordSchema,
} from './oauthRoutingDirectory.js'
import {
  type FederatedOAuthBrokerCell,
  OAuthBrokerInvalidClientError,
  readOAuthBrokerText,
} from './oauthTokenBroker.js'

export const OAUTH_BROWSER_SERVICE_HEADER = 'X-TeamGrid-OAuth-Browser-Service-Authorization'
export const OAUTH_BROWSER_CONTEXT_HEADER = 'X-TeamGrid-OAuth-Browser-Context'
const opaque = /^[A-Za-z0-9_-]{43}$/
const headers = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
}
const clientSchema = z.object({
  _id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  clientId: z.string().min(1).max(2048),
  name: z.string().min(1).max(160),
  status: z.enum(['active', 'revoked']),
  redirectUris: z.array(z.string().max(2048)).min(1).max(10),
})
export type OAuthBrowserClient = z.infer<typeof clientSchema>
const wireRoute = oauthRoutingRecordSchema.extend({
  createdAt: z.iso.datetime().transform((value) => new Date(value)),
  expiresAt: z.iso.datetime().transform((value) => new Date(value)),
})
const decisionSchema = z
  .object({
    requestId: z.string().regex(opaque),
    browserHash: z.string().regex(/^[a-f0-9]{64}$/),
    issuer: z.string(),
    resource: z.string(),
    region: z.string(),
    cellId: z.string(),
    clientId: z.string(),
    clientRecordId: z.string(),
    redirectUri: z.string(),
    codeChallenge: z.string(),
    requestedScopes: z.array(z.string()),
    state: z.string().optional(),
    workspaceId: z.string(),
    status: z.enum(['approved', 'denied']),
    codeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    codeExpiresAt: z.iso
      .datetime()
      .transform((value) => new Date(value))
      .optional(),
    route: wireRoute.optional(),
  })
  .strict()
class BrowserRequestError extends Error {
  constructor(readonly code = 'invalid_request') {
    super(code)
  }
}
function canonicalHttps(value: string, root = false) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value ||
    (root && url.pathname !== '/')
  )
    throw new Error('Invalid OAuth browser configuration.')
  return url
}
function redirect(value: string) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.href !== value ||
    value.includes('*') ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  )
    throw new BrowserRequestError('invalid_redirect_uri')
  return url
}
function matchesRedirect(client: OAuthBrowserClient, value: string) {
  const requested = redirect(value)
  return client.redirectUris.some((registered) => {
    const candidate = redirect(registered)
    if (registered === value) return true
    if (requested.protocol !== 'http:' || candidate.protocol !== 'http:') return false
    candidate.port = requested.port
    return candidate.href === value
  })
}
function parameters(query: URLSearchParams) {
  const result: Record<string, string> = Object.create(null)
  for (const [key, value] of query) {
    if (Object.hasOwn(result, key)) throw new BrowserRequestError()
    result[key] = value
  }
  return result
}
const cookieName = (handle: string) =>
  `__Host-teamgrid-oauth-${oauthBrowserHash(handle).slice(0, 24)}`

/** Full browser transaction: validated request, authenticated selection, regional consent and code publication. */
export function createFederatedOAuthBrowserBroker(options: {
  issuer: string
  resource: string
  scopes: readonly string[]
  cells: readonly FederatedOAuthBrokerCell[]
  selectionUiOrigin: string
  workspaceRootDomain: string
  selectionServiceSecret: string
  store: OAuthBrowserStore
  directory: OAuthRoutingDirectory
  client(clientId: string, signal: AbortSignal): Promise<OAuthBrowserClient>
  enabled(): boolean
  admit(request: Request): Promise<boolean>
  fetch?: typeof fetch
  now?: () => Date
  requestTimeoutMs?: number
}) {
  const issuer = canonicalHttps(options.issuer, true)
  canonicalHttps(options.resource)
  canonicalHttps(options.selectionUiOrigin, true)
  if (
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(options.workspaceRootDomain) ||
    options.selectionServiceSecret.length < 32 ||
    options.selectionServiceSecret.length > 256 ||
    !options.scopes.includes('workspace:read')
  )
    throw new Error('Invalid OAuth browser policy.')
  const cells = new Map(
    options.cells.map((value) => {
      const cell = { ...value },
        provider = canonicalHttps(cell.providerBaseUrl)
      if (
        !/^\/internal\/developer\/oauth\/integrations\/(?!regional\/)[a-z][a-z0-9-]{0,31}\/$/.test(
          provider.pathname,
        ) ||
        ![cell.region, cell.cellId].every((item) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(item)) ||
        cell.serviceSecret.length < 32 ||
        cell.serviceSecret.length > 256
      )
        throw new Error('Invalid OAuth browser cell.')
      return [cell.cellId, cell] as const
    }),
  )
  if (
    cells.size < 1 ||
    cells.size > 16 ||
    cells.size !== options.cells.length ||
    new Set([...cells.values()].map((cell) => cell.providerBaseUrl)).size !== cells.size
  ) {
    throw new Error('Invalid OAuth browser cell registry.')
  }
  const timeout = options.requestTimeoutMs ?? 30000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000)
    throw new Error('Invalid OAuth browser deadline.')
  const now = options.now ?? (() => new Date()),
    fetcher = options.fetch ?? fetch
  const scopeCeiling = new Set(options.scopes)
  const json = (status: number, code: string) => Response.json({ error: code }, { status, headers })
  const navigate = (location: string, extra: Record<string, string> = {}) =>
    new Response(null, {
      status: 303,
      headers: { ...headers, ...extra, Location: location },
    })
  const liveClient = async (
    record: Pick<OAuthBrowserRecord, 'clientId' | 'clientRecordId' | 'redirectUri'>,
    signal: AbortSignal,
  ) => {
    const client = clientSchema.parse(
      await withinSignal(options.client(record.clientId, signal), signal),
    )
    if (
      client.status !== 'active' ||
      client.clientId !== record.clientId ||
      client._id !== record.clientRecordId ||
      !matchesRedirect(client, record.redirectUri)
    ) {
      throw new OAuthBrokerInvalidClientError()
    }
    return client
  }
  const read = async (handle: string, signal: AbortSignal) => {
    if (!opaque.test(handle)) throw new BrowserRequestError()
    const record = await withinSignal(options.store.read(oauthBrowserHash(handle), signal), signal)
    if (
      !record ||
      record._id !== oauthBrowserHash(handle) ||
      record.issuer !== options.issuer ||
      record.resource !== options.resource ||
      +record.createdAt > +now() ||
      +record.expiresAt <= +now() ||
      record.scopes.some((scope) => !scopeCeiling.has(scope))
    )
      throw new BrowserRequestError('invalid_grant')
    return record
  }
  const checkBrowser = (request: Request, handle: string, record: OAuthBrowserRecord) => {
    const cookie = request.headers.get('cookie') ?? ''
    if (cookie.length > 16384) throw new BrowserRequestError()
    const matches = cookie
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name]) => name === cookieName(handle))
    const matched = matches[0],
      cookieValue = matched?.[1] ?? ''
    if (
      matches.length !== 1 ||
      matched?.length !== 2 ||
      !opaque.test(cookieValue) ||
      oauthBrowserHash(cookieValue) !== record.browserHash
    )
      throw new BrowserRequestError('invalid_grant')
  }
  const provider = async (
    record: OAuthBrowserRecord,
    operation: string,
    init: RequestInit,
    signal: AbortSignal,
  ) => {
    const cell = record.selection && cells.get(record.selection.cellId)
    if (!cell || cell.region !== record.selection?.region)
      throw new Error('OAuth browser provider unavailable.')
    const stage = AbortSignal.any([signal, AbortSignal.timeout(5000)])
    const response = await withinSignal(
      fetcher(new URL(operation, cell.providerBaseUrl), {
        ...init,
        redirect: 'error',
        signal: stage,
        headers: {
          ...init.headers,
          'X-TeamGrid-OAuth-Service-Authorization': `Bearer ${cell.serviceSecret}`,
        },
      }),
      stage,
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if ([400, 401, 403, 404].includes(response.status))
        throw new BrowserRequestError('invalid_grant')
      throw new Error('OAuth browser provider unavailable.')
    }
    return JSON.parse(await readOAuthBrokerText(response.body, stage)) as unknown
  }
  return async (request: Request) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeout)])
    try {
      const url = new URL(request.url)
      const internal = url.pathname.startsWith('/internal/oauth/browser/')
      if (
        url.origin !== issuer.origin ||
        url.username ||
        url.password ||
        url.hash ||
        (request.headers.has('host') && request.headers.get('host') !== issuer.host)
      )
        return json(421, 'invalid_request')
      if (
        ![
          '/oauth/authorize',
          '/oauth/continue',
          '/oauth/resume',
          '/internal/oauth/browser/details',
          '/internal/oauth/browser/select',
        ].includes(url.pathname)
      )
        return json(404, 'invalid_request')
      if (!options.enabled()) return json(503, 'temporarily_unavailable')
      if (internal) {
        const candidate = request.headers.get(OAUTH_BROWSER_SERVICE_HEADER) ?? ''
        if (
          candidate.length > 512 ||
          !timingSafeEqual(
            Buffer.from(oauthBrowserHash(candidate), 'hex'),
            Buffer.from(oauthBrowserHash(`Bearer ${options.selectionServiceSecret}`), 'hex'),
          )
        )
          return json(401, 'invalid_client')
      } else if (
        request.headers.has(OAUTH_BROWSER_SERVICE_HEADER) ||
        request.headers.has(OAUTH_BROWSER_CONTEXT_HEADER) ||
        request.headers.has('authorization')
      )
        return json(400, 'invalid_request')
      if (!(await withinSignal(options.admit(request), signal)))
        return new Response(null, {
          status: 429,
          headers: { ...headers, 'Retry-After': '60' },
        })
      if (internal) {
        if (request.method !== 'POST' || url.search) return json(405, 'invalid_request')
        if (
          request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return json(415, 'invalid_request')
        let input: unknown
        try {
          input = JSON.parse(await readOAuthBrokerText(request.body, signal))
        } catch {
          throw new BrowserRequestError()
        }
        const fields = url.pathname.endsWith('/details')
          ? ['requestId']
          : ['requestId', 'cellId', 'workspaceId', 'workspaceSlug']
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length !== fields.length ||
          Object.keys(input).some((key) => !fields.includes(key)) ||
          Object.values(input).some((value) => typeof value !== 'string')
        )
          throw new BrowserRequestError()
        const values = input as {
            requestId: string
            cellId?: string
            workspaceId?: string
            workspaceSlug?: string
          },
          record = await read(values.requestId, signal)
        const client = await liveClient(record, signal)
        if (record.status !== 'selecting') throw new BrowserRequestError('invalid_grant')
        if (url.pathname.endsWith('/details'))
          return Response.json(
            {
              issuer: options.issuer,
              clientName: client.name,
              redirectOrigin: new URL(record.redirectUri).origin,
              scopes: record.scopes,
              expiresAt: record.expiresAt,
            },
            { headers },
          )
        const workspaceId = values.workspaceId ?? '',
          workspaceSlug = values.workspaceSlug ?? ''
        const cell = cells.get(values.cellId ?? '')
        if (
          !cell ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(workspaceId) ||
          !/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspaceSlug)
        )
          throw new BrowserRequestError()
        const ticket = randomBytes(32).toString('base64url')
        const selected: OAuthBrowserRecord = {
          ...record,
          status: 'selected',
          selection: {
            cellId: cell.cellId,
            region: cell.region,
            workspaceId,
            workspaceSlug,
            ticketHash: oauthBrowserHash(ticket),
          },
        }
        if (!(await withinSignal(options.store.transition(record, selected, signal), signal)))
          throw new BrowserRequestError('invalid_grant')
        const target = new URL('/oauth/continue', issuer)
        target.search = new URLSearchParams({
          request: values.requestId,
          selection: ticket,
        }).toString()
        return Response.json({ continueUrl: target.href }, { headers })
      }
      if (request.method !== 'GET') return json(405, 'invalid_request')
      if (url.search.length > 8192) throw new BrowserRequestError()
      const query = parameters(url.searchParams)
      if (url.pathname === '/oauth/authorize') {
        if (
          ['client_secret', 'access_token', 'refresh_token', 'code', 'code_verifier'].some((key) =>
            Object.hasOwn(query, key),
          )
        )
          throw new BrowserRequestError()
        const client = clientSchema.parse(
          await withinSignal(options.client(query.client_id ?? '', signal), signal),
        )
        if (client.status !== 'active' || client.clientId !== query.client_id)
          throw new OAuthBrokerInvalidClientError()
        if (query.response_type !== 'code')
          throw new BrowserRequestError('unsupported_response_type')
        if (query.resource !== options.resource) throw new BrowserRequestError('invalid_target')
        if (!query.redirect_uri || !matchesRedirect(client, query.redirect_uri))
          throw new BrowserRequestError('invalid_redirect_uri')
        if (query.code_challenge_method !== 'S256' || !opaque.test(query.code_challenge ?? ''))
          throw new BrowserRequestError()
        const rawScopes = query.scope ?? 'workspace:read',
          scopes = [...new Set(rawScopes.split(' '))].sort()
        if (
          !rawScopes ||
          rawScopes.length > 4096 ||
          scopes.length > 100 ||
          !scopes.includes('workspace:read') ||
          scopes.some((scope) => !scopeCeiling.has(scope))
        )
          throw new BrowserRequestError('invalid_scope')
        if (
          query.state !== undefined &&
          (query.state.length > 2048 ||
            Array.from(query.state).some((character) => character < ' ' || character === '\u007f'))
        )
          throw new BrowserRequestError()
        const handle = randomBytes(32).toString('base64url'),
          cookie = randomBytes(32).toString('base64url')
        const time = now()
        if (!Number.isFinite(+time)) throw new Error('OAuth browser clock unavailable.')
        await withinSignal(
          options.store.insert(
            {
              _id: oauthBrowserHash(handle),
              issuer: options.issuer,
              resource: options.resource,
              browserHash: oauthBrowserHash(cookie),
              clientId: client.clientId,
              clientRecordId: client._id,
              clientName: client.name,
              redirectUri: query.redirect_uri,
              codeChallenge: query.code_challenge ?? '',
              scopes,
              createdAt: time,
              expiresAt: new Date(+time + OAUTH_BROWSER_TTL_MS),
              status: 'selecting',
              ...(query.state === undefined ? {} : { state: query.state }),
            },
            signal,
          ),
          signal,
        )
        const selection = new URL('/developer/oauth/authorize', options.selectionUiOrigin)
        selection.searchParams.set('federation', handle)
        return navigate(selection.href, {
          'Set-Cookie': `${cookieName(handle)}=${cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
        })
      }
      const allowed =
        url.pathname === '/oauth/continue' ? ['request', 'selection'] : ['request', 'code', 'error']
      if (Object.keys(query).some((key) => !allowed.includes(key))) throw new BrowserRequestError()
      const handle = query.request ?? '',
        record = await read(handle, signal)
      checkBrowser(request, handle, record)
      await liveClient(record, signal)
      if (!record.selection) throw new BrowserRequestError('invalid_grant')
      if (url.pathname === '/oauth/continue') {
        if (
          !opaque.test(query.selection ?? '') ||
          oauthBrowserHash(query.selection ?? '') !== record.selection.ticketHash ||
          !['selected', 'prepared'].includes(record.status)
        )
          throw new BrowserRequestError('invalid_grant')
        const context = {
          requestId: handle,
          browserHash: record.browserHash,
          workspaceId: record.selection.workspaceId,
          createdAt: record.createdAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
        }
        const authQuery = new URLSearchParams({
          client_id: record.clientId,
          response_type: 'code',
          redirect_uri: record.redirectUri,
          resource: record.resource,
          scope: record.scopes.join(' '),
          code_challenge: record.codeChallenge,
          code_challenge_method: 'S256',
          ...(record.state === undefined ? {} : { state: record.state }),
        })
        const prepared = await provider(
          record,
          `authorize?${authQuery}`,
          {
            method: 'GET',
            headers: { [OAUTH_BROWSER_CONTEXT_HEADER]: JSON.stringify(context) },
          },
          signal,
        )
        if (
          !prepared ||
          typeof prepared !== 'object' ||
          JSON.stringify(Object.keys(prepared).sort()) !==
            JSON.stringify(['cellId', 'clientRecordId', 'region', 'requestId'].sort())
        )
          throw new Error('Invalid OAuth preparation.')
        const result = prepared as Record<string, string>
        if (
          result.requestId !== handle ||
          result.cellId !== record.selection.cellId ||
          result.region !== record.selection.region ||
          result.clientRecordId !== record.clientRecordId
        )
          throw new Error('Invalid OAuth preparation binding.')
        if (
          record.status === 'selected' &&
          !(await withinSignal(
            options.store.transition(record, { ...record, status: 'prepared' }, signal),
            signal,
          ))
        ) {
          const fresh = await read(handle, signal)
          if (
            fresh.status !== 'prepared' ||
            fresh.browserHash !== record.browserHash ||
            JSON.stringify(fresh.selection) !== JSON.stringify(record.selection)
          )
            throw new BrowserRequestError('invalid_grant')
        }
        const consent = new URL(
          `https://${record.selection.workspaceSlug}.${options.workspaceRootDomain}/developer/oauth/authorize`,
        )
        consent.search = new URLSearchParams({
          request: handle,
          region: record.selection.region,
          cell: record.selection.cellId,
        }).toString()
        return navigate(consent.href)
      }
      if (
        !['prepared', 'completed'].includes(record.status) ||
        !!query.code === !!query.error ||
        (query.error && query.error !== 'access_denied') ||
        (query.code && !opaque.test(query.code))
      )
        throw new BrowserRequestError('invalid_grant')
      const decision = decisionSchema.parse(
        await provider(
          record,
          'decision',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id: handle, browser_hash: record.browserHash }),
          },
          signal,
        ),
      )
      if (
        decision.requestId !== handle ||
        decision.browserHash !== record.browserHash ||
        decision.issuer !== record.issuer ||
        decision.resource !== record.resource ||
        decision.cellId !== record.selection.cellId ||
        decision.region !== record.selection.region ||
        decision.workspaceId !== record.selection.workspaceId ||
        decision.clientId !== record.clientId ||
        decision.clientRecordId !== record.clientRecordId ||
        decision.redirectUri !== record.redirectUri ||
        decision.codeChallenge !== record.codeChallenge ||
        decision.state !== record.state ||
        decision.requestedScopes.join(' ') !== record.scopes.join(' ')
      )
        throw new Error('Invalid OAuth consent binding.')
      const denied = decision.status === 'denied',
        codeHash = query.code ? oauthBrowserHash(query.code) : undefined
      if (
        denied
          ? !query.error || decision.codeHash || decision.route || decision.codeExpiresAt
          : !codeHash ||
            codeHash !== decision.codeHash ||
            !decision.codeExpiresAt ||
            +decision.codeExpiresAt <= +now() ||
            !decision.route ||
            decision.route.kind !== 'code' ||
            decision.route.hash !== codeHash ||
            decision.route._id !==
              oauthRoutingRecordId(record.issuer, record.resource, 'code', codeHash) ||
            decision.route.issuer !== record.issuer ||
            decision.route.resource !== record.resource ||
            decision.route.cellId !== record.selection.cellId ||
            decision.route.region !== record.selection.region
      ) {
        throw new BrowserRequestError('invalid_grant')
      }
      if (
        record.completion &&
        (record.completion.denied !== denied || record.completion.codeHash !== codeHash)
      )
        throw new BrowserRequestError('invalid_grant')
      if (decision.route)
        await withinSignal(options.directory.register([decision.route], signal), signal)
      if (
        record.status === 'prepared' &&
        !(await withinSignal(
          options.store.transition(
            record,
            {
              ...record,
              status: 'completed',
              completion: { denied, ...(codeHash ? { codeHash } : {}), at: now() },
            },
            signal,
          ),
          signal,
        ))
      ) {
        const fresh = await read(handle, signal)
        if (
          fresh.status !== 'completed' ||
          fresh.completion?.denied !== denied ||
          fresh.completion?.codeHash !== codeHash
        )
          throw new BrowserRequestError('invalid_grant')
      }
      const callback = new URL(record.redirectUri)
      if (decision.codeExpiresAt && +decision.codeExpiresAt <= +now())
        throw new BrowserRequestError('invalid_grant')
      signal.throwIfAborted()
      callback.searchParams.set(
        denied ? 'error' : 'code',
        denied ? 'access_denied' : (query.code ?? ''),
      )
      callback.searchParams.set('iss', record.issuer)
      if (record.state !== undefined) callback.searchParams.set('state', record.state)
      return navigate(callback.href)
    } catch (error) {
      if (error instanceof BrowserRequestError) return json(400, error.code)
      if (error instanceof OAuthBrokerInvalidClientError) return json(400, 'invalid_client')
      return json(503, 'temporarily_unavailable')
    }
  }
}
