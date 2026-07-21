import { describe, expect, it } from 'vitest'
import { verifyProductionReleaseEvidence } from './verify-production-release-evidence.mjs'

const appSha = 'a'.repeat(40)
const apiRuntimeSha = '810b24b98d73dffbca21643cfe267d27cf988f1e'
const apiSourceCommit = '96fe8ca0d9aefd68a8cb602ab7cf14a652e9e6f4'
const developerPlatformSha = 'c'.repeat(40)
const manifestSha = 'd'.repeat(64)
const deRunId = '321'
const usRunId = '654'
const deRunUrl = `https://github.com/TeamGrid/teamgrid/actions/runs/${deRunId}`
const usRunUrl = `https://github.com/TeamGrid/teamgrid/actions/runs/${usRunId}`

function fixtures() {
  const common = {
    apiTag: apiRuntimeSha,
    appTag: appSha,
    contractManifestSha256: manifestSha,
    developerPlatformRef: developerPlatformSha,
    evidenceContract: 'teamgrid-developer-platform-deployment-evidence-v5',
    producerAppSha: appSha,
    schemaVersion: 5,
  }
  return {
    apiRuntimeSha,
    apiSourceCommit,
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
      apiSourceCommit,
      apiTag: apiRuntimeSha,
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

  it('accepts a runtime commit that differs from the OpenAPI contract source commit', () => {
    const value = fixtures()
    expect(value.apiRuntimeSha).not.toBe(value.apiSourceCommit)
    expect(() => verifyProductionReleaseEvidence(value)).not.toThrow()
  })

  it('rejects production evidence whose API image differs from the expected runtime commit', () => {
    const value = fixtures()
    value.apiRuntimeSha = 'e'.repeat(40)
    expect(() => verifyProductionReleaseEvidence(value)).toThrow(
      'US promotion evidence revisions or contract are malformed',
    )
  })

  it('rejects malformed contract-source and runtime revisions independently', () => {
    const malformedSource = fixtures()
    malformedSource.apiSourceCommit = 'not-a-source-sha'
    expect(() => verifyProductionReleaseEvidence(malformedSource)).toThrow(
      'expected OpenAPI source commit is malformed',
    )

    const malformedRuntime = fixtures()
    malformedRuntime.apiRuntimeSha = 'not-a-runtime-sha'
    expect(() => verifyProductionReleaseEvidence(malformedRuntime)).toThrow(
      'expected API runtime SHA is malformed',
    )
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
