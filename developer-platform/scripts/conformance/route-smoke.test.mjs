import { describe, expect, it } from 'vitest'
import { executeRouteSmokeConformance } from './route-smoke.mjs'

function config() {
  return {
    mode: 'route-smoke',
    pageLimit: 1,
    requestIntervalMs: 250,
    requestTimeoutMs: 1_000,
    runId: 'run-1',
    secrets: {
      TEAMGRID_CONFORMANCE_V0_TOKEN: 'legacy-secret',
      TEAMGRID_CONFORMANCE_V1_TOKEN: 'stable-secret',
    },
    target: {
      region: 'de',
      v0BaseUrl: 'https://api.teamgrid.app',
      v1BaseUrl: 'https://api.de.teamgrid.app/v1',
    },
    versions: ['v0', 'v1'],
  }
}

function operation(overrides = {}) {
  return {
    authenticated: true,
    compatibility: undefined,
    method: 'GET',
    operationId: 'getTask',
    parameters: [{ location: 'path', name: 'id', required: true }],
    path: '/tasks/{id}',
    responseStatuses: ['200', '404'],
    risk: 'read',
    testability: { automaticReadProbe: false, requiresFixture: true },
    version: 'v1',
    ...overrides,
  }
}

describe('safe production route smoke runner', () => {
  it('exercises missing-fixture reads and blocks every mutation', async () => {
    const requests = []
    const results = await executeRouteSmokeConformance({
      config: config(),
      fetchImpl: async (url, options) => {
        requests.push({ options, url: String(url) })
        return new Response('{}', { status: 404 })
      },
      inventory: {
        operations: [
          operation(),
          operation({
            method: 'DELETE',
            operationId: 'archiveTask',
            risk: 'destructive-mutation',
          }),
        ],
      },
      sleep: () => Promise.resolve(),
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toContain('/tasks/tgConformanceMissing20260730')
    expect(requests[0].options.redirect).toBe('manual')
    expect(results).toMatchObject([
      { note: 'safe_negative_route_probe', observedStatus: 404, outcome: 'passed' },
      {
        note: 'mutation_requires_certification_mode',
        operationId: 'archiveTask',
        outcome: 'blocked',
      },
    ])
  })

  it('never sends a mutation even if the supplied transport would accept it', async () => {
    let requests = 0
    const [result] = await executeRouteSmokeConformance({
      config: config(),
      fetchImpl: async () => {
        requests += 1
        return new Response(null, { status: 204 })
      },
      inventory: {
        operations: [
          operation({
            method: 'DELETE',
            operationId: 'archiveTask',
            risk: 'destructive-mutation',
          }),
        ],
      },
      sleep: () => Promise.resolve(),
    })

    expect(requests).toBe(0)
    expect(result).toMatchObject({
      note: 'mutation_requires_certification_mode',
      outcome: 'blocked',
    })
  })

  it('requires successful documented responses for parameter-free reads', async () => {
    const [result] = await executeRouteSmokeConformance({
      config: config(),
      fetchImpl: async () => new Response('{}', { status: 502 }),
      inventory: {
        operations: [
          operation({
            operationId: 'listTasks',
            parameters: [],
            path: '/tasks',
            responseStatuses: ['200', '400'],
            testability: { automaticReadProbe: true, requiresFixture: false },
          }),
        ],
      },
      sleep: () => Promise.resolve(),
    })

    expect(result).toMatchObject({
      note: 'unexpected_status',
      observedStatus: 502,
      outcome: 'failed',
    })
  })
})
