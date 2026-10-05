import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture } from './fixtureSupport.mjs'
import { prepareSelfHosted } from './prepare-self-hosted.mjs'
import { createSelfHostedArtifacts } from './selfHosting.mjs'

export const specification = () => ({
  version: 1,
  project: 'teamgrid-federation-staging',
  sourceRevision: 'a'.repeat(40),
  image: `ghcr.io/teamgrid/teamgrid-federated-mcp@sha256:${'b'.repeat(64)}`,
  runtimeDirectory: '/opt/teamgrid-federation-staging/runtime',
  databaseNetwork: 'teamgrid-federation-staging-db',
  browserServiceIps: ['127.0.0.1'],
})
export const hostingConfig = () => ({
  ...fixture(),
  selectionServiceSecret: `private-browser-secret-${'x'.repeat(32)}`,
  enabled: false,
  writesEnabled: false,
  clientPolicyFile: '/run/teamgrid-federation/clients.json',
  listen: { host: '0.0.0.0', port: 8080 },
})
test('self-hosted artifacts isolate two bounded replicas, expose no host port and retain external DB ownership', () => {
  const { compose, caddySite, caddyNetwork } = createSelfHostedArtifacts(
    hostingConfig(),
    specification(),
  )
  assert.deepEqual(Object.keys(compose.services), ['federation-a', 'federation-b'])
  assert.equal(compose.networks.database.external, true)
  assert.deepEqual(compose.networks.egress, {
    external: true,
    name: 'teamgrid-federation-staging-egress',
  })
  assert.equal(compose.networks.database.name, 'teamgrid-federation-staging-db')
  for (const service of Object.values(compose.services)) {
    assert.equal(service.user, '1000:1000')
    assert.equal(service.read_only, true)
    assert.equal(service.ports, undefined)
    assert.equal(service.network_mode, undefined)
    assert.equal(service.mem_limit, '512m')
    assert.equal(service.volumes[0].bind.create_host_path, false)
    assert.equal(
      service.environment.TEAMGRID_FEDERATION_CONFIG_FILE,
      '/run/teamgrid-federation/service.json',
    )
  }
  assert.equal(JSON.stringify(compose).includes(fixture().mongo.uri), false)
  assert.equal(JSON.stringify(compose).includes(hostingConfig().selectionServiceSecret), false)
  assert.deepEqual(Object.keys(caddyNetwork.services.caddy.networks), [
    'default',
    'federation_ingress',
  ])
  assert.deepEqual(caddyNetwork.services.caddy.volumes, [
    {
      type: 'bind',
      source: '/opt/teamgrid-federation-staging/Caddyfile.site',
      target: '/etc/caddy/teamgrid-federation-staging.site',
      read_only: true,
      bind: { create_host_path: false },
    },
  ])
  assert.match(caddySite, /health_headers \{\s+Host mcp.example.test/)
  assert.match(caddySite, /lb_try_duration 0s/)
})
test('self-hosted preparation rejects mutable images, implicit/legacy networks and malformed inputs', () => {
  for (const patch of [
    { project: 'teamgrid' },
    { sourceRevision: 'main' },
    { image: 'ghcr.io/teamgrid/teamgrid-federated-mcp:latest' },
    { databaseNetwork: 'teamgrid_default' },
    { runtimeDirectory: 'relative' },
    { browserServiceIps: [] },
    { browserServiceIps: ['0.0.0.0/0'] },
    { browserServiceIps: ['127.0.0.1', '127.0.0.1'] },
    { unknown: true },
  ])
    assert.throws(() =>
      createSelfHostedArtifacts(hostingConfig(), { ...specification(), ...patch }),
    )
  assert.throws(() =>
    createSelfHostedArtifacts(
      { ...hostingConfig(), listen: { host: '127.0.0.1', port: 8080 } },
      specification(),
    ),
  )
})
test('CLI preparation requires closed private inputs and never overwrites an existing artifact directory', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'teamgrid-self-hosting-'))
  const configPath = join(directory, 'service.json'),
    specPath = join(directory, 'deployment.json')
  const environment = {
    TEAMGRID_FEDERATION_CONFIG_FILE: configPath,
    TEAMGRID_FEDERATION_DEPLOYMENT_FILE: specPath,
  }
  const write = (path, value) => {
    writeFileSync(path, JSON.stringify(value))
    chmodSync(path, 0o600)
  }
  try {
    write(configPath, { ...hostingConfig(), enabled: true })
    write(specPath, specification())
    assert.throws(() => prepareSelfHosted(environment, join(directory, 'active')))
    write(configPath, hostingConfig())
    const output = join(directory, 'prepared')
    prepareSelfHosted(environment, output)
    assert.equal(statSync(output).mode & 0o777, 0o700)
    for (const name of ['compose.json', 'Caddyfile.site', 'caddy-network.review.json'])
      assert.equal(statSync(join(output, name)).mode & 0o777, 0o600)
    assert.equal(
      JSON.parse(readFileSync(join(output, 'compose.json'))).name,
      specification().project,
    )
    assert.throws(() => prepareSelfHosted(environment, output))
    assert.throws(() => prepareSelfHosted(environment, 'relative'))
    chmodSync(configPath, 0o644)
    assert.throws(() => prepareSelfHosted(environment, join(directory, 'public-input')))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
