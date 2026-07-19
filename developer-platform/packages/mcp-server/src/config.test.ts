import { describe, expect, it, vi } from 'vitest'
import { createMcpApiClient, parseMcpArguments } from './config.js'

const token = // gitleaks:allow -- synthetic fixed-format test credential
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('TeamGrid MCP configuration', () => {
  it('parses authentication and least-privilege tool profiles independently', () => {
    expect(parseMcpArguments(['--tool-profile', 'governance', '--profile', 'automation'])).toEqual({
      profile: 'automation',
      toolProfile: 'governance',
    })
    expect(() => parseMcpArguments(['--tool-profile', 'unknown'])).toThrow(
      "MCP tool profile must be 'core', 'collaboration', 'governance', or 'all'.",
    )
  })

  it('uses an explicit profile without exposing its keychain credential', async () => {
    const get = vi.fn(async () => token)
    const client = await createMcpApiClient(['--profile', 'automation'], {
      configStore: {
        load: async () => ({
          currentProfile: 'default',
          profiles: {
            automation: {
              baseUrl: 'https://api.us.teamgrid.app/v1',
              cellId: 'us-mnz-001',
              createdAt: '2026-07-16T00:00:00.000Z',
              credentialId: '0123456789abcdef01234567',
              region: 'us',
            },
          },
          version: 1,
        }),
      } as never,
      credentialStore: { delete: vi.fn(), get, set: vi.fn() },
      environment: {},
    })
    expect(client.location).toMatchObject({ cellId: 'us-mnz-001', region: 'us' })
    expect(get).toHaveBeenCalledWith('automation')
    expect(JSON.stringify(client)).not.toContain(token)
  })

  it('rejects unknown arguments before reading secrets', async () => {
    const get = vi.fn(async () => token)
    await expect(
      createMcpApiClient(['--unknown'], {
        configStore: { load: vi.fn() } as never,
        credentialStore: { delete: vi.fn(), get, set: vi.fn() },
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' })
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects a keychain credential that no longer matches profile routing metadata', async () => {
    await expect(
      createMcpApiClient(['--profile', 'automation'], {
        configStore: {
          load: async () => ({
            profiles: {
              automation: {
                cellId: 'de-nbg-001',
                createdAt: '2026-07-16T00:00:00.000Z',
                credentialId: 'ffffffffffffffffffffffff',
                region: 'de',
              },
            },
            version: 1,
          }),
        } as never,
        credentialStore: {
          delete: vi.fn(),
          get: vi.fn(async () => token),
          set: vi.fn(),
        },
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'profile_credential_mismatch' })
  })
})
