import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const cellIdPattern = /^(?:de|us)-[a-z0-9]+-[0-9]{3}$/
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

export const loadScenarios = Object.freeze([
  Object.freeze({ id: 'workspace', path: '/workspace' }),
  Object.freeze({ id: 'capabilities', path: '/system/capabilities' }),
  Object.freeze({ id: 'entitlements', path: '/workspace/entitlements' }),
  Object.freeze({ id: 'projects', path: '/projects?limit=100' }),
  Object.freeze({ id: 'tasks', path: '/tasks?limit=100' }),
  Object.freeze({ id: 'contacts', path: '/contacts?limit=100' }),
  Object.freeze({ id: 'users', path: '/users?limit=100' }),
  Object.freeze({ id: 'changes', path: '/changes?limit=100&startAtLatest=true' }),
])

export const releaseLoadThresholds = Object.freeze({
  maximumLatencyMs: 10_000,
  maximumP95LatencyMs: 2_000,
  maximumP99LatencyMs: 5_000,
  maximumResponseBytes: 8 * 1024 * 1024,
  minimumAchievedRequestsPerSecond: 2.5,
  minimumRequests: 720,
})

function value(environment, name) {
  return String(environment[name] || '').trim()
}

function required(environment, name) {
  const result = value(environment, name)
  if (!result) throw new Error(`${name} is required for load qualification.`)
  return result
}

function integer(environment, name, defaultValue, { maximum, minimum }) {
  const configured = value(environment, name)
  const result = configured ? Number(configured) : defaultValue
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return result
}

function safeTarget(baseUrl, allowNonStaging) {
  const parsed = new URL(baseUrl)
  const loopback = ['localhost', '127.0.0.1'].includes(parsed.hostname)
  if (!loopback && parsed.protocol !== 'https:') {
    throw new Error('The load target must use HTTPS outside loopback.')
  }
  if (!allowNonStaging && !loopback && !parsed.hostname.includes('staging')) {
    throw new Error('Refusing to run the bounded load qualification outside staging or loopback.')
  }
  return parsed.toString().replace(/\/$/, '')
}

export function resolveLoadQualificationConfig(environment = process.env) {
  const qualifyingValue = value(environment, 'TEAMGRID_LOAD_QUALIFY_RELEASE')
  if (qualifyingValue && !['false', 'true'].includes(qualifyingValue)) {
    throw new Error('TEAMGRID_LOAD_QUALIFY_RELEASE must be true or false.')
  }
  const qualifying = qualifyingValue === 'true'
  const baseUrl = safeTarget(
    required(environment, 'TEAMGRID_API_BASE_URL'),
    value(environment, 'TEAMGRID_LOAD_ALLOW_NON_STAGING') === 'true',
  )
  const expectedCellId = required(environment, 'TEAMGRID_LOAD_EXPECTED_CELL_ID')
  const expectedRegion = required(environment, 'TEAMGRID_LOAD_EXPECTED_REGION')
  if (!cellIdPattern.test(expectedCellId)) {
    throw new Error('TEAMGRID_LOAD_EXPECTED_CELL_ID is malformed.')
  }
  if (!['de', 'us'].includes(expectedRegion) || !expectedCellId.startsWith(`${expectedRegion}-`)) {
    throw new Error('TEAMGRID_LOAD_EXPECTED_REGION and TEAMGRID_LOAD_EXPECTED_CELL_ID disagree.')
  }

  const durationSeconds = integer(
    environment,
    'TEAMGRID_LOAD_DURATION_SECONDS',
    qualifying ? 240 : 10,
    { maximum: qualifying ? 360 : 60, minimum: qualifying ? 240 : 1 },
  )
  const requestsPerSecond = integer(
    environment,
    'TEAMGRID_LOAD_REQUESTS_PER_SECOND',
    qualifying ? 3 : 2,
    { maximum: 3, minimum: qualifying ? 3 : 1 },
  )
  const concurrency = integer(environment, 'TEAMGRID_LOAD_CONCURRENCY', qualifying ? 8 : 4, {
    maximum: 16,
    minimum: qualifying ? 8 : 1,
  })
  const timeoutMs = integer(environment, 'TEAMGRID_LOAD_TIMEOUT_MS', 10_000, {
    maximum: 10_000,
    minimum: 1_000,
  })
  const requestCount = durationSeconds * requestsPerSecond
  if (qualifying && requestCount < releaseLoadThresholds.minimumRequests) {
    throw new Error('The release load profile schedules too few requests.')
  }

  return Object.freeze({
    baseUrl,
    concurrency,
    durationSeconds,
    evidencePath: required(environment, 'TEAMGRID_LOAD_EVIDENCE_PATH'),
    expectedCellId,
    expectedRegion,
    qualifying,
    requestCount,
    requestsPerSecond,
    timeoutMs,
    token: required(environment, 'TEAMGRID_API_TOKEN'),
  })
}

function rounded(value) {
  return Math.round(value * 1000) / 1000
}

export function latencySummary(values) {
  if (!values.length) {
    return { maximum: null, mean: null, minimum: null, p50: null, p95: null, p99: null }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (percent) => sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)]
  return {
    maximum: rounded(sorted[sorted.length - 1]),
    mean: rounded(sorted.reduce((total, item) => total + item, 0) / sorted.length),
    minimum: rounded(sorted[0]),
    p50: rounded(percentile(0.5)),
    p95: rounded(percentile(0.95)),
    p99: rounded(percentile(0.99)),
  }
}

function scenarioMetrics(results, scenarioId) {
  const selected = results.filter((result) => result.scenarioId === scenarioId)
  const successful = selected.filter((result) => result.valid)
  return {
    attemptedRequests: selected.length,
    failedRequests: selected.length - successful.length,
    latencyMs: latencySummary(successful.map((result) => result.latencyMs)),
    successfulRequests: successful.length,
  }
}

function statusCounts(results) {
  return results.reduce((counts, result) => {
    const key = result.statusCode === null ? 'network-error' : String(result.statusCode)
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
}

function qualificationViolations(profile, metrics) {
  const violations = []
  if (metrics.attemptedRequests !== profile.requestCount) {
    violations.push('scheduled_requests_incomplete')
  }
  if (profile.qualifying && profile.requestCount < releaseLoadThresholds.minimumRequests) {
    violations.push('minimum_requests_not_met')
  }
  if (metrics.failedRequests !== 0) violations.push('request_failures_observed')
  if (metrics.invalidResponses !== 0) violations.push('invalid_responses_observed')
  if (metrics.rateLimitedRequests !== 0) violations.push('rate_limit_responses_observed')
  if (profile.qualifying) {
    if (
      metrics.achievedRequestsPerSecond < releaseLoadThresholds.minimumAchievedRequestsPerSecond
    ) {
      violations.push('minimum_throughput_not_met')
    }
    if (metrics.latencyMs.p95 > releaseLoadThresholds.maximumP95LatencyMs) {
      violations.push('p95_latency_exceeded')
    }
    if (metrics.latencyMs.p99 > releaseLoadThresholds.maximumP99LatencyMs) {
      violations.push('p99_latency_exceeded')
    }
    if (metrics.latencyMs.maximum > releaseLoadThresholds.maximumLatencyMs) {
      violations.push('maximum_latency_exceeded')
    }
  }
  if (Object.values(metrics.scenarios).some((item) => item.attemptedRequests === 0)) {
    violations.push('scenario_coverage_incomplete')
  }
  const minimumScenarioRequests = Math.floor(profile.requestCount / loadScenarios.length)
  for (const [scenarioId, scenario] of Object.entries(metrics.scenarios)) {
    if (scenario.attemptedRequests < minimumScenarioRequests) {
      violations.push(`scenario_${scenarioId}_under_sampled`)
    }
    if (profile.qualifying && scenario.latencyMs.p95 > releaseLoadThresholds.maximumP95LatencyMs) {
      violations.push(`scenario_${scenarioId}_p95_latency_exceeded`)
    }
    if (profile.qualifying && scenario.latencyMs.p99 > releaseLoadThresholds.maximumP99LatencyMs) {
      violations.push(`scenario_${scenarioId}_p99_latency_exceeded`)
    }
    if (profile.qualifying && scenario.latencyMs.maximum > releaseLoadThresholds.maximumLatencyMs) {
      violations.push(`scenario_${scenarioId}_maximum_latency_exceeded`)
    }
  }
  if (metrics.maximumInFlight > profile.concurrency) {
    violations.push('concurrency_limit_exceeded')
  }
  return violations
}

export function buildLoadQualificationEvidence({
  actualDurationMs,
  config,
  generatedAt = new Date().toISOString(),
  maximumInFlight,
  results,
  runId,
}) {
  const successful = results.filter((result) => result.valid)
  const failed = results.filter((result) => !result.valid)
  const scenarioReport = Object.fromEntries(
    loadScenarios.map((scenario) => [scenario.id, scenarioMetrics(results, scenario.id)]),
  )
  const metrics = {
    achievedRequestsPerSecond: rounded(results.length / Math.max(actualDurationMs / 1000, 0.001)),
    actualDurationMs: rounded(actualDurationMs),
    attemptedRequests: results.length,
    failedRequests: failed.length,
    invalidResponses: failed.filter((result) => result.failureKind === 'invalid-response').length,
    latencyMs: latencySummary(successful.map((result) => result.latencyMs)),
    maximumInFlight,
    rateLimitedRequests: results.filter((result) => result.statusCode === 429).length,
    scenarios: scenarioReport,
    statusCounts: statusCounts(results),
    successfulRequests: successful.length,
    totalResponseBytes: results.reduce((total, result) => total + result.responseBytes, 0),
  }
  const profile = {
    concurrency: config.concurrency,
    durationSeconds: config.durationSeconds,
    profileId: 'staging-read-baseline-v1',
    qualifying: config.qualifying,
    requestCount: config.requestCount,
    requestsPerSecond: config.requestsPerSecond,
    scenarios: loadScenarios.map((scenario) => ({ ...scenario })),
    timeoutMs: config.timeoutMs,
  }
  const violations = qualificationViolations(profile, metrics)
  return {
    evidenceContract: 'teamgrid-developer-platform-load-qualification-v1',
    generatedAt,
    metrics,
    profile,
    result: violations.length === 0 ? 'passed' : 'failed',
    runId,
    schemaVersion: 1,
    target: { cellId: config.expectedCellId, region: config.expectedRegion },
    thresholds: { ...releaseLoadThresholds },
    violations,
  }
}

function responseFailure({ failureKind, latencyMs, responseBytes = 0, scenarioId, statusCode }) {
  return { failureKind, latencyMs, responseBytes, scenarioId, statusCode, valid: false }
}

async function executeScenario({ config, fetchImpl, index, runId, scenario }) {
  const startedAt = performance.now()
  const expectedRequestId = `load-${runId}-${index}`
  let response
  try {
    response = await fetchImpl(new URL(`${config.baseUrl}${scenario.path}`), {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
        'x-request-id': expectedRequestId,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch {
    return responseFailure({
      failureKind: 'network-error',
      latencyMs: performance.now() - startedAt,
      scenarioId: scenario.id,
      statusCode: null,
    })
  }
  const body = await response.text()
  const latencyMs = performance.now() - startedAt
  const responseBytes = Buffer.byteLength(body)
  if (response.status !== 200) {
    return responseFailure({
      failureKind: 'http-error',
      latencyMs,
      responseBytes,
      scenarioId: scenario.id,
      statusCode: response.status,
    })
  }
  if (
    !String(response.headers.get('content-type') || '')
      .toLowerCase()
      .includes('application/json') ||
    responseBytes > releaseLoadThresholds.maximumResponseBytes
  ) {
    return responseFailure({
      failureKind: 'invalid-response',
      latencyMs,
      responseBytes,
      scenarioId: scenario.id,
      statusCode: response.status,
    })
  }
  let document
  try {
    document = JSON.parse(body)
  } catch {
    return responseFailure({
      failureKind: 'invalid-response',
      latencyMs,
      responseBytes,
      scenarioId: scenario.id,
      statusCode: response.status,
    })
  }
  const headerRequestId = response.headers.get('x-request-id') || ''
  const bodyRequestId = document?.meta?.requestId || ''
  const workspace = scenario.id === 'workspace' ? document?.data?.attributes : null
  const targetValid =
    !workspace ||
    (workspace.cellId === config.expectedCellId && workspace.region === config.expectedRegion)
  if (
    !requestIdPattern.test(headerRequestId) ||
    headerRequestId !== expectedRequestId ||
    bodyRequestId !== expectedRequestId ||
    !targetValid
  ) {
    return responseFailure({
      failureKind: 'invalid-response',
      latencyMs,
      responseBytes,
      scenarioId: scenario.id,
      statusCode: response.status,
    })
  }
  return {
    failureKind: null,
    latencyMs,
    responseBytes,
    scenarioId: scenario.id,
    statusCode: response.status,
    valid: true,
  }
}

export async function runLoadQualification({
  config,
  fetchImpl = globalThis.fetch,
  generatedAt = new Date().toISOString(),
  runId = String(randomUUID()),
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  const startedAt = performance.now()
  const intervalMs = 1000 / config.requestsPerSecond
  const results = new Array(config.requestCount)
  let nextIndex = 0
  let inFlight = 0
  let maximumInFlight = 0

  async function worker() {
    while (nextIndex < config.requestCount) {
      const index = nextIndex
      nextIndex += 1
      const plannedAt = startedAt + index * intervalMs
      const delay = plannedAt - performance.now()
      if (delay > 0) await sleep(delay)
      inFlight += 1
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      try {
        results[index] = await executeScenario({
          config,
          fetchImpl,
          index,
          runId,
          scenario: loadScenarios[index % loadScenarios.length],
        })
      } finally {
        inFlight -= 1
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()))
  return buildLoadQualificationEvidence({
    actualDurationMs: performance.now() - startedAt,
    config,
    generatedAt,
    maximumInFlight,
    results,
    runId,
  })
}

export function writeLoadQualificationEvidence(path, evidence) {
  const payload = `${JSON.stringify(evidence, null, 2)}\n`
  const temporaryPath = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, path)
  return createHash('sha256').update(payload).digest('hex')
}

async function main() {
  const config = resolveLoadQualificationConfig(process.env)
  const evidence = await runLoadQualification({ config })
  const evidenceSha256 = writeLoadQualificationEvidence(config.evidencePath, evidence)
  console.log(
    JSON.stringify({
      evidenceContract: evidence.evidenceContract,
      evidenceSha256,
      metrics: evidence.metrics,
      result: evidence.result,
      target: evidence.target,
      violations: evidence.violations,
    }),
  )
  if (evidence.result !== 'passed') {
    throw new Error(`Load qualification failed: ${evidence.violations.join(', ')}`)
  }
}

const invokedPath = process.argv[1] && pathToFileURL(process.argv[1]).href
if (invokedPath === import.meta.url) await main()
