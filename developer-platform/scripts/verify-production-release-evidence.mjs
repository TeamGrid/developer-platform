import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha40 = /^[a-f0-9]{40}$/
const sha64 = /^[a-f0-9]{64}$/
const actionsRunUrl = /^https:\/\/github\.com\/TeamGrid\/teamgrid\/actions\/runs\/([0-9]+)$/
const tag = /^(current|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/

function fail(message) {
  throw new Error(`Production release evidence verification failed: ${message}`)
}

function assertExactKeys(value, expected, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${description} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(`${description} contains missing or unknown fields`)
  }
}

function assertRun(run, { name, runUrl }) {
  const match = actionsRunUrl.exec(runUrl)
  if (!match) fail('production release run URL is invalid')
  if (
    run.name !== name ||
    run.event !== 'workflow_dispatch' ||
    run.conclusion !== 'success' ||
    run.html_url !== runUrl ||
    String(run.id) !== match[1] ||
    !sha40.test(String(run.head_sha || ''))
  ) {
    fail(`${name} run metadata is not exact and successful`)
  }
}

const commonEvidenceKeys = [
  'apiTag',
  'appTag',
  'contractManifestSha256',
  'developerPlatformRef',
  'evidenceContract',
  'producerAppSha',
  'schemaVersion',
]

function assertCommonEvidence(
  evidence,
  { apiRuntimeSha, developerPlatformSha, manifestSha },
  description,
) {
  if (
    evidence.evidenceContract !== 'teamgrid-developer-platform-deployment-evidence-v5' ||
    evidence.schemaVersion !== 5 ||
    !sha40.test(String(evidence.apiTag || '')) ||
    !sha40.test(String(evidence.appTag || '')) ||
    !sha40.test(String(evidence.developerPlatformRef || '')) ||
    !sha40.test(String(evidence.producerAppSha || '')) ||
    !sha64.test(String(evidence.contractManifestSha256 || '')) ||
    evidence.apiTag !== apiRuntimeSha ||
    evidence.developerPlatformRef !== developerPlatformSha ||
    evidence.contractManifestSha256 !== manifestSha
  ) {
    fail(`${description} revisions or contract are malformed`)
  }
}

export function verifyProductionReleaseEvidence({
  apiSourceCommit,
  apiRuntimeSha,
  deCanaryEvidence,
  deCanaryRun,
  developerPlatformSha,
  manifestSha,
  productionReleaseRunUrl,
  usPromotionEvidence,
  usPromotionRun,
}) {
  if (!sha40.test(String(apiSourceCommit || ''))) {
    fail('expected OpenAPI source commit is malformed')
  }
  if (!sha40.test(String(apiRuntimeSha || ''))) {
    fail('expected API runtime SHA is malformed')
  }
  if (!sha40.test(String(developerPlatformSha || ''))) {
    fail('expected Developer Platform SHA is malformed')
  }
  if (!sha64.test(String(manifestSha || ''))) fail('expected manifest SHA-256 is malformed')

  assertRun(usPromotionRun, {
    name: 'Promote qualified release to US production',
    runUrl: productionReleaseRunUrl,
  })
  assertExactKeys(
    usPromotionEvidence,
    [...commonEvidenceKeys, 'sourceDeCanaryRunId'],
    'US promotion evidence',
  )
  assertCommonEvidence(
    usPromotionEvidence,
    { apiRuntimeSha, developerPlatformSha, manifestSha },
    'US promotion evidence',
  )
  if (
    usPromotionEvidence.producerAppSha !== usPromotionRun.head_sha ||
    usPromotionEvidence.appTag !== usPromotionRun.head_sha ||
    !/^[0-9]+$/.test(String(usPromotionEvidence.sourceDeCanaryRunId || ''))
  ) {
    fail('US promotion evidence is not bound to its exact App source and DE canary')
  }

  const deRunUrl = `https://github.com/TeamGrid/teamgrid/actions/runs/${usPromotionEvidence.sourceDeCanaryRunId}`
  assertRun(deCanaryRun, { name: 'Deploy DE production canary', runUrl: deRunUrl })
  assertExactKeys(
    deCanaryEvidence,
    [
      ...commonEvidenceKeys,
      'automationWorkerRuntime',
      'automationWorkerTag',
      'jobSchedulerTag',
      'jobWorkerRuntime',
      'releaseReason',
      'schedulingWorkerRuntime',
      'schedulingWorkerTag',
      'searchSyncRuntime',
      'stagingRunUrl',
      'workerTag',
    ],
    'DE canary evidence',
  )
  assertCommonEvidence(
    deCanaryEvidence,
    { apiRuntimeSha, developerPlatformSha, manifestSha },
    'DE canary evidence',
  )
  if (
    deCanaryEvidence.producerAppSha !== deCanaryRun.head_sha ||
    deCanaryEvidence.appTag !== deCanaryRun.head_sha ||
    deCanaryEvidence.appTag !== usPromotionEvidence.appTag ||
    deCanaryEvidence.apiTag !== usPromotionEvidence.apiTag ||
    deCanaryEvidence.developerPlatformRef !== usPromotionEvidence.developerPlatformRef ||
    deCanaryEvidence.contractManifestSha256 !== usPromotionEvidence.contractManifestSha256 ||
    typeof deCanaryEvidence.releaseReason !== 'string' ||
    deCanaryEvidence.releaseReason.trim().length === 0 ||
    !actionsRunUrl.test(String(deCanaryEvidence.stagingRunUrl || '')) ||
    !tag.test(String(deCanaryEvidence.workerTag || '')) ||
    !tag.test(String(deCanaryEvidence.automationWorkerTag || '')) ||
    !tag.test(String(deCanaryEvidence.schedulingWorkerTag || '')) ||
    !tag.test(String(deCanaryEvidence.jobSchedulerTag || '')) ||
    !['current', 'inapp', 'legacy'].includes(deCanaryEvidence.jobWorkerRuntime) ||
    !['current', 'disabled', 'legacy'].includes(deCanaryEvidence.automationWorkerRuntime) ||
    !['current', 'inapp', 'legacy'].includes(deCanaryEvidence.schedulingWorkerRuntime) ||
    !['current', 'external', 'inapp'].includes(deCanaryEvidence.searchSyncRuntime)
  ) {
    fail('DE and US evidence do not form one exact production promotion chain')
  }

  return {
    apiSourceCommit,
    apiTag: usPromotionEvidence.apiTag,
    appTag: usPromotionEvidence.appTag,
    deCanaryRunId: String(deCanaryRun.id),
    developerPlatformRef: usPromotionEvidence.developerPlatformRef,
    manifestSha256: usPromotionEvidence.contractManifestSha256,
    usPromotionRunId: String(usPromotionRun.id),
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) fail(`${name} is required`)
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyProductionReleaseEvidence({
    apiSourceCommit: readJson(new URL('../../openapi/source.json', import.meta.url)).sourceCommit,
    apiRuntimeSha: requiredEnvironment('EXPECTED_API_RUNTIME_SHA'),
    deCanaryEvidence: readJson(requiredEnvironment('DE_CANARY_EVIDENCE_PATH')),
    deCanaryRun: readJson(requiredEnvironment('DE_CANARY_RUN_PATH')),
    developerPlatformSha: requiredEnvironment('EXPECTED_DEVELOPER_PLATFORM_SHA'),
    manifestSha: requiredEnvironment('EXPECTED_MANIFEST_SHA256'),
    productionReleaseRunUrl: requiredEnvironment('PRODUCTION_RELEASE_RUN_URL'),
    usPromotionEvidence: readJson(requiredEnvironment('US_PROMOTION_EVIDENCE_PATH')),
    usPromotionRun: readJson(requiredEnvironment('US_PROMOTION_RUN_PATH')),
  })
  console.log(
    `Verified production release chain for App ${result.appTag}, API runtime ${result.apiTag}, ` +
      `and API contract source ${result.apiSourceCommit}.`,
  )
}
