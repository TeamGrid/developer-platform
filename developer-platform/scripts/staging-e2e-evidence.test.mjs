import { describe, expect, it } from 'vitest'
import {
  buildQualificationEvidence,
  resolveQualificationConfig,
  writeQualificationEvidence,
} from './staging-e2e-evidence.mjs'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const shaC = 'c'.repeat(40)
const shaD = 'd'.repeat(40)
const manifestSha = 'e'.repeat(64)

function qualifyingEnvironment(overrides = {}) {
  return {
    TEAMGRID_E2E_API_GIT_SHA: shaB,
    TEAMGRID_E2E_APP_GIT_SHA: shaA,
    TEAMGRID_E2E_CONTRACT_MANIFEST_SHA256: manifestSha,
    TEAMGRID_E2E_DEVELOPER_PLATFORM_GIT_SHA: shaC,
    TEAMGRID_E2E_EVIDENCE_PATH: '/tmp/teamgrid-evidence.json',
    TEAMGRID_E2E_EXPECTED_CELL_ID: 'us-mnz-001',
    TEAMGRID_E2E_EXPECTED_REGION: 'us',
    TEAMGRID_E2E_EXPIRED_API_TOKEN: 'expired',
    TEAMGRID_E2E_FOREIGN_TASK_ID: 'foreign-task',
    TEAMGRID_E2E_PRODUCER_GIT_SHA: shaD,
    TEAMGRID_E2E_QUALIFY_RELEASE: 'true',
    TEAMGRID_E2E_READ_ONLY_API_TOKEN: 'read-only',
    TEAMGRID_E2E_WORKFLOW_RUN_URL: 'https://github.com/TeamGrid/teamgrid/actions/runs/123',
    TEAMGRID_E2E_WEBHOOK_DELIVERY: 'true',
    TEAMGRID_E2E_WRONG_CELL_API_TOKEN: 'wrong-cell',
    TEAMGRID_API_ORIGIN_URL: 'https://api-origin-staging.teamgrid.app',
    ...overrides,
  }
}

function qualifyingClaims(overrides = {}) {
  return {
    auditEventsVerified: 5,
    binaryCliVerified: true,
    binaryMcpVerified: true,
    changeFeedVerified: true,
    customFieldValuesVerified: true,
    expiredCredentialVerified: true,
    foreignTenantMissVerified: true,
    idempotencyReplayVerified: true,
    negativeAuthVerified: true,
    originAuthVerified: true,
    plannedWorkVerified: true,
    privateExportVerified: true,
    projectTemplatesVerified: true,
    readOnlyScopeVerified: true,
    signedWebhookDeliveryVerified: true,
    webhookCaptureCleanupVerified: true,
    wrongCellRoutingVerified: true,
    ...overrides,
  }
}

function qualifyingCleanup(overrides = {}) {
  const record = {
    cleanupAttempted: true,
    cleanupSucceeded: true,
    created: true,
    reconciliationVerified: true,
  }
  return {
    complete: true,
    reconciled: true,
    resources: Object.fromEntries([
      'customFieldDefinition',
      'instantiatedProject',
      'projectTemplate',
      'sourceProject',
      'task',
      'timeEntry',
      'webhook',
      'webhookCaptureReceiver',
    ].map(resource => [resource, { ...record }])),
    ...overrides,
  }
}

describe('release-qualifying staging E2E contract', () => {
  it('requires all four negative-security fixtures before any mutations run', () => {
    for (const name of [
      'TEAMGRID_E2E_EXPIRED_API_TOKEN',
      'TEAMGRID_E2E_FOREIGN_TASK_ID',
      'TEAMGRID_E2E_READ_ONLY_API_TOKEN',
      'TEAMGRID_E2E_WRONG_CELL_API_TOKEN',
    ]) {
      expect(() => resolveQualificationConfig(qualifyingEnvironment({ [name]: '' })))
        .toThrow(`${name} is required`)
    }
    expect(() => resolveQualificationConfig(qualifyingEnvironment({
      TEAMGRID_E2E_WEBHOOK_DELIVERY: 'false',
    }))).toThrow('TEAMGRID_E2E_WEBHOOK_DELIVERY must be true')
  })

  it('accepts exact US bindings and rejects conflicting region/cell targets', () => {
    expect(resolveQualificationConfig(qualifyingEnvironment())).toMatchObject({
      bindings: {
        apiGitSha: shaB,
        appGitSha: shaA,
        contractManifestSha256: manifestSha,
        developerPlatformGitSha: shaC,
        producerGitSha: shaD,
      },
      expectedCellId: 'us-mnz-001',
      expectedRegion: 'us',
      qualifying: true,
    })
    expect(() => resolveQualificationConfig(qualifyingEnvironment({
      TEAMGRID_E2E_EXPECTED_REGION: 'de',
    }))).toThrow('disagree')
  })

  it('keeps local smoke explicitly non-qualifying and fixture-compatible', () => {
    expect(resolveQualificationConfig({ TEAMGRID_E2E_QUALIFY_RELEASE: 'false' })).toEqual({
      bindings: undefined,
      evidencePath: undefined,
      expectedCellId: undefined,
      expectedRegion: undefined,
      qualifying: false,
    })
  })

  it('refuses passed evidence without mandatory claims or reconciled cleanup', () => {
    const base = {
      bindings: resolveQualificationConfig(qualifyingEnvironment()).bindings,
      claims: qualifyingClaims(),
      cleanup: qualifyingCleanup(),
      qualifying: true,
      runId: 'run-1',
      target: { cellId: 'de-nbg-001', region: 'de' },
    }
    expect(() => buildQualificationEvidence({
      ...base,
      claims: { ...base.claims, readOnlyScopeVerified: false },
    })).toThrow('readOnlyScopeVerified')
    expect(() => buildQualificationEvidence({
      ...base,
      claims: { ...base.claims, privateExportVerified: false },
    })).toThrow('privateExportVerified')
    expect(() => buildQualificationEvidence({
      ...base,
      cleanup: { complete: false, reconciled: false },
    })).toThrow('reconciled cleanup')
  })

  it('atomically writes deterministic machine-readable evidence and returns its digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teamgrid-e2e-'))
    const path = join(directory, 'nested', 'evidence.json')
    const evidence = buildQualificationEvidence({
      bindings: resolveQualificationConfig(qualifyingEnvironment()).bindings,
      claims: qualifyingClaims(),
      cleanup: qualifyingCleanup(),
      generatedAt: '2026-07-20T00:00:00.000Z',
      qualifying: true,
      runId: 'run-1',
      target: { cellId: 'us-mnz-001', region: 'us' },
    })
    const digest = writeQualificationEvidence(path, evidence)
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(evidence)
  })
})
