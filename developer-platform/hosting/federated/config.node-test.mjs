import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  immutableConfig,
  parseClientPolicy,
  parseServiceConfig,
  readPrivateJson,
} from './config.mjs'
import { fixture, policy } from './fixtureSupport.mjs'
import { createMongoConnection } from './service.mjs'

test('strict complete configuration, canonical public/private identities and explicit activation', () => {
  const config = fixture()
  assert.deepEqual(parseServiceConfig(config), config)
  const inactive = { ...config, enabled: false, writesEnabled: false }
  assert.equal(immutableConfig(config), immutableConfig(inactive))
  assert.notEqual(
    immutableConfig(config),
    immutableConfig({ ...config, selectionServiceSecret: 'x'.repeat(48) }),
  )
  for (const mutate of [
    (v) => {
      v.version = 2
    },
    (v) => {
      v.unknown = true
    },
    (v) => {
      delete v.enabled
    },
    (v) => {
      v.resource = 'https://other.test/mcp'
    },
    (v) => {
      v.resource = `${v.issuer}oauth/token`
    },
    (v) => {
      v.selectionUiOrigin = 'https://login.example.test/path'
    },
    (v) => {
      v.cells[0].providerUrl = v.cells[0].providerUrl.replace('ai-global', 'regional')
    },
    (v) => {
      v.cells.push(v.cells[0])
    },
    (v) => {
      v.cells[0].apiBaseUrl = 'http://api.test/v1'
    },
    (v) => {
      v.mongo.database = 'teamgrid'
    },
    (v) => {
      v.mongo.uri = 'mongodb://x/?x='.repeat(1000)
    },
    (v) => {
      v.admission.globalPerMinute = 0
    },
    (v) => {
      v.admission.publicPerMinute = 101
    },
    (v) => {
      v.admission.hmacSecret = v.cells[0].serviceSecret
    },
    (v) => {
      v.selectionServiceSecret = v.admission.hmacSecret
    },
    (v) => {
      v.listen.port = 0
    },
    (v) => {
      v.listen.host = 'external.test'
    },
    (v) => {
      v.allowedOrigins = ['https://host.test/path']
    },
    (v) => {
      v.workspaceRootDomain = '-bad.test'
    },
    (v) => {
      v.clientPolicyFile = 'relative.json'
    },
  ]) {
    const copy = structuredClone(config)
    mutate(copy)
    assert.throws(() => parseServiceConfig(copy))
  }
})

test('OpenID activation requires an explicit absolute private-key file without embedding keys in service config', () => {
  const config = { ...fixture(), oidcKeyFile: '/run/teamgrid-federation/oidc-keys.json' }
  assert.deepEqual(parseServiceConfig(config), config)
  assert.notEqual(immutableConfig(config), immutableConfig(fixture()))
  for (const value of ['relative.json', '', null, true, { privateKeyPem: 'never-inline' }]) {
    assert.throws(() => parseServiceConfig({ ...config, oidcKeyFile: value }), {
      message: 'Federated configuration unavailable.',
    })
  }
})

test('API origin credentials preserve the regional visible-ASCII contract and reject header injection', () => {
  for (const value of ['a'.repeat(32), `${'a'.repeat(60)}+/==`, 'b'.repeat(512)]) {
    const config = fixture()
    config.cells[0].apiOriginSecret = value
    assert.equal(parseServiceConfig(config).cells[0].apiOriginSecret, value)
  }
  for (const value of [
    'a'.repeat(31),
    'a'.repeat(513),
    `${'a'.repeat(32)}\r\nInjected: true`,
    `${'a'.repeat(32)} `,
    `${'a'.repeat(32)}\t`,
    `${'a'.repeat(32)}\0`,
    `${'a'.repeat(32)}\x7f`,
    `${'a'.repeat(32)}ä`,
  ]) {
    const config = fixture()
    config.cells[0].apiOriginSecret = value
    assert.throws(() => parseServiceConfig(config))
  }
  const config = fixture()
  config.cells[0].apiOriginSecret = `${'a'.repeat(60)}+/==`
  config.selectionServiceSecret = config.cells[0].apiOriginSecret
  assert.throws(() => parseServiceConfig(config))
})

test('workspace UI routing is explicit, bounded and immutable for a running service', () => {
  const original = fixture()
  assert.equal(parseServiceConfig(original).workspaceUiMode, undefined)
  for (const mode of ['subdomain', 'path']) {
    const configured = { ...original, workspaceUiMode: mode }
    assert.equal(parseServiceConfig(configured).workspaceUiMode, mode)
    assert.notEqual(immutableConfig(original), immutableConfig(configured))
  }
  for (const mode of [null, true, '', 'https://evil.test/', 'PATH', {}]) {
    assert.throws(() => parseServiceConfig({ ...original, workspaceUiMode: mode }))
  }
})

test('client policy independently validates version, limits and canonical HTTPS origins', () => {
  assert.deepEqual(parseClientPolicy(policy()), policy())
  for (const patch of [
    { version: 2 },
    { cimdEnabled: 'true' },
    { extra: true },
    { cimdEnabled: true },
    { clients: Array(51).fill({}) },
    { cimdAllowedOrigins: ['https://127.0.0.1'] },
    { cimdAllowedOrigins: ['https://host.test:8443'] },
    { cimdAllowedOrigins: ['https://host.test/path'] },
    { cimdAllowedOrigins: ['https://host.test', 'https://host.test'] },
  ]) {
    assert.throws(() => parseClientPolicy({ ...policy(), ...patch }))
  }
})

test('private file reading requires regular, bounded, valid UTF-8 owner-only Unix files', {
  skip: process.platform === 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamgrid-global-config-'))
  try {
    const path = join(dir, 'policy.json'),
      link = join(dir, 'link.json')
    writeFileSync(path, JSON.stringify(policy()), { mode: 0o600 })
    assert.deepEqual(readPrivateJson(path), policy())
    symlinkSync(path, link)
    assert.throws(() => readPrivateJson(link))
    assert.throws(() => readPrivateJson(dir))
    chmodSync(path, 0o644)
    assert.throws(() => readPrivateJson(path))
    chmodSync(path, 0o600)
    writeFileSync(path, Buffer.alloc(65537))
    assert.throws(() => readPrivateJson(path))
    writeFileSync(path, Buffer.from([0xff]))
    assert.throws(() => readPrivateJson(path))
    writeFileSync(path, '{invalid')
    assert.throws(() => readPrivateJson(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real driver configuration pins TLS/replica set, pool/budgets and disabled retries/logging', async () => {
  const client = createMongoConnection(fixture())
  try {
    assert.equal(client.options.tls, true)
    assert.equal(client.options.replicaSet, 'rs0')
    assert.equal(client.options.retryWrites, false)
    assert.equal(client.options.retryReads, false)
    assert.equal(client.options.maxPoolSize, 20)
    assert.equal(client.options.serverSelectionTimeoutMS, 3000)
  } finally {
    await client.close()
  }
  for (const uri of [
    'mongodb://db.test/?replicaSet=rs0&tls=true',
    'mongodb://u:p@db.test/?tls=true',
    'mongodb://u:p@db.test/?replicaSet=rs0',
    'mongodb://u:p@db.test/?replicaSet=rs0&tls=true&tlsInsecure=true',
    'mongodb://u:p@db.test/?replicaSet=rs0&tls=true&directConnection=true',
    'mongodb://u:p@db.test/?replicaSet=rs0&tls=true&tls=false',
  ]) {
    assert.throws(() => createMongoConnection({ ...fixture(), mongo: { ...fixture().mongo, uri } }))
  }
  const local = {
    ...fixture(),
    mongo: { ...fixture().mongo, uri: 'mongodb://127.0.0.1:27017/?replicaSet=rs0' },
  }
  assert.throws(() => createMongoConnection(local))
  assert.throws(() => createMongoConnection(local, { localTest: true }))
  assert.throws(() =>
    createMongoConnection(
      { ...local, mongo: { ...local.mongo, uri: 'mongodb://localhost/?replicaSet=rs0' } },
      { localTest: true },
    ),
  )
})
