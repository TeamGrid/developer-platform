import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeSafeMutationSmokeConformance } from './safe-mutation-smoke.mjs'

function config(cleanupJournalPath, versions = ['v0', 'v1']) {
  return {
    cleanupJournalPath,
    fixtureNamespace: 'codex-conformance-acme-01',
    mode: 'safe-mutation-smoke',
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
    versions,
  }
}

function operation(overrides = {}) {
  return {
    authenticated: true,
    compatibility: undefined,
    method: 'POST',
    operationId: 'createTask',
    parameters: [],
    path: '/tasks',
    requiredParameters: [],
    responseStatuses: ['201', '400', '401', '403', '429'],
    risk: 'mutation',
    testability: { automaticReadProbe: false, requiresFixture: true },
    version: 'v1',
    ...overrides,
  }
}

function journalPath() {
  return join(mkdtempSync(join(tmpdir(), 'teamgrid-safe-mutation-smoke-')), 'cleanup.json')
}

describe('isolated production safe mutation smoke runner', () => {
  it('probes every selected mutation without a body and completes an empty cleanup journal', async () => {
    const path = journalPath()
    const requests = []
    const results = await executeSafeMutationSmokeConformance({
      config: config(path),
      fetchImpl: async (url, options) => {
        requests.push({ options, url: String(url) })
        return new Response('{}', { status: 400 })
      },
      inventory: {
        operations: [
          operation(),
          operation({
            method: 'DELETE',
            operationId: 'archiveTask',
            parameters: [{ location: 'path', name: 'id', required: true }],
            path: '/tasks/{id}',
            requiredParameters: [{ location: 'path', name: 'id', required: true }],
            risk: 'destructive-mutation',
          }),
        ],
      },
      now: () => new Date('2026-07-30T12:00:00.000Z'),
      sleep: () => Promise.resolve(),
    })

    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.options.body === undefined)).toBe(true)
    expect(requests[1].url).toContain('/tasks/tgConformanceMissing20260730')
    expect(results.every((result) => result.outcome === 'passed')).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      resources: [],
      state: 'complete',
    })
  })

  it('uses harmless required query values and requires successful fixture-free reads', async () => {
    const path = journalPath()
    const urls = []
    const results = await executeSafeMutationSmokeConformance({
      config: config(path, ['v1']),
      fetchImpl: async (url) => {
        urls.push(String(url))
        return new Response('{}', { status: 200 })
      },
      inventory: {
        operations: [
          operation({
            method: 'GET',
            operationId: 'listAvailability',
            parameters: [
              { location: 'query', name: 'start', required: true },
              { location: 'query', name: 'end', required: true },
              { location: 'query', name: 'timeZone', required: true },
            ],
            path: '/availability',
            requiredParameters: [
              { location: 'query', name: 'start', required: true },
              { location: 'query', name: 'end', required: true },
              { location: 'query', name: 'timeZone', required: true },
            ],
            responseStatuses: ['200', '400'],
            risk: 'read',
          }),
          operation({
            method: 'GET',
            operationId: 'listTasks',
            path: '/tasks',
            responseStatuses: ['200', '400'],
            risk: 'read',
            testability: { automaticReadProbe: true, requiresFixture: false },
          }),
        ],
      },
      now: () => new Date('2026-07-30T12:00:00.000Z'),
      sleep: () => Promise.resolve(),
    })

    expect(urls[0]).toContain('start=2026-01-01T00%3A00%3A00.000Z')
    expect(urls[0]).toContain('timeZone=UTC')
    expect(results).toMatchObject([
      { note: 'safe_negative_fixture_probe', outcome: 'passed' },
      { note: 'live_read_succeeded', outcome: 'passed' },
    ])
  })

  it('stops immediately and leaves a crash-recovery journal if a mutation succeeds', async () => {
    const path = journalPath()

    await expect(
      executeSafeMutationSmokeConformance({
        config: config(path),
        fetchImpl: async () => new Response('{"id":"unexpected"}', { status: 201 }),
        inventory: { operations: [operation()] },
        now: () => new Date('2026-07-30T12:00:00.000Z'),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow('unsafe unexpected success')

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      resources: [],
      state: 'pending',
    })
  })

  it('does not accept authentication, rate-limit, or server failures as passing evidence', async () => {
    for (const status of [401, 429, 500, 503]) {
      const [result] = await executeSafeMutationSmokeConformance({
        config: config(journalPath()),
        fetchImpl: async () => new Response('{}', { status }),
        inventory: { operations: [operation()] },
        now: () => new Date('2026-07-30T12:00:00.000Z'),
        sleep: () => Promise.resolve(),
      })
      expect(result).toMatchObject({ observedStatus: status, outcome: 'failed' })
    }
  })
})
