// Disposable local image qualification only; not a deployer or a real OAuth provider.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, readFileSync, writeFileSync } from 'node:fs'
import { request as nodeRequest } from 'node:http'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { supportedOAuthScopes } from '/opt/teamgrid/developer-platform/packages/mcp-server/dist/toolScopes.js'

const { MongoClient } = createRequire(
  '/opt/teamgrid/developer-platform/hosting/federated/package.json',
)('mongodb')
const root = '/fixture',
  issuer = 'https://mcp.example.test/',
  resource = `${issuer}mcp`
const file = (name) => `${root}/${name}.json`
const read = (name) => JSON.parse(readFileSync(file(name), 'utf8'))
const save = (name, value) => {
  writeFileSync(file(name), JSON.stringify(value), { mode: 0o600 })
  chmodSync(file(name), 0o600)
  if (process.getuid() === 0) chownSync(file(name), 1000, 1000)
}
async function request(port, path, { method = 'GET', body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: { Host: 'mcp.example.test', ...headers },
        signal: AbortSignal.timeout(12000),
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}
const mode = process.argv[2]
if (mode === 'seed') {
  const suffix = createHash('sha256')
    .update(root + Date.now())
    .digest('hex')
    .slice(0, 12)
  const config = {
    version: 1,
    issuer,
    resource,
    enabled: true,
    writesEnabled: true,
    selectionUiOrigin: 'https://login.example.test/',
    workspaceRootDomain: 'example.test',
    selectionServiceSecret: 'b'.repeat(48),
    clientPolicyFile: file('clients'),
    mongo: {
      uri: 'mongodb://127.0.0.1:27017/?replicaSet=rs0',
      database: `teamgrid_federation_${suffix}`,
    },
    admission: {
      hmacSecret: 'h'.repeat(48),
      globalPerMinute: 100,
      publicPerMinute: 25,
      credentialPerMinute: 10,
    },
    allowedOrigins: [],
    hostClients: [],
    listen: { host: '127.0.0.1', port: 8080 },
    cells: [
      {
        region: 'de',
        cellId: 'de-test',
        serviceSecret: 's'.repeat(48),
        apiOriginSecret: 'a'.repeat(48),
        providerUrl:
          'https://127.0.0.1:9443/internal/developer/oauth/integrations/ai-global/access',
        apiBaseUrl: 'https://127.0.0.1:9444/v1',
      },
    ],
  }
  save('service-a', config)
  save('service-b', { ...config, listen: { ...config.listen, port: 8081 } })
  save('clients', {
    version: 1,
    cimdEnabled: false,
    cimdAllowedOrigins: [],
    clients: [
      {
        _id: 'registered-client-fixture',
        clientId: 'host1',
        name: 'Fixture host',
        status: 'active',
        redirectUris: ['https://host.example.test/callback'],
        tokenEndpointAuthMethod: 'none',
      },
    ],
  })
} else if (mode === 'provider') {
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}oauth/authorize`,
    token_endpoint: `${issuer}oauth/token`,
    revocation_endpoint: `${issuer}oauth/revoke`,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [...supportedOAuthScopes],
  }
  createServer(
    { key: readFileSync(`${root}/key.pem`), cert: readFileSync(`${root}/ca.pem`) },
    (req, res) => {
      if (
        req.url !== '/internal/developer/oauth/integrations/ai-global/metadata' ||
        req.headers['x-teamgrid-oauth-service-authorization'] !== `Bearer ${'s'.repeat(48)}`
      ) {
        res.writeHead(403)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(metadata))
    },
  ).listen(9443, '127.0.0.1')
} else if (mode === 'check') {
  // Keep the concurrent quota probe inside one minute; no clock-boundary false failures.
  if (Date.now() % 60000 > 50000)
    await new Promise((resolve) => setTimeout(resolve, 60000 - (Date.now() % 60000) + 50))
  for (const port of [8080, 8081]) {
    assert.equal((await request(port, '/healthz')).status, 200)
    assert.equal((await request(port, '/readyz')).status, 200)
    const discovery = await request(port, '/.well-known/oauth-authorization-server')
    assert.equal(discovery.status, 200)
    assert.equal(JSON.parse(discovery.text).issuer, issuer)
  }
  const query = new URLSearchParams({
    client_id: 'host1',
    redirect_uri: 'https://host.example.test/callback',
    response_type: 'code',
    resource,
    scope: 'workspace:read',
    code_challenge_method: 'S256',
    code_challenge: 'x'.repeat(43),
  })
  const authorization = await request(8080, `/oauth/authorize?${query}`)
  assert.equal(authorization.status, 303)
  assert.match(authorization.headers['set-cookie'][0], /__Host-teamgrid-oauth-/)
  const cookie = authorization.headers['set-cookie'][0].split(';')[0].split('=')[1]
  const clients = read('clients')
  clients.clients[0].status = 'revoked'
  save('clients', clients)
  for (const port of [8080, 8081])
    assert.equal((await request(port, `/oauth/authorize?${query}`)).status, 400)
  const token = await request(8081, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'host1',
      grant_type: 'authorization_code',
      code: 'c'.repeat(43),
      resource,
      redirect_uri: 'https://host.example.test/callback',
      code_verifier: 'v'.repeat(64),
    }).toString(),
  })
  assert.equal(token.status, 400)
  assert.equal(JSON.parse(token.text).error, 'invalid_client')
  const client = new MongoClient(read('service-a').mongo.uri, { serverSelectionTimeoutMS: 3000 })
  try {
    await client.connect()
    const db = client.db(read('service-a').mongo.database)
    const browsers = await db.collection('browsers').find({}).toArray()
    assert.equal(browsers.length, 1)
    assert.equal(JSON.stringify(browsers).includes(cookie), false)
    assert.equal(await db.collection('routes').countDocuments(), 0)
    for (const name of ['routes', 'browsers', 'admission', 'probes']) {
      assert.ok(
        (await db.collection(name).listIndexes().toArray()).some(
          (index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0,
        ),
      )
    }
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        request(i % 2 ? 8080 : 8081, '/.well-known/oauth-authorization-server'),
      ),
    )
    assert.ok(results.some((value) => value.status === 200))
    assert.ok(results.some((value) => value.status === 429))
    assert.ok(results.filter((value) => value.status === 200).length < 25)
    assert.ok(results.every((value) => [200, 429].includes(value.status)))
    assert.equal(await db.collection('admission').countDocuments(), 2)
  } finally {
    await client.close()
  }
  for (const name of ['service-a', 'service-b']) {
    const config = read(name)
    config.enabled = false
    save(name, config)
  }
  for (const port of [8080, 8081])
    assert.equal((await request(port, '/.well-known/oauth-authorization-server')).status, 503)
  for (const name of ['service-a', 'service-b']) {
    const config = read(name)
    config.enabled = true
    save(name, config)
  }
  process.stdout.write(
    'Federated image qualification passed: native replica-set stores, TLS private readiness, two-instance quotas, fresh policy revocation, hashed browser storage and independent global closure.\n',
  )
} else if (mode === 'outage') {
  const result = await request(8080, '/.well-known/oauth-authorization-server')
  assert.equal(result.status, 503)
  assert.equal(result.headers['www-authenticate'], undefined)
  process.stdout.write(
    'Federated image storage-outage qualification passed: unavailable without a new-login challenge.\n',
  )
} else {
  throw new Error('Unknown local fixture operation.')
}
