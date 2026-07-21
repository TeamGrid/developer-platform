import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const sha40 = /^[a-f0-9]{40}$/
const sha64 = /^[a-f0-9]{64}$/
const cellIdPattern = /^(?:de|us)-[a-z0-9]+-[0-9]{3}$/
const requiredNegativeInputs = [
  'TEAMGRID_E2E_EXPIRED_API_TOKEN',
  'TEAMGRID_E2E_FOREIGN_TASK_ID',
  'TEAMGRID_E2E_READ_ONLY_API_TOKEN',
  'TEAMGRID_E2E_WRONG_CELL_API_TOKEN',
]
const requiredQualifyingClaims = [
  'binaryCliVerified',
  'binaryMcpVerified',
  'customFieldValuesVerified',
  'expiredCredentialVerified',
  'foreignTenantMissVerified',
  'idempotencyReplayVerified',
  'negativeAuthVerified',
  'originAuthVerified',
  'plannedWorkVerified',
  'privateExportVerified',
  'projectTemplatesVerified',
  'readOnlyScopeVerified',
  'signedWebhookDeliveryVerified',
  'webhookCaptureCleanupVerified',
  'wrongCellRoutingVerified',
]
const requiredCleanupResources = [
  'customFieldDefinition',
  'instantiatedProject',
  'projectTemplate',
  'sourceProject',
  'task',
  'timeEntry',
  'webhook',
  'webhookCaptureReceiver',
]

function trimmed(environment, name) {
  return String(environment[name] || '').trim()
}

function requireValue(environment, name) {
  const value = trimmed(environment, name)
  if (!value) throw new Error(`${name} is required in release-qualifying mode.`)
  return value
}

function requirePattern(environment, name, pattern) {
  const value = requireValue(environment, name)
  if (!pattern.test(value)) throw new Error(`${name} is malformed.`)
  return value
}

export function resolveQualificationConfig(environment = process.env) {
  const mode = trimmed(environment, 'TEAMGRID_E2E_QUALIFY_RELEASE')
  if (mode && !['false', 'true'].includes(mode)) {
    throw new Error('TEAMGRID_E2E_QUALIFY_RELEASE must be true or false.')
  }
  const qualifying = mode === 'true'
  const expectedRegion = trimmed(environment, 'TEAMGRID_E2E_EXPECTED_REGION')
  const expectedCellId = trimmed(environment, 'TEAMGRID_E2E_EXPECTED_CELL_ID')
  const evidencePath = trimmed(environment, 'TEAMGRID_E2E_EVIDENCE_PATH')

  if (expectedRegion && !['de', 'us'].includes(expectedRegion)) {
    throw new Error('TEAMGRID_E2E_EXPECTED_REGION must be de or us.')
  }
  if (expectedCellId && !cellIdPattern.test(expectedCellId)) {
    throw new Error('TEAMGRID_E2E_EXPECTED_CELL_ID is malformed.')
  }
  if (expectedRegion && expectedCellId && !expectedCellId.startsWith(`${expectedRegion}-`)) {
    throw new Error('TEAMGRID_E2E_EXPECTED_REGION and TEAMGRID_E2E_EXPECTED_CELL_ID disagree.')
  }

  if (!qualifying) {
    return {
      bindings: undefined,
      evidencePath: evidencePath || undefined,
      expectedCellId: expectedCellId || undefined,
      expectedRegion: expectedRegion || undefined,
      qualifying,
    }
  }

  for (const name of requiredNegativeInputs) requireValue(environment, name)
  requireValue(environment, 'TEAMGRID_API_ORIGIN_URL')
  if (trimmed(environment, 'TEAMGRID_E2E_WEBHOOK_DELIVERY') !== 'true') {
    throw new Error('TEAMGRID_E2E_WEBHOOK_DELIVERY must be true in release-qualifying mode.')
  }

  const releaseExpectedRegion = expectedRegion
    || requireValue(environment, 'TEAMGRID_E2E_EXPECTED_REGION')
  const releaseExpectedCellId = expectedCellId
    || requireValue(environment, 'TEAMGRID_E2E_EXPECTED_CELL_ID')
  const bindings = {
    apiGitSha: requirePattern(environment, 'TEAMGRID_E2E_API_GIT_SHA', sha40),
    appGitSha: requirePattern(environment, 'TEAMGRID_E2E_APP_GIT_SHA', sha40),
    contractManifestSha256: requirePattern(
      environment,
      'TEAMGRID_E2E_CONTRACT_MANIFEST_SHA256',
      sha64,
    ),
    developerPlatformGitSha: requirePattern(
      environment,
      'TEAMGRID_E2E_DEVELOPER_PLATFORM_GIT_SHA',
      sha40,
    ),
    producerGitSha: requirePattern(environment, 'TEAMGRID_E2E_PRODUCER_GIT_SHA', sha40),
    workflowRunUrl: requireValue(environment, 'TEAMGRID_E2E_WORKFLOW_RUN_URL'),
  }
  if (!/^https:\/\/github\.com\/TeamGrid\/teamgrid\/actions\/runs\/[0-9]+$/.test(
    bindings.workflowRunUrl,
  )) {
    throw new Error('TEAMGRID_E2E_WORKFLOW_RUN_URL is malformed.')
  }

  return {
    bindings,
    evidencePath: requireValue(environment, 'TEAMGRID_E2E_EVIDENCE_PATH'),
    expectedCellId: releaseExpectedCellId,
    expectedRegion: releaseExpectedRegion,
    qualifying,
  }
}

export function buildQualificationEvidence({
  bindings,
  claims,
  cleanup,
  generatedAt = new Date().toISOString(),
  qualifying,
  runId,
  target,
}) {
  if (!runId || typeof runId !== 'string') throw new Error('A smoke run id is required.')
  if (!target || !['de', 'us'].includes(target.region) || !cellIdPattern.test(target.cellId)) {
    throw new Error('The observed smoke target is malformed.')
  }
  if (!target.cellId.startsWith(`${target.region}-`)) {
    throw new Error('The observed smoke region and cell disagree.')
  }
  if (!cleanup?.complete || !cleanup?.reconciled) {
    throw new Error('Release evidence requires complete, reconciled cleanup.')
  }
  if (qualifying) {
    for (const claim of requiredQualifyingClaims) {
      if (claims?.[claim] !== true) {
        throw new Error(`Release evidence requires the ${claim} claim.`)
      }
    }
    if (!Number.isInteger(claims?.auditEventsVerified) || claims.auditEventsVerified < 5) {
      throw new Error('Release evidence requires at least five verified audit events.')
    }
    for (const resource of requiredCleanupResources) {
      const record = cleanup.resources?.[resource]
      if (!record?.created
        || !record.cleanupAttempted
        || !record.cleanupSucceeded
        || !record.reconciliationVerified) {
        throw new Error(`Release evidence requires reconciled cleanup for ${resource}.`)
      }
    }
    if (!bindings) throw new Error('Release evidence requires immutable bindings.')
  }

  return {
    bindings: bindings || null,
    claims,
    cleanup,
    evidenceContract: 'teamgrid-developer-platform-release-qualification-v2',
    generatedAt,
    qualifying,
    result: 'passed',
    runId,
    schemaVersion: 2,
    target,
  }
}

export function writeQualificationEvidence(path, evidence) {
  if (!path) return undefined
  const payload = `${JSON.stringify(evidence, null, 2)}\n`
  const temporaryPath = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
  return createHash('sha256').update(payload).digest('hex')
}
