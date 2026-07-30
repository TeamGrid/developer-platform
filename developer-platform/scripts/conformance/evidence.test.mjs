import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConformanceEvidence, evidenceResult, writeConformanceEvidence } from './evidence.mjs'

function inventory() {
  return {
    contracts: { v0: { bytes: 10, sha256: 'a'.repeat(64) } },
    inventoryDigest: 'b'.repeat(64),
  }
}

function config() {
  return {
    mode: 'read-only',
    runId: 'run-1',
    target: {
      region: 'de',
      v0BaseUrl: 'https://api.teamgrid.app',
      v1BaseUrl: 'https://api.de.teamgrid.app/v1',
    },
  }
}

describe('production conformance evidence', () => {
  it('marks blocked coverage as incomplete and any failed operation as failed', () => {
    const base = {
      completedAt: '2026-07-30T12:01:00.000Z',
      config: config(),
      inventory: inventory(),
      startedAt: '2026-07-30T12:00:00.000Z',
    }
    const incomplete = buildConformanceEvidence({
      ...base,
      results: [
        evidenceResult({
          note: 'fixture required',
          operationId: 'getTask',
          outcome: 'blocked',
          version: 'v1',
        }),
      ],
    })
    const failed = buildConformanceEvidence({
      ...base,
      results: [
        evidenceResult({
          observedStatus: 500,
          operationId: 'getWorkspace',
          outcome: 'failed',
          version: 'v1',
        }),
      ],
    })

    expect(incomplete).toMatchObject({
      result: 'incomplete',
      summary: { byOutcome: { blocked: 1 }, total: 1 },
    })
    expect(failed.result).toBe('failed')
  })

  it('writes mode-0600 evidence atomically without runtime credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teamgrid-conformance-'))
    const path = join(directory, 'nested', 'evidence.json')
    const evidence = buildConformanceEvidence({
      completedAt: '2026-07-30T12:01:00.000Z',
      config: config(),
      inventory: inventory(),
      results: [],
      startedAt: '2026-07-30T12:00:00.000Z',
    })
    const digest = writeConformanceEvidence(path, evidence, {
      secrets: ['production-secret'],
    })

    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(evidence)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('refuses to persist evidence if a known secret leaks into any field', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'teamgrid-conformance-')), 'evidence.json')
    const evidence = buildConformanceEvidence({
      completedAt: '2026-07-30T12:01:00.000Z',
      config: config(),
      inventory: inventory(),
      results: [
        evidenceResult({
          note: 'unexpected production-secret',
          operationId: 'getWorkspace',
          outcome: 'failed',
          version: 'v1',
        }),
      ],
      startedAt: '2026-07-30T12:00:00.000Z',
    })

    expect(() =>
      writeConformanceEvidence(path, evidence, {
        secrets: ['production-secret'],
      }),
    ).toThrow('contains a runtime credential')
  })
})
