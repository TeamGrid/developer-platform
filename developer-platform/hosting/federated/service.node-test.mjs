import assert from 'node:assert/strict'
import { request as nodeRequest } from 'node:http'
import { test } from 'node:test'
import { MongoClient } from 'mongodb'
import { fixture, memoryCollection, metadata, policy } from './fixtureSupport.mjs'
import { createFederatedService } from './service.mjs'

function harness() {
  const state = {
    config: fixture(),
    policy: policy(),
    connected: 0,
    closed: 0,
    primary: true,
    failIndex: false,
    failStorage: false,
    providerCalls: [],
    providerPatch: {},
    failProvider: false,
    stallProvider: false,
  }
  const collections = new Map()
  const collection = (name) => {
    if (!collections.has(name)) collections.set(name, memoryCollection())
    return collections.get(name)
  }
  class Client {
    constructor(uri, options) {
      this.native = new MongoClient(uri, options)
      this.options = this.native.options
    }
    async connect() {
      state.connected += 1
    }
    async close() {
      state.closed += 1
      await this.native.close()
    }
    db(name) {
      assert.equal(name, 'teamgrid_federation_test')
      return {
        command: async () => {
          if (state.failStorage) throw new Error('Storage fixture unavailable')
          return {
            isWritablePrimary: state.primary,
            setName: 'rs0',
            logicalSessionTimeoutMinutes: 30,
          }
        },
        collection: (name) => {
          const value = collection(name)
          if (state.failIndex)
            value.createIndex = async () => {
              throw new Error('Index fixture unavailable')
            }
          return value
        },
      }
    }
  }
  const start = () =>
    createFederatedService({
      Client,
      readConfig: () => structuredClone(state.config),
      readPolicy: () => structuredClone(state.policy),
      fetcher: async (url, options) => {
        state.providerCalls.push([String(url), options])
        if (state.stallProvider) return new Promise(() => {})
        if (state.failProvider) return Response.json({}, { status: 503 })
        return Response.json({ ...metadata(state.config), ...state.providerPatch })
      },
    })
  return { state, collections, collection, start }
}
async function withServer(service, action) {
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve))
  const port = service.server.address().port
  try {
    await action(
      (path, init = {}) =>
        new Promise((resolve, reject) => {
          const request = nodeRequest(
            `http://127.0.0.1:${port}${path}`,
            {
              method: init.method ?? 'GET',
              headers: { Host: 'mcp.example.test', ...init.headers },
            },
            (response) => {
              const chunks = []
              response.on('data', (chunk) => chunks.push(chunk))
              response.on('error', reject)
              response.on('end', () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode,
                    headers: response.headers,
                  }),
                ),
              )
            },
          )
          request.on('error', reject)
          request.end(init.body)
        }),
    )
  } finally {
    await service.close()
  }
}

test('startup initializes native stores and dependency readiness before controlled HTTP serving', async () => {
  const h = harness(),
    service = await h.start()
  assert.equal(service.server.listening, false)
  assert.equal(h.state.connected, 1)
  const control = h.collection('control')
  control.rows.set(
    'deployment',
    Object.fromEntries(Object.entries(control.rows.get('deployment')).reverse()),
  )
  assert.deepEqual([...h.collections.keys()].sort(), [
    'admission',
    'browsers',
    'control',
    'probes',
    'routes',
  ])
  for (const name of ['admission', 'browsers', 'probes', 'routes']) {
    assert.equal(h.collection(name).indexes[0].expireAfterSeconds, 0)
  }
  await withServer(service, async (request) => {
    assert.equal((await request('/healthz')).status, 200)
    assert.equal((await request('/readyz')).status, 200)
    assert.equal((await request('/readyz')).status, 200)
    assert.equal(h.state.providerCalls.length, 1)
    const [url, options] = h.state.providerCalls[0]
    assert.equal(
      url,
      'https://de.example.test/internal/developer/oauth/integrations/ai-global/metadata',
    )
    assert.equal(
      options.headers['X-TeamGrid-OAuth-Service-Authorization'],
      `Bearer ${h.state.config.cells[0].serviceSecret}`,
    )
    assert.equal(options.redirect, 'error')
    assert.equal((await request('/.well-known/oauth-authorization-server')).status, 200)
    assert.equal((await request('/mcp', { method: 'POST', body: '{}' })).status, 401)
    const reads = h.collection('control').calls.filter(([kind]) => kind === 'read')
    assert.deepEqual(reads[0][2].readConcern, { level: 'linearizable' })
    assert.deepEqual(
      h.collection('probes').calls.find(([kind]) => kind === 'write')[3].writeConcern,
      { w: 'majority', j: true, wtimeoutMS: 5000 },
    )
  })
  await service.close()
  assert.equal(h.state.closed, 1)
  assert.equal(await service.ready(), false)
})

test('fresh policy revocation precedes persistence; invalid/replaced service config closes the global entry', async () => {
  const h = harness(),
    service = await h.start()
  await withServer(service, async (request) => {
    const query = new URLSearchParams({
      client_id: 'host1',
      redirect_uri: 'https://host.example.test/callback',
      response_type: 'code',
      resource: h.state.config.resource,
      scope: 'workspace:read',
      code_challenge_method: 'S256',
      code_challenge: 'x'.repeat(43),
    })
    assert.equal((await request(`/oauth/authorize?${query}`)).status, 303)
    assert.equal(h.collection('browsers').rows.size, 1)
    h.state.policy.clients[0].status = 'revoked'
    assert.equal((await request(`/oauth/authorize?${query}`)).status, 400)
    assert.equal(h.collection('browsers').rows.size, 1)
    h.state.config.enabled = false
    assert.equal((await request('/.well-known/oauth-authorization-server')).status, 503)
    assert.equal(await service.ready(), false)
    h.state.config.enabled = true
    h.state.config.cells[0].cellId = 'changed-test'
    assert.equal((await request('/.well-known/oauth-authorization-server')).status, 503)
  })
})

test('bad config/client policy fails before connecting; missing primary/index/binding closes the connection', async () => {
  for (const mutate of [
    (h) => {
      h.state.config.mongo.database = 'teamgrid'
    },
    (h) => {
      h.state.policy.clients[0].redirectUris = ['http://external.test/callback']
    },
    (h) => {
      h.state.primary = false
    },
    (h) => {
      h.state.failIndex = true
    },
    (h) => {
      h.collection('control').rows.set('deployment', { _id: 'deployment', version: 2 })
    },
  ]) {
    const h = harness()
    mutate(h)
    await assert.rejects(h.start())
    assert.equal(h.state.connected, h.state.closed)
  }
})

test('readiness rejects changed authority/scope, unavailable storage/providers and remains distinct from liveness', async () => {
  for (const patch of [
    { issuer: 'https://other.test/' },
    { scopes_supported: ['workspace:read'] },
    { token_endpoint: 'https://other.test/token' },
    { authorization_response_iss_parameter_supported: false },
  ]) {
    const h = harness()
    h.state.providerPatch = patch
    const service = await h.start()
    try {
      assert.equal(await service.ready(), false)
    } finally {
      await service.close()
    }
  }
  const h = harness(),
    service = await h.start()
  h.state.failProvider = true
  await withServer(service, async (request) => {
    assert.equal((await request('/readyz')).status, 503)
    assert.equal((await request('/healthz')).status, 200)
  })
  const failed = harness(),
    storageService = await failed.start()
  failed.state.failStorage = true
  try {
    assert.equal(await storageService.ready(), false)
  } finally {
    await storageService.close()
  }
})

test('coalesced readiness is bounded even for an uncooperative provider', async () => {
  const h = harness(),
    service = await h.start()
  h.state.stallProvider = true
  await withServer(service, async () => {
    const started = Date.now()
    assert.deepEqual(await Promise.all([service.ready(), service.ready()]), [false, false])
    assert.ok(Date.now() - started < 6000)
    assert.equal(h.state.providerCalls.length, 1)
  })
})
