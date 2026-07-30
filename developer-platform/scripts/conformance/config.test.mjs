import { describe, expect, it } from 'vitest'
import {
  hydrateConformanceCredentials,
  knownSecrets,
  redactedConfig,
  resolveConformanceConfig,
} from './config.mjs'

const fixedNow = new Date('2026-07-30T12:00:00.000Z')

function liveEnvironment(overrides = {}) {
  return {
    TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION: 'true',
    TEAMGRID_CONFORMANCE_EVIDENCE_PATH: './evidence/result.json',
    TEAMGRID_CONFORMANCE_REGION: 'de',
    TEAMGRID_CONFORMANCE_V0_BASE_URL: 'https://api.teamgrid.app',
    TEAMGRID_CONFORMANCE_V0_TOKEN: 'legacy-production-secret',
    TEAMGRID_CONFORMANCE_V1_BASE_URL: 'https://api.de.teamgrid.app/v1',
    TEAMGRID_CONFORMANCE_V1_TOKEN: 'stable-production-secret',
    ...overrides,
  }
}

describe('production conformance configuration', () => {
  it('builds a plan without reading or retaining live credentials', () => {
    const config = resolveConformanceConfig({
      environment: liveEnvironment(),
      mode: 'plan',
      pageLimit: 1,
      now: fixedNow,
      runId: 'plan',
    })

    expect(config).toMatchObject({
      mode: 'plan',
      runId: 'tg-conformance-20260730T120000000Z-plan',
      secrets: null,
      target: null,
    })
    expect(JSON.stringify(config)).not.toContain('production-secret')
  })

  it('requires an explicit production unlock and canonical region target', () => {
    expect(() =>
      resolveConformanceConfig({
        environment: liveEnvironment({ TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION: '' }),
        mode: 'read-only',
      }),
    ).toThrow('ALLOW_PRODUCTION=true')

    expect(() =>
      resolveConformanceConfig({
        environment: liveEnvironment({
          TEAMGRID_CONFORMANCE_V1_BASE_URL: 'https://api.us.teamgrid.app/v1',
        }),
        mode: 'read-only',
      }),
    ).toThrow('disagree')

    expect(() =>
      resolveConformanceConfig({
        environment: liveEnvironment({
          TEAMGRID_CONFORMANCE_V0_BASE_URL: 'https://example.com',
        }),
        mode: 'read-only',
      }),
    ).toThrow('not a canonical production target')
  })

  it('keeps runtime secrets separate from serializable evidence metadata', () => {
    const config = resolveConformanceConfig({
      environment: liveEnvironment(),
      mode: 'read-only',
      now: fixedNow,
      runId: 'read',
    })

    expect(knownSecrets(config)).toEqual(['legacy-production-secret', 'stable-production-secret'])
    expect(JSON.stringify(redactedConfig(config))).not.toContain('production-secret')
  })

  it('accepts only a bounded cross-surface page limit', () => {
    expect(
      resolveConformanceConfig({
        environment: liveEnvironment({ TEAMGRID_CONFORMANCE_PAGE_LIMIT: '100' }),
        mode: 'read-only',
      }),
    ).toMatchObject({ pageLimit: 100 })
    expect(() =>
      resolveConformanceConfig({
        environment: liveEnvironment({ TEAMGRID_CONFORMANCE_PAGE_LIMIT: '101' }),
        mode: 'read-only',
      }),
    ).toThrow('PAGE_LIMIT must be an integer from 1 to 100')
  })

  it('can load a V1-only production credential from the existing CLI keychain profile', async () => {
    const config = resolveConformanceConfig({
      environment: {
        TEAMGRID_CONFORMANCE_ALLOW_PRODUCTION: 'true',
        TEAMGRID_CONFORMANCE_EVIDENCE_PATH: './evidence/result.json',
        TEAMGRID_CONFORMANCE_REGION: 'de',
        TEAMGRID_CONFORMANCE_V1_BASE_URL: 'https://api.de.teamgrid.app/v1',
        TEAMGRID_CONFORMANCE_V1_PROFILE: 'default',
        TEAMGRID_CONFORMANCE_VERSIONS: 'v1',
      },
      mode: 'read-only',
    })
    const hydrated = await hydrateConformanceCredentials(config, {
      credentialStoreLoader: async () => ({
        get: async () => 'keychain-production-secret',
      }),
    })

    expect(config).toMatchObject({
      credentialProfiles: { v1: 'default' },
      secrets: {},
      versions: ['v1'],
    })
    expect(knownSecrets(hydrated)).toEqual(['keychain-production-secret'])
    expect(JSON.stringify(redactedConfig(hydrated))).not.toContain('keychain-production-secret')
  })

  it('requires a deliberate namespace and mutation unlock for certification', () => {
    expect(() =>
      resolveConformanceConfig({
        environment: liveEnvironment(),
        mode: 'certification',
      }),
    ).toThrow('ALLOW_MUTATIONS=true')

    expect(() =>
      resolveConformanceConfig({
        environment: liveEnvironment({
          TEAMGRID_CONFORMANCE_ALLOW_MUTATIONS: 'true',
          TEAMGRID_CONFORMANCE_CLEANUP_JOURNAL_PATH: './evidence/cleanup.json',
          TEAMGRID_CONFORMANCE_FIXTURE_NAMESPACE: 'customer-data',
        }),
        mode: 'certification',
      }),
    ).toThrow('must start with codex-conformance-')

    expect(
      resolveConformanceConfig({
        environment: liveEnvironment({
          TEAMGRID_CONFORMANCE_ALLOW_MUTATIONS: 'true',
          TEAMGRID_CONFORMANCE_CLEANUP_JOURNAL_PATH: './evidence/cleanup.json',
          TEAMGRID_CONFORMANCE_FIXTURE_NAMESPACE: 'codex-conformance-acme-01',
        }),
        mode: 'certification',
      }),
    ).toMatchObject({
      cleanupJournalPath: expect.stringContaining('evidence/cleanup.json'),
      fixtureNamespace: 'codex-conformance-acme-01',
      mode: 'certification',
    })
  })
})
