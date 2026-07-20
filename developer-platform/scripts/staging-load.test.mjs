import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLoadQualificationEvidence,
  latencySummary,
  loadScenarios,
  releaseLoadThresholds,
  resolveLoadQualificationConfig,
  runLoadQualification,
  writeLoadQualificationEvidence,
} from './staging-load.mjs'

function releaseEnvironment(overrides = {}) {
  return {
    TEAMGRID_API_BASE_URL: 'https://api-router-staging.teamgrid.app/v1',
    TEAMGRID_API_TOKEN: 'secret-load-token',
    TEAMGRID_LOAD_EVIDENCE_PATH: '/tmp/teamgrid-load-evidence.json',
    TEAMGRID_LOAD_EXPECTED_CELL_ID: 'de-nbg-001',
    TEAMGRID_LOAD_EXPECTED_REGION: 'de',
    TEAMGRID_LOAD_QUALIFY_RELEASE: 'true',
    ...overrides,
  }
}

function releaseConfig(overrides = {}) {
  return {
    ...resolveLoadQualificationConfig(releaseEnvironment()),
    ...overrides,
  }
}

function result(index, overrides = {}) {
  return {
    failureKind: null,
    latencyMs: 100,
    responseBytes: 1000,
    scenarioId: loadScenarios[index % loadScenarios.length].id,
    statusCode: 200,
    valid: true,
    ...overrides,
  }
}

function passingEvidence(overrides = {}) {
  const config = releaseConfig()
  return buildLoadQualificationEvidence({
    actualDurationMs: 240_000,
    config,
    generatedAt: '2026-07-20T00:00:00.000Z',
    maximumInFlight: 4,
    results: Array.from({ length: config.requestCount }, (_, index) => result(index)),
    runId: 'load-run-1',
    ...overrides,
  })
}

describe('bounded Developer Platform load qualification', () => {
  it('pins a release-safe profile below the shared pre-auth rate limit', () => {
    const config = resolveLoadQualificationConfig(releaseEnvironment())
    expect(config).toMatchObject({
      concurrency: 8,
      durationSeconds: 240,
      qualifying: true,
      requestCount: 720,
      requestsPerSecond: 3,
      timeoutMs: 10_000,
    })
    expect(() =>
      resolveLoadQualificationConfig(
        releaseEnvironment({
          TEAMGRID_LOAD_REQUESTS_PER_SECOND: '5',
        }),
      ),
    ).toThrow('3 to 3')
    expect(() =>
      resolveLoadQualificationConfig(
        releaseEnvironment({
          TEAMGRID_API_BASE_URL: 'https://api.teamgrid.app/v1',
        }),
      ),
    ).toThrow('outside staging')
  })

  it('calculates deterministic nearest-rank latency percentiles', () => {
    expect(latencySummary([1, 2, 3, 4, 100])).toEqual({
      maximum: 100,
      mean: 22,
      minimum: 1,
      p50: 3,
      p95: 100,
      p99: 100,
    })
  })

  it('requires zero errors, complete scenario coverage, throughput, and latency SLOs', () => {
    const evidence = passingEvidence()
    expect(evidence.result).toBe('passed')
    expect(evidence.violations).toEqual([])
    expect(evidence.metrics.attemptedRequests).toBe(releaseLoadThresholds.minimumRequests)
    expect(Object.keys(evidence.metrics.scenarios)).toEqual(loadScenarios.map((item) => item.id))

    const failingResults = Array.from(
      { length: releaseLoadThresholds.minimumRequests },
      (_, index) => result(index),
    )
    failingResults[0] = result(0, {
      failureKind: 'http-error',
      statusCode: 429,
      valid: false,
    })
    const failed = passingEvidence({ results: failingResults })
    expect(failed.result).toBe('failed')
    expect(failed.violations).toContain('request_failures_observed')
    expect(failed.violations).toContain('rate_limit_responses_observed')

    const isolatedSlowResults = Array.from(
      { length: releaseLoadThresholds.minimumRequests },
      (_, index) => result(index),
    )
    for (let index = 0; index < 48; index += loadScenarios.length) {
      isolatedSlowResults[index] = result(index, { latencyMs: 2_500 })
    }
    const isolatedSlow = passingEvidence({ results: isolatedSlowResults })
    expect(isolatedSlow.metrics.latencyMs.p95).toBe(100)
    expect(isolatedSlow.violations).toContain('scenario_workspace_p95_latency_exceeded')
  })

  it('runs bounded concurrent reads while keeping credentials out of evidence', async () => {
    const config = releaseConfig({
      concurrency: 2,
      durationSeconds: 1,
      qualifying: false,
      requestCount: 8,
      requestsPerSecond: 4,
    })
    const observedAuthorization = []
    const observedUrls = []
    const fetchImpl = async (url, options) => {
      observedAuthorization.push(options.headers.authorization)
      observedUrls.push(String(url))
      const requestId = options.headers['x-request-id']
      const workspace = String(url).includes('/workspace') && !String(url).includes('entitlements')
      return new Response(
        JSON.stringify({
          data: workspace ? { attributes: { cellId: 'de-nbg-001', region: 'de' } } : [],
          meta: { requestId },
        }),
        {
          headers: { 'content-type': 'application/json', 'x-request-id': requestId },
          status: 200,
        },
      )
    }
    const evidence = await runLoadQualification({
      config,
      fetchImpl,
      generatedAt: '2026-07-20T00:00:00.000Z',
      runId: 'bounded-test',
      sleep: () => Promise.resolve(),
    })
    expect(observedAuthorization).toEqual(Array(8).fill('Bearer secret-load-token'))
    expect(
      observedUrls.every((url) => url.startsWith('https://api-router-staging.teamgrid.app/v1/')),
    ).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain('secret-load-token')
    expect(evidence.metrics.attemptedRequests).toBe(8)
    expect(evidence.metrics.maximumInFlight).toBeLessThanOrEqual(2)
  })

  it('atomically writes immutable redacted evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teamgrid-load-'))
    const path = join(directory, 'nested', 'evidence.json')
    const evidence = passingEvidence()
    const digest = writeLoadQualificationEvidence(path, evidence)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(evidence)
  })
})
