import { performance } from 'node:perf_hooks'
import { evidenceResult } from './evidence.mjs'

const maximumAttempts = 3
const safeMissingIdentifier = 'tgConformanceMissing20260730'
const acceptedNegativeStatuses = new Set([400, 403, 404, 405, 409, 412, 415, 422, 428])

function tokenFor(config, operation) {
  if (!operation.authenticated) return undefined
  return operation.version === 'v0'
    ? config.secrets.TEAMGRID_CONFORMANCE_V0_TOKEN
    : config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN
}

function pathFor(operation) {
  return operation.path.replaceAll(/\{[^}]+\}/g, safeMissingIdentifier)
}

function requestUrl(config, operation) {
  const baseUrl = operation.version === 'v0' ? config.target.v0BaseUrl : config.target.v1BaseUrl
  const url = new URL(`${baseUrl}${pathFor(operation)}`)
  if (operation.testability.automaticReadProbe) {
    if (operation.parameters.some((parameter) => parameter.name === 'limit')) {
      url.searchParams.set('limit', String(config.pageLimit))
    }
    if (operation.operationId === 'listChanges') url.searchParams.set('startAtLatest', 'true')
  }
  return url
}

function expectedStatuses(operation) {
  if (operation.compatibility?.expectedUnavailable) return [501]
  if (!operation.testability.automaticReadProbe) return [...acceptedNegativeStatuses]
  return operation.responseStatuses
    .map(Number)
    .filter((status) => status >= 200 && status < 300)
    .sort((left, right) => left - right)
}

function retryDelay(response) {
  const retryAfter = response.headers.get('retry-after')
  const seconds = Number(retryAfter)
  return retryAfter && Number.isFinite(seconds)
    ? Math.min(Math.max(seconds * 1_000, 250), 30_000)
    : 1_000
}

function failureNote(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'request_timeout'
  return 'transport_error'
}

function classifyResponse(operation, status) {
  if (operation.compatibility?.expectedUnavailable && status === 501) {
    return { note: 'documented_unavailable', outcome: 'passed' }
  }
  if (operation.testability.automaticReadProbe) {
    return expectedStatuses(operation).includes(status)
      ? { outcome: 'passed' }
      : { note: 'unexpected_status', outcome: 'failed' }
  }
  if (operation.risk === 'read' && operation.responseStatuses.map(Number).includes(status)) {
    return { note: 'safe_negative_route_probe', outcome: 'passed' }
  }
  if (acceptedNegativeStatuses.has(status)) {
    return { note: 'safe_negative_route_probe', outcome: 'passed' }
  }
  if (status >= 200 && status < 300) {
    return { note: 'unsafe_unexpected_success', outcome: 'failed' }
  }
  return { note: 'unexpected_status', outcome: 'failed' }
}

async function probeOperation({ config, fetchImpl, operation, sleep }) {
  const url = requestUrl(config, operation)
  const token = tokenFor(config, operation)
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
        method: operation.method,
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
        expectedStatus: expectedStatuses(operation),
        note: failureNote(error),
        operationId: operation.operationId,
        outcome: 'failed',
        version: operation.version,
      }),
    }
  }

  const classification = classifyResponse(operation, response.status)
  return {
    attempts,
    ...evidenceResult({
      durationMs: Math.round(performance.now() - started),
      expectedStatus: expectedStatuses(operation),
      note: classification.note,
      observedStatus: response.status,
      operationId: operation.operationId,
      outcome: classification.outcome,
      requestId: response.headers.get('x-request-id') || undefined,
      version: operation.version,
    }),
  }
}

export async function executeRouteSmokeConformance({
  config,
  fetchImpl = fetch,
  inventory,
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  if (config.mode !== 'route-smoke') {
    throw new Error('The route-smoke runner requires route-smoke mode.')
  }
  if (!config.secrets || !config.target) {
    throw new Error('The route-smoke runner requires live target configuration.')
  }

  const results = []
  let probed = 0
  for (const operation of inventory.operations) {
    if (!config.versions.includes(operation.version)) {
      results.push(
        evidenceResult({
          expectedStatus: expectedStatuses(operation),
          note: 'version_not_selected',
          operationId: operation.operationId,
          outcome: 'not_run',
          version: operation.version,
        }),
      )
      continue
    }
    if (operation.risk !== 'read') {
      results.push(
        evidenceResult({
          expectedStatus: expectedStatuses(operation),
          note: 'mutation_requires_certification_mode',
          operationId: operation.operationId,
          outcome: 'blocked',
          version: operation.version,
        }),
      )
      continue
    }
    if (probed > 0) await sleep(config.requestIntervalMs)
    results.push(await probeOperation({ config, fetchImpl, operation, sleep }))
    probed += 1
  }
  return results
}
