import { describe, expect, it, vi } from 'vitest'
import { runCredentialCommand } from './credential.mjs'

function dependencies(overrides = {}) {
  return {
    credentialStore: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    },
    parseV1Credential: vi.fn(() => {
      throw new Error('not v1')
    }),
    promptSecret: vi.fn(async () => 'hidden-production-token'),
    ...overrides,
  }
}

describe('interactive conformance credential helper', () => {
  it('stores a prompted V0 credential without returning its value', async () => {
    const runtime = dependencies()
    const result = await runCredentialCommand({
      arguments_: ['store', '--version', 'v0', '--profile', 'conformance-v0'],
      dependenciesLoader: async () => runtime,
    })

    expect(runtime.credentialStore.set).toHaveBeenCalledWith(
      'conformance-v0',
      'hidden-production-token',
    )
    expect(result).toEqual({ profile: 'conformance-v0', stored: true, version: 'v0' })
    expect(JSON.stringify(result)).not.toContain('hidden-production-token')
  })

  it('validates V1 credentials before storing and supports non-secret status', async () => {
    const runtime = dependencies({
      credentialStore: {
        delete: vi.fn(async () => undefined),
        get: vi.fn(async () => 'hidden-production-token'),
        set: vi.fn(async () => undefined),
      },
      parseV1Credential: vi.fn(),
    })
    await runCredentialCommand({
      arguments_: ['store', '--version', 'v1', '--profile', 'default'],
      dependenciesLoader: async () => runtime,
    })
    const status = await runCredentialCommand({
      arguments_: ['status', '--version', 'v1', '--profile', 'default'],
      dependenciesLoader: async () => runtime,
    })

    expect(runtime.parseV1Credential).toHaveBeenCalledWith('hidden-production-token')
    expect(status).toEqual({ profile: 'default', stored: true, version: 'v1' })
  })

  it('rejects credentials with whitespace before touching the keychain', async () => {
    const runtime = dependencies({
      promptSecret: vi.fn(async () => 'invalid secret value'),
    })
    await expect(
      runCredentialCommand({
        arguments_: ['store', '--version', 'v0', '--profile', 'conformance-v0'],
        dependenciesLoader: async () => runtime,
      }),
    ).rejects.toThrow('invalid shape')
    expect(runtime.credentialStore.set).not.toHaveBeenCalled()
  })

  it('validates a native Keychain write and deletes an incorrectly classified credential', async () => {
    const runtime = dependencies({
      parseV1Credential: vi.fn(),
      promptAndStore: vi.fn(async () => 'valid-v1-production-token'),
    })
    await expect(
      runCredentialCommand({
        arguments_: ['store', '--version', 'v0', '--profile', 'conformance-v0'],
        dependenciesLoader: async () => runtime,
      }),
    ).rejects.toThrow('cannot be stored as a legacy V0 credential')
    expect(runtime.credentialStore.delete).toHaveBeenCalledWith('conformance-v0')
    expect(runtime.credentialStore.set).not.toHaveBeenCalled()
  })
})
