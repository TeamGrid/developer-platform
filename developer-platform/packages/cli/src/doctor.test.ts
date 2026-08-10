import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { TeamGridApiError, TeamGridClientError } from '@teamgrid/api-client'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from './config.js'
import type { CredentialStore } from './credentialStore.js'
import { runCli } from './run.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>()
  async delete(profile: string) {
    this.values.delete(profile)
  }
  async get(profile: string) {
    return this.values.get(profile) || null
  }
  async set(profile: string, value: string) {
    this.values.set(profile, value)
  }
}

function capture() {
  const stream = new PassThrough()
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    value += chunk
  })
  return { stream, value: () => value }
}

function healthyClient() {
  return {
    system: {
      getApiVersion: vi.fn(async () => ({
        data: {
          contractVersion: '1.0.0',
          region: 'us',
          status: 'operational',
          supportedClients: { cli: { minimumVersion: '1.0.0', supportedMajor: 1 } },
          version: '1',
        },
        meta: { requestId: 'request-version' },
        transport: { attempts: 1 },
      })),
      getCapabilities: vi.fn(async () => ({
        data: [{ id: 'api-v1', type: 'systemCapability' }],
        meta: { requestId: 'request-capabilities' },
      })),
    },
  }
}

async function configured() {
  const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-doctor-'))
  const configStore = new ConfigStore({ configPath: join(directory, 'config.json') })
  await configStore.save({
    currentProfile: 'default',
    profiles: {
      default: {
        baseUrl: 'https://api.us.teamgrid.app/v1',
        cellId: 'us-mnz-001',
        createdAt: '2026-08-01T00:00:00.000Z',
        credentialId: '0123456789abcdef01234567',
        region: 'us',
      },
    },
    version: 1,
  })
  const credentialStore = new MemoryCredentialStore()
  credentialStore.values.set('default', token)
  return { configStore, credentialStore }
}

describe('TeamGrid CLI doctor', () => {
  it('reports secret-free local, network, compatibility, and capability checks as JSON', async () => {
    const { configStore, credentialStore } = await configured()
    const output = capture()
    const errorOutput = capture()
    const client = healthyClient()
    const clientFactory = vi.fn(() => client as never)

    expect(
      await runCli(['node', 'teamgrid', '--output', 'json', 'doctor'], {
        clientFactory,
        configStore,
        credentialStore,
        environment: {},
        errorOutput: errorOutput.stream,
        output: output.stream,
      }),
    ).toBe(0)

    const report = JSON.parse(output.value())
    expect(report).toMatchObject({
      api: { capabilityCount: 1, contractVersion: '1.0.0', region: 'us' },
      baseUrl: 'https://api.us.teamgrid.app/v1',
      credentialSource: 'keychain',
      location: { cellId: 'us-mnz-001', region: 'us' },
      ok: true,
      profile: 'default',
    })
    expect(report.checks.map((check: { check: string }) => check.check)).toEqual([
      'configuration',
      'credential',
      'base-url',
      'network',
      'api-compatibility',
      'api-capabilities',
    ])
    expect(JSON.stringify(report)).not.toContain(token)
    expect(errorOutput.value()).toBe('')
    expect(clientFactory).toHaveBeenCalledWith({
      baseUrl: 'https://api.us.teamgrid.app/v1',
      retries: 2,
      timeoutMs: 30_000,
      token,
    })
  })

  it('uses authentication exit code 3 when the selected credential is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'teamgrid-cli-doctor-missing-'))
    const output = capture()
    const errorOutput = capture()
    const code = await runCli(['node', 'teamgrid', '--output', 'json', 'doctor'], {
      clientFactory: vi.fn(),
      configStore: new ConfigStore({ configPath: join(directory, 'config.json') }),
      credentialStore: new MemoryCredentialStore(),
      environment: {},
      errorOutput: errorOutput.stream,
      output: output.stream,
    })

    expect(code).toBe(3)
    expect(JSON.parse(output.value())).toMatchObject({
      credentialSource: 'none',
      ok: false,
    })
    expect(errorOutput.value()).toContain('Doctor found one or more failed checks')
  })

  it('returns authorization diagnostics and exit code 4 without exposing API details or tokens', async () => {
    const { configStore, credentialStore } = await configured()
    const output = capture()
    const errorOutput = capture()
    const client = healthyClient()
    client.system.getCapabilities.mockRejectedValueOnce(
      new TeamGridApiError({
        errors: [
          {
            code: 'scope_required',
            detail: `Missing workspace scope for ${token}`,
            status: '403',
            title: 'Forbidden',
          },
        ],
        requestId: 'request-doctor-403',
        retryAfterMs: 1000,
        status: 403,
      }),
    )

    const code = await runCli(['node', 'teamgrid', '--output', 'json', 'doctor'], {
      clientFactory: () => client as never,
      configStore,
      credentialStore,
      environment: {},
      errorOutput: errorOutput.stream,
      output: output.stream,
    })
    const serialized = `${output.value()}${errorOutput.value()}`
    const report = JSON.parse(output.value())

    expect(code).toBe(4)
    expect(report.checks.at(-1)).toMatchObject({
      check: 'api-capabilities',
      diagnostics: {
        code: 'scope_required',
        requestId: 'request-doctor-403',
        retryAfterMs: 1000,
        status: 403,
      },
      status: 'fail',
    })
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('Missing workspace scope')
  })

  it('returns network exit code 1 and a readable human report', async () => {
    const { configStore, credentialStore } = await configured()
    const output = capture()
    const errorOutput = capture()
    const client = healthyClient()
    client.system.getApiVersion.mockRejectedValueOnce(
      new TeamGridClientError('network_error', `Cannot reach endpoint with ${token}`),
    )

    const code = await runCli(['node', 'teamgrid', 'doctor'], {
      clientFactory: () => client as never,
      configStore,
      credentialStore,
      environment: {},
      errorOutput: errorOutput.stream,
      output: output.stream,
    })
    const serialized = `${output.value()}${errorOutput.value()}`

    expect(code).toBe(1)
    expect(output.value()).toContain('network')
    expect(output.value()).toContain('could not be reached')
    expect(serialized).not.toContain(token)
  })
})
