import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertNoKnownSecrets(payload, secrets) {
  for (const secret of secrets) {
    if (secret && payload.includes(secret)) {
      throw new Error('Conformance evidence contains a runtime credential.')
    }
  }
}

function summarizeResults(results) {
  const byOutcome = {}
  const bySurface = {}
  for (const result of results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] || 0) + 1
    bySurface[result.surface] = (bySurface[result.surface] || 0) + 1
  }
  return { byOutcome, bySurface, total: results.length }
}

export function buildConformanceEvidence({
  completedAt,
  config,
  inventory,
  results = [],
  startedAt,
}) {
  if (!config?.runId || !config.mode) throw new Error('Conformance run metadata is required.')
  if (!inventory?.inventoryDigest || !inventory?.contracts) {
    throw new Error('Conformance inventory metadata is required.')
  }
  if (!startedAt || !completedAt) throw new Error('Conformance timestamps are required.')

  const summary = summarizeResults(results)
  const failed = (summary.byOutcome.failed || 0) > 0
  const incomplete = (summary.byOutcome.blocked || 0) > 0 || (summary.byOutcome.not_run || 0) > 0

  return {
    completedAt,
    contracts: inventory.contracts,
    evidenceContract: 'teamgrid-developer-platform-production-conformance-v1',
    inventoryDigest: inventory.inventoryDigest,
    mode: config.mode,
    result: failed ? 'failed' : incomplete ? 'incomplete' : 'passed',
    results,
    runId: config.runId,
    schemaVersion: 1,
    startedAt,
    summary,
    target: config.target,
  }
}

export function writeConformanceEvidence(path, evidence, { secrets = [] } = {}) {
  if (!path) throw new Error('A conformance evidence path is required.')
  const payload = `${JSON.stringify(evidence, null, 2)}\n`
  assertNoKnownSecrets(payload, secrets)

  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
  return sha256(payload)
}

export function evidenceResult({
  durationMs,
  expectedStatus,
  note,
  observedStatus,
  operationId,
  outcome,
  requestId,
  surface = 'api',
  version,
}) {
  if (!['blocked', 'failed', 'not_run', 'passed'].includes(outcome)) {
    throw new Error(`Unsupported conformance outcome: ${outcome}`)
  }
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(expectedStatus === undefined ? {} : { expectedStatus }),
    ...(note ? { note } : {}),
    ...(observedStatus === undefined ? {} : { observedStatus }),
    operationId,
    outcome,
    ...(requestId ? { requestId } : {}),
    surface,
    version,
  }
}
