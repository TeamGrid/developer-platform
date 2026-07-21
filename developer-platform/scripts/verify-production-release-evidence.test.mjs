import { describe, expect, it } from 'vitest'
import { verifyProductionReleaseEvidence } from './verify-production-release-evidence.mjs'

const appSha = 'a'.repeat(40)
const apiSha = 'b'.repeat(40)
const developerPlatformSha = 'c'.repeat(40)
const manifestSha = 'd'.repeat(64)
const deRunId = '321'
const usRunId = '654'
const deRunUrl = `https://github.com/TeamGrid/teamgrid/actions/runs/${deRunId}`
const usRunUrl = `https://github.com/TeamGrid/teamgrid/actions/runs/${usRunId}`

function fixtures() {
  const common = {
    apiTag: apiSha,
    appTag: appSha,
    contractManifestSha256: manifestSha,
    developerPlatformRef: developerPlatformSha,
    evidenceContract: 'teamgrid-developer-platform-deployment-evidence-v2',
    producerAppSha: appSha,
    schemaVersion: 2,
  }
  return {
    deCanaryEvidence: {
      ...common,
      automationWorkerRuntime: 'current',
      automationWorkerTag: 'current',
      jobSchedulerTag: 'current',
      jobWorkerRuntime: 'inapp',
      releaseReason: 'Qualify Developer Platform',
      schedulingWorkerRuntime: 'inapp',
      schedulingWorkerTag: 'current',
      searchSyncRuntime: 'inapp',
      stagingRunUrl: 'https://github.com/TeamGrid/teamgrid/actions/runs/123',
      workerTag: 'current',
    },
    deCanaryRun: {
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_sha: appSha,
      html_url: deRunUrl,
      id: Number(deRunId),
      name: 'Deploy DE production canary',
    },
    developerPlatformSha,
    manifestSha,
    productionReleaseRunUrl: usRunUrl,
    usPromotionEvidence: { ...common, sourceDeCanaryRunId: deRunId },
    usPromotionRun: {
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_sha: appSha,
      html_url: usRunUrl,
      id: Number(usRunId),
      name: 'Promote qualified release to US production',
    },
  }
}

describe('npm production release evidence', () => {
  it('accepts one exact successful Staging-to-DE-to-US release chain', () => {
    expect(verifyProductionReleaseEvidence(fixtures())).toEqual({
      apiTag: apiSha,
      appTag: appSha,
      deCanaryRunId: deRunId,
      developerPlatformRef: developerPlatformSha,
      manifestSha256: manifestSha,
      usPromotionRunId: usRunId,
    })
  })

  it('rejects DE-only evidence and the retired workflow name', () => {
    const value = fixtures()
    value.usPromotionRun.name = 'Deploy multi-cell production'
    expect(() => verifyProductionReleaseEvidence(value)).toThrow(
      'Promote qualified release to US production run metadata',
    )
  })

  it('rejects a workflow dispatched from a different App source', () => {
    const value = fixtures()
    value.usPromotionRun.head_sha = 'e'.repeat(40)
    expect(() => verifyProductionReleaseEvidence(value)).toThrow(
      'US promotion evidence is not bound to its exact App source',
    )
  })

  it('rejects cross-release API, App, manifest, or Developer Platform evidence', () => {
    for (const [field, replacement] of [
      ['apiTag', 'e'.repeat(40)],
      ['appTag', 'e'.repeat(40)],
      ['contractManifestSha256', 'e'.repeat(64)],
      ['developerPlatformRef', 'e'.repeat(40)],
    ]) {
      const value = fixtures()
      value.deCanaryEvidence[field] = replacement
      expect(() => verifyProductionReleaseEvidence(value)).toThrow()
    }
  })

  it('rejects unknown evidence fields and non-successful explicit runs', () => {
    const unknown = fixtures()
    unknown.usPromotionEvidence.url = 'https://storage.example.test/private'
    expect(() => verifyProductionReleaseEvidence(unknown)).toThrow('missing or unknown fields')

    const failed = fixtures()
    failed.deCanaryRun.conclusion = 'failure'
    expect(() => verifyProductionReleaseEvidence(failed)).toThrow(
      'Deploy DE production canary run metadata',
    )
  })
})
