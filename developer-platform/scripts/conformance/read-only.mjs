import { performance } from 'node:perf_hooks'
import { evidenceResult } from './evidence.mjs'

const maximumAttempts = 3

function expectedStatuses(operation) {
  if (operation.compatibility?.expectedUnavailable) return [501]
  return operation.responseStatuses
    .map(Number)
    .filter((status) => status >= 200 && status < 300)
    .sort((left, right) => left - right)
}

function tokenFor(config, operation) {
  if (!operation.authenticated) return undefined
  return operation.version === 'v0'
    ? config.secrets.TEAMGRID_CONFORMANCE_V0_TOKEN
    : config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN
}

function requestUrl(config, operation) {
  const baseUrl = operation.version === 'v0' ? config.target.v0BaseUrl : config.target.v1BaseUrl
  const url = new URL(`${baseUrl}${operation.path}`)

  if (operation.parameters.some((parameter) => parameter.name === 'limit')) {
    url.searchParams.set('limit', '1')
  }
  if (operation.operationId === 'listChanges') {
    url.searchParams.set('startAtLatest', 'true')
  }
  return url
}

function retryDelay(response) {
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) return 1_000
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 250), 30_000)
  const dateDelay = new Date(retryAfter).getTime() - Date.now()
  return Math.min(Math.max(dateDelay, 250), 30_000)
}

function failureNote(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'request_timeout'
  return 'transport_error'
}

async function probeOperation({ config, fetchImpl, operation, sleep }) {
  const url = requestUrl(config, operation)
  const token = tokenFor(config, operation)
  const expected = expectedStatuses(operation)
  const started = performance.now()
  let response
  let attempts = 0

  try {
    do {
      attempts += 1
      response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'user-agent': 'teamgrid-production-conformance/1.0',
          'x-request-id': `${config.runId}-${operation.operationId}-${attempts}`,
        },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      })
      if (response.status === 429 && attempts < maximumAttempts) {
        await sleep(retryDelay(response))
      } else {
        break
      }
    } while (attempts < maximumAttempts)
  } catch (error) {
    return {
      attempts,
      ...evidenceResult({
        durationMs: Math.round(performance.now() - started),
        expectedStatus: expected,
        note: failureNote(error),
        operationId: operation.operationId,
        outcome: 'failed',
        version: operation.version,
      }),
    }
  }

  const requestId = response.headers.get('x-request-id') || undefined
  const passed = expected.includes(response.status)
  return {
    attempts,
    ...evidenceResult({
      durationMs: Math.round(performance.now() - started),
      expectedStatus: expected,
      note: passed ? undefined : response.status === 429 ? 'rate_limited' : 'unexpected_status',
      observedStatus: response.status,
      operationId: operation.operationId,
      outcome: passed ? 'passed' : 'failed',
      requestId,
      version: operation.version,
    }),
  }
}

function blockedResult(operation) {
  return evidenceResult({
    expectedStatus: expectedStatuses(operation),
    note: operation.risk === 'read' ? 'fixture_required' : 'mutation_requires_certification_mode',
    operationId: operation.operationId,
    outcome: 'blocked',
    version: operation.version,
  })
}

function versionNotSelected(operation) {
  return evidenceResult({
    expectedStatus: expectedStatuses(operation),
    note: 'version_not_selected',
    operationId: operation.operationId,
    outcome: 'not_run',
    version: operation.version,
  })
}

export async function executeReadOnlyConformance({
  config,
  fetchImpl = fetch,
  inventory,
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  if (config.mode !== 'read-only') {
    throw new Error('The read-only runner requires read-only mode.')
  }
  if (!config.secrets || !config.target) {
    throw new Error('The read-only runner requires live target configuration.')
  }

  const results = []
  let probed = 0
  for (const operation of inventory.operations) {
    if (!config.versions.includes(operation.version)) {
      results.push(versionNotSelected(operation))
      continue
    }
    if (!operation.testability.automaticReadProbe) {
      results.push(blockedResult(operation))
      continue
    }
    if (probed > 0) await sleep(config.requestIntervalMs)
    results.push(await probeOperation({ config, fetchImpl, operation, sleep }))
    probed += 1
  }
  return results
}
