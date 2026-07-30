import { describe, expect, it } from 'vitest'
import { executeReadOnlyConformance } from './read-only.mjs'

function operation(overrides = {}) {
  return {
    authenticated: true,
    compatibility: undefined,
    operationId: 'listTasks',
    parameters: [{ location: 'query', name: 'limit', required: false }],
    path: '/tasks',
    responseStatuses: ['200', '400', '401', '429'],
    risk: 'read',
    testability: { automaticReadProbe: true, requiresFixture: false },
    version: 'v1',
    ...overrides,
  }
}

function config() {
  return {
    mode: 'read-only',
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

describe('read-only production conformance runner', () => {
  it('probes only parameter-free reads with bounded pagination and correct credentials', async () => {
    const requests = []
    const results = await executeReadOnlyConformance({
      config: config(),
      fetchImpl: async (url, options) => {
        requests.push({ options, url: String(url) })
        return new Response('{}', {
          headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
          status: 200,
        })
      },
      inventory: {
        operations: [
          operation(),
          operation({
            authenticated: false,
            operationId: 'getApiVersion',
            parameters: [],
            path: '/',
          }),
          operation({
            operationId: 'getTask',
            parameters: [{ location: 'path', name: 'id', required: true }],
            path: '/tasks/{id}',
            testability: { automaticReadProbe: false, requiresFixture: true },
          }),
          operation({
            operationId: 'createTask',
            parameters: [],
            path: '/tasks',
            risk: 'mutation',
            testability: { automaticReadProbe: false, requiresFixture: true },
          }),
        ],
      },
      sleep: () => Promise.resolve(),
    })

    expect(requests).toHaveLength(2)
    expect(requests[0].url).toBe('https://api.de.teamgrid.app/v1/tasks?limit=1')
    expect(requests[0].options.headers.authorization).toBe('Bearer stable-secret')
    expect(requests[1].options.headers.authorization).toBeUndefined()
    expect(results).toMatchObject([
      { observedStatus: 200, operationId: 'listTasks', outcome: 'passed' },
      { observedStatus: 200, operationId: 'getApiVersion', outcome: 'passed' },
      { note: 'fixture_required', operationId: 'getTask', outcome: 'blocked' },
      {
        note: 'mutation_requires_certification_mode',
        operationId: 'createTask',
        outcome: 'blocked',
      },
    ])
    expect(JSON.stringify(results)).not.toContain('stable-secret')
  })

  it('accepts documented V0 unavailability and retries a bounded 429', async () => {
    let attempts = 0
    const results = await executeReadOnlyConformance({
      config: config(),
      fetchImpl: async () => {
        attempts += 1
        if (attempts === 1) {
          return new Response('{}', { headers: { 'retry-after': '0' }, status: 429 })
        }
        return new Response('{}', { status: 501 })
      },
      inventory: {
        operations: [
          operation({
            compatibility: { expectedUnavailable: true },
            operationId: 'v0_get_unavailable',
            parameters: [],
            path: '/unavailable',
            responseStatuses: ['200', '501'],
            version: 'v0',
          }),
        ],
      },
      sleep: () => Promise.resolve(),
    })

    expect(attempts).toBe(2)
    expect(results[0]).toMatchObject({
      attempts: 2,
      expectedStatus: [501],
      observedStatus: 501,
      outcome: 'passed',
    })
  })

  it('records transport failures without serializing exception or response bodies', async () => {
    const results = await executeReadOnlyConformance({
      config: config(),
      fetchImpl: async () => {
        throw new Error('sensitive upstream details')
      },
      inventory: { operations: [operation()] },
      sleep: () => Promise.resolve(),
    })

    expect(results[0]).toMatchObject({
      note: 'transport_error',
      operationId: 'listTasks',
      outcome: 'failed',
    })
    expect(JSON.stringify(results)).not.toContain('sensitive upstream details')
  })
})
