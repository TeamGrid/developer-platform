import { describe, expect, it } from 'vitest'
import {
  createFederatedOAuthBrowserBroker,
  OAUTH_BROWSER_CONTEXT_HEADER,
  OAUTH_BROWSER_SERVICE_HEADER,
} from './oauthBrowserBroker.js'
import {
  createMongoOAuthBrowserStore,
  type OAuthBrowserRecord,
  oauthBrowserHash,
} from './oauthBrowserStore.js'
import { type OAuthRoutingRecord, oauthRoutingRecordId } from './oauthRoutingDirectory.js'
import { OAuthBrokerInvalidClientError } from './oauthTokenBroker.js'

const issuer = 'https://mcp.example.test/',
  resource = `${issuer}mcp`
const cells = ['de', 'us'].map((region) => ({
  cellId: `${region}-test`,
  region,
  providerBaseUrl: `https://mcp-${region}.example.test/internal/developer/oauth/integrations/ai-global/`,
  serviceSecret: region.repeat(32),
}))
const secret = 's'.repeat(48),
  code = 'c'.repeat(43)
const client = {
  _id: 'registered-client-0001',
  clientId: 'host1',
  name: 'Host',
  status: 'active' as const,
  redirectUris: ['https://host.example.test/callback?registered=1'],
}
const signal = new AbortController().signal
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing fixture value')
  return value
}
function memory() {
  const rows = new Map<string, OAuthBrowserRecord>(),
    calls: Record<string, unknown>[] = []
  const collection = {
    createIndex: async (_keys: unknown, options: Record<string, unknown>) => {
      calls.push(options)
    },
    insertOne: async (input: unknown, options: Record<string, unknown>) => {
      calls.push(options)
      const record = input as OAuthBrowserRecord
      if (rows.has(record._id)) throw new Error('Duplicate')
      rows.set(record._id, structuredClone(record))
    },
    findOne: async (filter: Record<string, unknown>, options: Record<string, unknown>) => {
      calls.push(options)
      return structuredClone(rows.get(String(filter._id)) ?? null)
    },
    updateOne: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      calls.push(options)
      const record = rows.get(String(filter._id))
      if (JSON.stringify(record) !== JSON.stringify(filter)) return { modifiedCount: 0 }
      rows.set(String(filter._id), structuredClone(update.$set as OAuthBrowserRecord))
      return { modifiedCount: 1 }
    },
  }
  return { collection, rows, calls }
}
function initial(time = new Date()): OAuthBrowserRecord {
  return {
    _id: 'a'.repeat(64),
    issuer,
    resource,
    browserHash: 'b'.repeat(64),
    clientId: client.clientId,
    clientRecordId: client._id,
    clientName: client.name,
    redirectUri: client.redirectUris[0] ?? '',
    codeChallenge: 'p'.repeat(43),
    scopes: ['workspace:read'],
    createdAt: time,
    expiresAt: new Date(+time + 600000),
    status: 'selecting',
  }
}
describe('Mongo OAuth browser store', () => {
  it('requires initialized TTL, uses bounded linearizable reads and journaled majority writes', async () => {
    const m = memory(),
      store = createMongoOAuthBrowserStore({ issuer, resource, cells, collection: m.collection })
    await expect(store.insert(initial(), signal)).rejects.toThrow('initialized')
    await store.initialize(signal)
    await store.insert(initial(), signal)
    expect((await store.read('a'.repeat(64), signal))?.status).toBe('selecting')
    expect(m.calls[0]).toMatchObject({ expireAfterSeconds: 0, maxTimeMS: 5000 })
    expect(m.calls[1]).toMatchObject({ writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } })
    expect(m.calls[2]).toMatchObject({
      readConcern: { level: 'linearizable' },
      readPreference: 'primary',
      maxTimeMS: 5000,
    })
  })
  it('serializes selection and preserves callback, cookie, authority and cell through transitions', async () => {
    const m = memory(),
      store = createMongoOAuthBrowserStore({ issuer, resource, cells, collection: m.collection })
    await store.initialize(signal)
    const record = initial(),
      selected: OAuthBrowserRecord = {
        ...record,
        status: 'selected',
        selection: {
          region: 'us',
          cellId: 'us-test',
          workspaceId: 'workspace1',
          workspaceSlug: 'workspace',
          ticketHash: 't'.repeat(64).replaceAll('t', 'f'),
        },
      }
    await store.insert(record, signal)
    expect(await store.transition(record, selected, signal)).toBe(true)
    expect(
      await store.transition(
        record,
        {
          ...selected,
          selection: { ...required(selected.selection), cellId: 'de-test', region: 'de' },
        },
        signal,
      ),
    ).toBe(false)
    for (const patch of [
      { issuer: 'https://evil.test/' },
      { redirectUri: 'https://evil.test/' },
      { browserHash: 'c'.repeat(64) },
      { clientId: 'another' },
      { expiresAt: new Date(+record.expiresAt + 1) },
      { selection: { ...required(selected.selection), workspaceId: 'other' } },
    ]) {
      await expect(
        store.transition(selected, { ...selected, ...patch, status: 'prepared' }, signal),
      ).rejects.toThrow()
    }
    expect(await store.transition(selected, { ...selected, status: 'prepared' }, signal)).toBe(true)
    expect(
      await store.transition(
        { ...selected, status: 'prepared' },
        {
          ...selected,
          status: 'completed',
          completion: { codeHash: 'c'.repeat(64), denied: false, at: new Date() },
        },
        signal,
      ),
    ).toBe(true)
  })
  it('checks explicit expiry, closed records and retention rather than waiting for TTL cleanup', async () => {
    const time = new Date(),
      m = memory()
    let clock = time
    const store = createMongoOAuthBrowserStore({
      issuer,
      resource,
      cells,
      collection: m.collection,
      now: () => clock,
    })
    await store.initialize(signal)
    const record = initial(time)
    await store.insert(record, signal)
    clock = record.expiresAt
    expect(await store.read(record._id, signal)).toBe(null)
    clock = time
    for (const patch of [
      { extra: 'raw-token' },
      { status: 'completed' },
      { expiresAt: new Date(+time + 600001) },
      { scopes: ['tasks:read'] },
      { scopes: ['workspace:read', 'workspace:read'] },
    ]) {
      await expect(
        store.insert({ ...record, ...patch } as OAuthBrowserRecord, signal),
      ).rejects.toThrow()
    }
    m.rows.set(record._id, { ...record, resource: `${resource}-wrong` })
    await expect(store.read(record._id, signal)).rejects.toThrow()
  })
  it('honors abort even when the database does not cooperate', async () => {
    const m = memory(),
      store = createMongoOAuthBrowserStore({
        issuer,
        resource,
        cells,
        collection: { ...m.collection, findOne: () => new Promise(() => {}) },
      })
    await store.initialize(signal)
    await expect(store.read('a'.repeat(64), AbortSignal.timeout(15))).rejects.toThrow()
  })
})

async function harness(timeout = 30000) {
  const m = memory(),
    publications: OAuthRoutingRecord[][] = [],
    calls: { url: string; init: RequestInit }[] = []
  let clock = new Date(),
    enabled = true,
    admitted = true,
    denied = false,
    failPublish = false
  let lookup = async () => ({ ...client })
  let alterDecision = (value: Record<string, unknown>) => value
  const store = createMongoOAuthBrowserStore({
    issuer,
    resource,
    cells,
    collection: m.collection,
    now: () => clock,
  })
  await store.initialize(signal)
  let fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url))
    const inputHeaders = new Headers(init?.headers)
    const cell = required(cells.find((value) => target.href.startsWith(value.providerBaseUrl)))
    expect(cell).toBeDefined()
    expect(inputHeaders.get('X-TeamGrid-OAuth-Service-Authorization')).toBe(
      `Bearer ${cell.serviceSecret}`,
    )
    expect(init?.redirect).toBe('error')
    if (target.pathname.endsWith('/authorize')) {
      const context = JSON.parse(inputHeaders.get(OAUTH_BROWSER_CONTEXT_HEADER) ?? '')
      return Response.json({
        requestId: context.requestId,
        clientRecordId: client._id,
        cellId: cell.cellId,
        region: cell.region,
      })
    }
    const input = JSON.parse(String(init?.body)),
      record = required(m.rows.get(oauthBrowserHash(input.request_id)))
    const route = {
      _id: oauthRoutingRecordId(issuer, resource, 'code', oauthBrowserHash(code)),
      issuer,
      resource,
      cellId: cell.cellId,
      region: cell.region,
      hash: oauthBrowserHash(code),
      kind: 'code',
      registrationId: 'a'.repeat(64),
      createdAt: clock.toISOString(),
      expiresAt: new Date(+clock + 86400000).toISOString(),
    }
    return Response.json(
      alterDecision({
        requestId: input.request_id,
        browserHash: record.browserHash,
        issuer,
        resource,
        region: cell.region,
        cellId: cell.cellId,
        clientId: record.clientId,
        clientRecordId: record.clientRecordId,
        redirectUri: record.redirectUri,
        codeChallenge: record.codeChallenge,
        requestedScopes: record.scopes,
        ...(record.state === undefined ? {} : { state: record.state }),
        workspaceId: record.selection?.workspaceId,
        status: denied ? 'denied' : 'approved',
        ...(denied
          ? {}
          : {
              codeHash: oauthBrowserHash(code),
              codeExpiresAt: new Date(+clock + 60000).toISOString(),
              route,
            }),
      }),
    )
  }
  const handler = createFederatedOAuthBrowserBroker({
    issuer,
    resource,
    cells,
    scopes: ['workspace:read', 'tasks:read'],
    selectionUiOrigin: 'https://login.example.test/',
    workspaceRootDomain: 'example.test',
    selectionServiceSecret: secret,
    store,
    directory: {
      resolve: async () => null,
      register: async (records) => {
        if (failPublish) throw new Error('Publication unavailable')
        publications.push([...records])
      },
    },
    enabled: () => enabled,
    admit: async () => admitted,
    client: () => lookup(),
    now: () => clock,
    requestTimeoutMs: timeout,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return fetcher(url, init)
    },
  })
  const request = (path: string, init: RequestInit = {}) =>
    handler(new Request(new URL(path, issuer), init))
  const internal = (
    operation: string,
    input: Record<string, string>,
    header = `Bearer ${secret}`,
  ) =>
    request(`/internal/oauth/browser/${operation}`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', [OAUTH_BROWSER_SERVICE_HEADER]: header },
    })
  const start = async (
    patch: Record<string, string> = {},
    redirectUri = client.redirectUris[0] ?? '',
  ) => {
    const result = await request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        resource,
        scope: 'workspace:read tasks:read',
        code_challenge: 'p'.repeat(43),
        code_challenge_method: 'S256',
        state: 'state&unicode-ä',
        ...patch,
      })}`,
    )
    expect(result.status).toBe(303)
    const target = new URL(required(result.headers.get('location')))
    return {
      result,
      handle: required(target.searchParams.get('federation')),
      cookie: required(required(result.headers.get('set-cookie')).split(';')[0]),
    }
  }
  const prepare = async (region = 'de') => {
    const started = await start()
    const selected = await internal('select', {
      requestId: started.handle,
      cellId: `${region}-test`,
      workspaceId: 'workspace1',
      workspaceSlug: 'workspace',
    })
    expect(selected.status).toBe(200)
    const continuation = (await selected.json()).continueUrl as string
    const result = await request(continuation, { headers: { Cookie: started.cookie } })
    expect(result.status).toBe(303)
    return {
      ...started,
      continuation,
      consent: required(result.headers.get('location')),
      resume: `/oauth/resume?${new URLSearchParams({ request: started.handle, code })}`,
    }
  }
  return {
    m,
    store,
    request,
    internal,
    start,
    prepare,
    calls,
    publications,
    gate: (value: boolean) => {
      enabled = value
    },
    admission: (value: boolean) => {
      admitted = value
    },
    clock: (value: Date) => {
      clock = value
    },
    deny: () => {
      denied = true
    },
    failPublish: (value: boolean) => {
      failPublish = value
    },
    client: (value: typeof lookup) => {
      lookup = value
    },
    decision: (value: typeof alterDecision) => {
      alterDecision = value
    },
    fetch: (value: typeof fetcher) => {
      fetcher = value
    },
  }
}
describe('Federated OAuth browser broker', () => {
  it('stores only validated OAuth fields and cookie hashes; selection sees one opaque handle', async () => {
    const h = await harness(),
      flow = await h.start({ ui_locales: 'de', region: 'us', unknown: 'ignored' })
    const target = new URL(required(flow.result.headers.get('location')))
    expect(target.origin).toBe('https://login.example.test')
    expect([...target.searchParams.keys()]).toEqual(['federation'])
    expect(flow.result.headers.get('set-cookie')).toMatch(
      /Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/,
    )
    const record = required([...h.m.rows.values()][0])
    expect(record._id).toBe(oauthBrowserHash(flow.handle))
    expect(JSON.stringify(record)).not.toContain(flow.cookie.split('=')[1])
    expect(record).not.toHaveProperty('unknown')
    expect(h.calls).toHaveLength(0)
    const details = await h.internal('details', { requestId: flow.handle })
    expect(details.status).toBe(200)
    expect(await details.json()).toMatchObject({
      clientName: 'Host',
      redirectOrigin: 'https://host.example.test',
    })
    expect(details.headers.has('access-control-allow-origin')).toBe(false)
  })
  it.each(['de', 'us'])(
    'publishes %s code routing before the exact host callback with state and logical issuer',
    async (region) => {
      const h = await harness(),
        flow = await h.prepare(region)
      expect(new URL(flow.consent).origin).toBe('https://workspace.example.test')
      expect(new URL(flow.consent).searchParams.get('cell')).toBe(`${region}-test`)
      const result = await h.request(flow.resume, { headers: { Cookie: flow.cookie } })
      expect(result.status).toBe(303)
      const callback = new URL(required(result.headers.get('location')))
      expect(callback.origin).toBe('https://host.example.test')
      expect(callback.searchParams.get('registered')).toBe('1')
      expect(callback.searchParams.get('code')).toBe(code)
      expect(callback.searchParams.get('state')).toBe('state&unicode-ä')
      expect(callback.searchParams.get('iss')).toBe(issuer)
      expect(h.publications).toHaveLength(1)
      expect(h.publications[0]?.[0]).toMatchObject({
        kind: 'code',
        cellId: `${region}-test`,
        region,
        hash: oauthBrowserHash(code),
      })
      expect(
        h.calls.every((call) => call.url.startsWith(`https://mcp-${region}.example.test/`)),
      ).toBe(true)
      expect((await h.store.read(oauthBrowserHash(flow.handle), signal))?.status).toBe('completed')
    },
  )
  it('checks service authentication and atomic selection before any provider request', async () => {
    const h = await harness(),
      flow = await h.start()
    expect((await h.internal('details', { requestId: flow.handle }, 'Bearer wrong')).status).toBe(
      401,
    )
    expect(
      (
        await h.internal('select', {
          requestId: flow.handle,
          cellId: 'unknown',
          workspaceId: 'workspace1',
          workspaceSlug: 'workspace',
        })
      ).status,
    ).toBe(400)
    const selection = {
      requestId: flow.handle,
      cellId: 'de-test',
      workspaceId: 'workspace1',
      workspaceSlug: 'workspace',
    }
    const results = await Promise.all([
      h.internal('select', selection),
      h.internal('select', { ...selection, cellId: 'us-test' }),
    ])
    expect(results.map((value) => value.status).sort()).toEqual([200, 400])
    expect(h.calls).toHaveLength(0)
  })
  it('rejects missing, exchanged or duplicated cookies before reaching a cell', async () => {
    const h = await harness(),
      a = await h.start(),
      b = await h.start()
    const selected = await h.internal('select', {
      requestId: a.handle,
      cellId: 'de-test',
      workspaceId: 'workspace1',
      workspaceSlug: 'workspace',
    })
    const { continueUrl } = await selected.json()
    for (const cookie of ['', b.cookie, `${a.cookie}; ${a.cookie}`]) {
      expect((await h.request(continueUrl, { headers: { Cookie: cookie } })).status).toBe(400)
    }
    expect(h.calls).toHaveLength(0)
  })
  it('holds the callback during publication failure and resumes the same committed code', async () => {
    const h = await harness(),
      flow = await h.prepare()
    h.failPublish(true)
    const failed = await h.request(flow.resume, { headers: { Cookie: flow.cookie } })
    expect(failed.status).toBe(503)
    expect(failed.headers.has('location')).toBe(false)
    expect((await h.store.read(oauthBrowserHash(flow.handle), signal))?.status).toBe('prepared')
    h.failPublish(false)
    expect((await h.request(flow.resume, { headers: { Cookie: flow.cookie } })).status).toBe(303)
    expect((await h.request(flow.resume, { headers: { Cookie: flow.cookie } })).status).toBe(303)
    expect(h.calls.filter((call) => call.url.includes('/authorize?'))).toHaveLength(1)
  })
  it('returns only a region-confirmed denial with original state and issuer', async () => {
    const h = await harness(),
      flow = await h.prepare()
    const denial = `/oauth/resume?${new URLSearchParams({ request: flow.handle, error: 'access_denied' })}`
    expect((await h.request(denial, { headers: { Cookie: flow.cookie } })).status).toBe(400)
    h.deny()
    const result = await h.request(denial, { headers: { Cookie: flow.cookie } })
    expect(result.status).toBe(303)
    const callback = new URL(required(result.headers.get('location')))
    expect(callback.searchParams.get('error')).toBe('access_denied')
    expect(callback.searchParams.get('iss')).toBe(issuer)
    expect(callback.searchParams.get('state')).toBe('state&unicode-ä')
    expect(callback.searchParams.has('code')).toBe(false)
    expect(h.publications).toHaveLength(0)
  })
  it('rejects wrong workspace, callback, browser, client, scope, challenge or authority evidence', async () => {
    const h = await harness(),
      flow = await h.prepare()
    for (const patch of [
      { workspaceId: 'other' },
      { cellId: 'us-test' },
      { region: 'us' },
      { issuer: 'https://other.test/' },
      { resource: `${resource}-other` },
      { browserHash: 'f'.repeat(64) },
      { clientId: 'other' },
      { clientRecordId: 'another-client-0001' },
      { redirectUri: 'https://evil.test/' },
      { state: 'other' },
      { requestedScopes: ['workspace:read'] },
      { codeChallenge: 'q'.repeat(43) },
    ]) {
      h.decision((value) => ({ ...value, ...patch }))
      const result = await h.request(flow.resume, { headers: { Cookie: flow.cookie } })
      expect(result.status).toBe(503)
      expect(result.headers.has('location')).toBe(false)
    }
    expect(h.publications).toHaveLength(0)
  })
  it('rejects unknown, expired, unprepared and malformed browser inputs without fanout', async () => {
    const h = await harness(),
      flow = await h.start()
    for (const suffix of [
      '&request=duplicate',
      '&redirect_uri=https://evil.test/',
      '&error=access_denied',
    ]) {
      expect(
        (
          await h.request(`/oauth/resume?request=${flow.handle}&code=${code}${suffix}`, {
            headers: { Cookie: flow.cookie },
          })
        ).status,
      ).toBe(400)
    }
    expect(
      (
        await h.request(`/oauth/resume?request=${'u'.repeat(43)}&code=${code}`, {
          headers: { Cookie: flow.cookie },
        })
      ).status,
    ).toBe(400)
    const record = required([...h.m.rows.values()][0])
    h.clock(record.expiresAt)
    expect((await h.internal('details', { requestId: flow.handle })).status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })
  it('rechecks client revocation at continuation and callback; outages never ask for another grant', async () => {
    const h = await harness(),
      flow = await h.prepare()
    h.client(async () => {
      throw new OAuthBrokerInvalidClientError()
    })
    expect((await h.request(flow.resume, { headers: { Cookie: flow.cookie } })).status).toBe(400)
    h.client(async () => {
      throw new Error('Client directory unavailable')
    })
    expect((await h.request(flow.resume, { headers: { Cookie: flow.cookie } })).status).toBe(503)
    expect(h.calls).toHaveLength(1)
  })
  it('validates redirect, resource, PKCE, scopes, secret query and duplicate parameters before persistence', async () => {
    const h = await harness()
    const base = {
      client_id: 'host1',
      redirect_uri: client.redirectUris[0] ?? '',
      response_type: 'code',
      resource,
      scope: 'workspace:read',
      code_challenge: 'p'.repeat(43),
      code_challenge_method: 'S256',
    }
    for (const patch of [
      { redirect_uri: 'https://evil.test/' },
      { resource: `${resource}-wrong` },
      { code_challenge_method: 'plain' },
      { code_challenge: 'short' },
      { scope: 'tasks:read' },
      { scope: 'workspace:read unknown' },
      { client_secret: 'must-not-persist' },
    ]) {
      expect(
        (
          await h.request(
            `/oauth/authorize?${new URLSearchParams({ ...base, ...patch } as Record<string, string>)}`,
          )
        ).status,
      ).toBe(400)
    }
    expect(
      (await h.request(`/oauth/authorize?${new URLSearchParams(base)}&client_id=host1`)).status,
    ).toBe(400)
    expect(h.m.rows.size).toBe(0)
  })
  it('retains exact actual native loopback ports through preparation and callback', async () => {
    const h = await harness()
    h.client(async () => ({ ...client, redirectUris: ['http://127.0.0.1/callback'] }))
    const flow = await h.start({}, 'http://127.0.0.1:49321/callback')
    const selected = await h.internal('select', {
      requestId: flow.handle,
      cellId: 'de-test',
      workspaceId: 'workspace1',
      workspaceSlug: 'workspace',
    })
    const { continueUrl } = await selected.json()
    expect((await h.request(continueUrl, { headers: { Cookie: flow.cookie } })).status).toBe(303)
    const result = await h.request(`/oauth/resume?request=${flow.handle}&code=${code}`, {
      headers: { Cookie: flow.cookie },
    })
    expect(new URL(required(result.headers.get('location'))).origin).toBe('http://127.0.0.1:49321')
  })
  it('accepts native ephemeral ports with a registered port and retains the chosen callback', async () => {
    const h = await harness()
    h.client(async () => ({ ...client, redirectUris: ['http://127.0.0.1:49321/callback'] }))
    const flow = await h.start({}, 'http://127.0.0.1:49322/callback')
    const selected = await h.internal('select', {
      requestId: flow.handle,
      cellId: 'de-test',
      workspaceId: 'workspace1',
      workspaceSlug: 'workspace',
    })
    const { continueUrl } = await selected.json()
    expect((await h.request(continueUrl, { headers: { Cookie: flow.cookie } })).status).toBe(303)
    const result = await h.request(`/oauth/resume?request=${flow.handle}&code=${code}`, {
      headers: { Cookie: flow.cookie },
    })
    expect(new URL(required(result.headers.get('location'))).origin).toBe('http://127.0.0.1:49322')
  })
  it('keeps admission, feature gates, stream size and deadlines before private work', async () => {
    const h = await harness(20)
    h.gate(false)
    expect((await h.request('/oauth/authorize')).status).toBe(503)
    h.gate(true)
    h.admission(false)
    expect((await h.request('/oauth/authorize')).status).toBe(429)
    h.admission(true)
    expect((await h.internal('details', { requestId: 'x'.repeat(17000) })).status).toBe(400)
    h.client(() => new Promise(() => {}))
    expect((await h.request('/oauth/authorize?client_id=host1')).status).toBe(503)
    expect(h.calls).toHaveLength(0)
  })
  it('never retries an ambiguous private preparation or switches to another cell', async () => {
    const h = await harness(),
      flow = await h.start()
    const selected = await h.internal('select', {
      requestId: flow.handle,
      cellId: 'de-test',
      workspaceId: 'workspace1',
      workspaceSlug: 'workspace',
    })
    const { continueUrl } = await selected.json()
    h.fetch(async () => {
      throw new Error('Lost response')
    })
    expect((await h.request(continueUrl, { headers: { Cookie: flow.cookie } })).status).toBe(503)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url.startsWith(cells[0]?.providerBaseUrl ?? '')).toBe(true)
  })
})
