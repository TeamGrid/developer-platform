// Disposable local image qualification only; not a deployer or a real OAuth provider.

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, chownSync, readFileSync, writeFileSync } from 'node:fs'
import { request as nodeRequest } from 'node:http'
import { createServer, request as httpsRequest } from 'node:https'
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
async function request(port, path, { method = 'GET', body, headers, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = (port === 8443 ? httpsRequest : nodeRequest)(
      `${port === 8443 ? 'https' : 'http'}://127.0.0.1:${port}${path}`,
      {
        method,
        localAddress,
        ...(port === 8443
          ? { ca: readFileSync(`${root}/ca.pem`), servername: 'mcp.example.test' }
          : {}),
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
    req.on('error', (cause) =>
      reject(
        new Error(
          `Fixture request failed: ${mode} port=${port} path=${new URL(path, issuer).pathname}`,
          {
            cause,
          },
        ),
      ),
    )
    req.end(body)
  })
}
const mode = process.argv[2]
if (mode === 'seed') {
  const suffix = createHash('sha256')
    .update(root + Date.now())
    .digest('hex')
    .slice(0, 12)
  const database = `teamgrid_federation_${suffix}`
  const credentials = {
    database,
    adminUser: 'fixture-admin',
    adminPassword: randomBytes(32).toString('base64url'),
    serviceUser: 'fixture-service',
    servicePassword: randomBytes(32).toString('base64url'),
  }
  const privateRootFile = (name, value) => {
    const path = `${root}/${name}`
    writeFileSync(path, value, { mode: 0o400 })
    chownSync(path, 0, 0)
    chmodSync(path, 0o400)
  }
  privateRootFile('mongo-auth.json', JSON.stringify(credentials))
  privateRootFile('mongo-key', randomBytes(512).toString('base64'))
  privateRootFile(
    'mongod.pem',
    Buffer.concat([readFileSync(`${root}/key.pem`), readFileSync(`${root}/ca.pem`)]),
  )
  privateRootFile('mongo-ca.pem', readFileSync(`${root}/ca.pem`))
  const { createSelfHostedArtifacts, caddyRuntimeRedaction } = await import(
    '/opt/teamgrid/developer-platform/hosting/federated/selfHosting.mjs'
  )
  // Local fixture only: the initial root identity provisions exactly one isolated DB/role.
  privateRootFile(
    'mongo-bootstrap.js',
    `(async () => {
const auth = JSON.parse(require('node:fs').readFileSync('/fixture/mongo-auth.json', 'utf8'));
const admin = db.getSiblingDB('admin');
await admin.createUser({user: auth.adminUser, pwd: auth.adminPassword, roles: ['root']});
if (!(await admin.auth(auth.adminUser, auth.adminPassword))) throw new Error('Fixture authentication failed');
await admin.runCommand({setFeatureCompatibilityVersion: '8.0', confirm: true});
const target = db.getSiblingDB(auth.database);
const names = ['control', 'routes', 'browsers', 'admission', 'probes'];
for (const name of names) await target.createCollection(name);
await target.createRole({role: 'federatedService', roles: [], privileges: names.map(collection => ({
resource: {db: auth.database, collection}, actions: ['find', 'insert', 'update', 'createIndex', 'listIndexes']
}))});
await target.createUser({user: auth.serviceUser, pwd: auth.servicePassword,
roles: [{role: 'federatedService', db: auth.database}], mechanisms: ['SCRAM-SHA-256']});
})()
`,
  )
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
      uri: `mongodb://${credentials.serviceUser}:${credentials.servicePassword}@127.0.0.1:27017/?replicaSet=rs0&tls=true&authSource=${database}&authMechanism=SCRAM-SHA-256&tlsCAFile=/fixture/ca.pem`,
      database,
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
  const artifacts = createSelfHostedArtifacts(
    {
      ...config,
      listen: { host: '0.0.0.0', port: 8080 },
      clientPolicyFile: '/run/teamgrid-federation/clients.json',
    },
    {
      version: 1,
      project: 'teamgrid-federation-staging',
      sourceRevision: 'a'.repeat(40),
      image: `ghcr.io/teamgrid/teamgrid-federated-mcp@sha256:${'b'.repeat(64)}`,
      runtimeDirectory: process.env.HOST_FIXTURE_DIR,
      databaseNetwork: 'teamgrid-federation-staging-db',
      browserServiceIps: ['127.0.0.1'],
    },
  )
  // This fixture artifact contains no credentials and must be readable by host Compose.
  writeFileSync(`${root}/compose.json`, JSON.stringify(artifacts.compose), { mode: 0o644 })
  const site = artifacts.caddySite
    .replace(
      'mcp.example.test {',
      'https://mcp.example.test:8443 {\n  tls /fixture/ca.pem /fixture/key.pem',
    )
    .replaceAll('teamgrid-federation-staging-a:8080', '127.0.0.1:8080')
    .replaceAll('teamgrid-federation-staging-b:8080', '127.0.0.1:8081')
  writeFileSync(
    `${root}/Caddyfile`,
    `{\n  admin off\n  auto_https off\n  ${caddyRuntimeRedaction()}\n}\n${site}`,
    { mode: 0o600 },
  )
  chownSync(`${root}/Caddyfile`, 1000, 1000)
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
    for (const forbidden of [
      () => db.collection('browsers').deleteMany({}),
      () => db.collection('routes').drop(),
      () => db.createCollection('unapproved'),
      () => client.db('teamgrid_regional_fixture').collection('grants').findOne({}),
    ]) {
      await assert.rejects(forbidden(), (error) => error.code === 13)
    }
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
    // Earlier checks may have used the preceding quota window. TTL retains its counters.
    if (Date.now() % 60000 > 40000)
      await new Promise((resolve) => setTimeout(resolve, 60000 - (Date.now() % 60000) + 50))
    const quotaWindow = Math.floor(Date.now() / 60000)
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        request(i % 2 ? 8080 : 8081, '/.well-known/oauth-authorization-server'),
      ),
    )
    assert.ok(results.some((value) => value.status === 200))
    assert.ok(results.some((value) => value.status === 429))
    assert.ok(results.filter((value) => value.status === 200).length <= 25)
    assert.ok(
      results.every((value) => [200, 429].includes(value.status)),
      JSON.stringify(results.map((value) => ({ status: value.status, text: value.text }))),
    )
    assert.equal(Math.floor(Date.now() / 60000), quotaWindow)
    assert.equal(
      await db.collection('admission').countDocuments({
        expiresAt: new Date((quotaWindow + 3) * 60000),
      }),
      2,
    )
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
    'Federated image qualification passed: authenticated TLS replica-set stores with a collection-scoped service role, TLS private readiness, two-instance quotas, fresh policy revocation, hashed browser storage and independent global closure.\n',
  )
} else if (mode === 'ingress') {
  // The previous native quota probe intentionally exhausts this minute's public allowance.
  await new Promise((resolve) => setTimeout(resolve, 60000 - (Date.now() % 60000) + 50))
  assert.equal((await request(8443, '/.well-known/oauth-authorization-server')).status, 200)
  assert.equal((await request(8443, '/.well-known/oauth-protected-resource/mcp')).status, 200)
  assert.equal((await request(8443, '/mcp', { method: 'POST', body: '{}' })).status, 401)
  for (const path of ['/healthz', '/readyz', '/internal/developer/oauth/access', '/unknown'])
    assert.equal((await request(8443, path)).status, 404)
  const secret = 'b'.repeat(48)
  const privateRequest = {
    method: 'POST',
    body: JSON.stringify({ requestId: 'x'.repeat(43) }),
    headers: {
      'Content-Type': 'application/json',
      'X-TeamGrid-OAuth-Browser-Service-Authorization': `Bearer ${secret}`,
    },
  }
  const untrusted = await request(8443, '/internal/oauth/browser/details', {
    ...privateRequest,
    localAddress: '127.0.0.2',
    headers: { ...privateRequest.headers, 'X-Forwarded-For': '127.0.0.1' },
  })
  assert.equal(untrusted.status, 403)
  const trusted = await request(8443, '/internal/oauth/browser/details', privateRequest)
  assert.equal(trusted.status, 400) // Passed ingress/service authentication; unknown request handle.
  const large = await request(8443, '/oauth/token', { method: 'POST', body: 'x'.repeat(16385) })
  assert.equal(large.status, 413)
  process.stdout.write(
    'Federated Caddy qualification passed: canonical discovery/MCP, private source restriction without forwarded-header trust, hidden health/internal paths and OAuth body limits.\n',
  )
} else if (mode === 'proxy-outage') {
  const result = await request(8443, '/oauth/token?code=tg_log_probe_code', {
    method: 'POST',
    body: 'grant_type=authorization_code',
    headers: {
      Authorization: 'Bearer tg_log_probe_bearer',
      Cookie: 'tg_log_probe_cookie',
      'X-TeamGrid-OAuth-Service-Authorization': 'tg_log_probe_service',
      'X-TeamGrid-OAuth-Browser-Service-Authorization': 'tg_log_probe_browser',
      'X-TeamGrid-OAuth-Browser-Context': 'tg_log_probe_context',
      'X-TeamGrid-OAuth-Exchange-ID': 'tg_log_probe_exchange',
    },
  })
  assert.ok(result.status >= 500)
  process.stdout.write('Federated ingress unavailable-upstream qualification passed.\n')
} else if (mode === 'audit') {
  const log = readFileSync(`${root}/ingress-audit.log`, 'utf8')
  assert.equal(log.includes('tg_log_probe'), false)
  const entries = log
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
  assert.ok(
    entries.some((entry) => entry.status >= 500 && entry.request?.uri === '[redacted]'),
    'The unavailable-upstream runtime log must contain a redacted request.',
  )
  process.stdout.write('Federated ingress runtime-log redaction qualification passed.\n')
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
