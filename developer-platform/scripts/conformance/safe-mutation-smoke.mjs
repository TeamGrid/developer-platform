import { performance } from 'node:perf_hooks'
import {
  assertJournalPathReady,
  createCleanupJournal,
  finalizeCleanupJournal,
  writeCleanupJournal,
} from './cleanup-journal.mjs'
import { evidenceResult } from './evidence.mjs'

const maximumAttempts = 3
const safeMissingIdentifier = 'tgConformanceMissing20260730'
const safeNegativeStatuses = new Set([400, 403, 404, 405, 409, 412, 415, 422, 428, 451])

function tokenFor(config, operation) {
  if (!operation.authenticated) return undefined
  return operation.version === 'v0'
    ? config.secrets.TEAMGRID_CONFORMANCE_V0_TOKEN
    : config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN
}

function safeParameterValue(parameter) {
  const name = parameter.name.toLowerCase()
  if (name === 'timezone') return 'UTC'
  if (name === 'start' || name === 'end' || name.endsWith('at')) {
    return '2026-01-01T00:00:00.000Z'
  }
  if (name === 'targettype') return 'task'
  if (parameter.schema?.type === 'integer' || parameter.schema?.type === 'number') return '1'
  if (parameter.schema?.type === 'boolean') return 'false'
  return safeMissingIdentifier
}

function requestUrl(config, operation) {
  const baseUrl = operation.version === 'v0' ? config.target.v0BaseUrl : config.target.v1BaseUrl
  const url = new URL(`${baseUrl}${operation.path.replaceAll(/\{[^}]+\}/g, safeMissingIdentifier)}`)
  for (const parameter of operation.requiredParameters) {
    if (parameter.location === 'query') {
      url.searchParams.set(parameter.name, safeParameterValue(parameter))
    }
  }
  if (operation.testability.automaticReadProbe) {
    if (operation.parameters.some((parameter) => parameter.name === 'limit')) {
      url.searchParams.set('limit', String(config.pageLimit))
    }
    if (operation.operationId === 'listChanges') url.searchParams.set('startAtLatest', 'true')
  }
  return url
}

function documentedSuccessStatuses(operation) {
  if (operation.compatibility?.expectedUnavailable) return [501]
  return operation.responseStatuses
    .map(Number)
    .filter((status) => status >= 200 && status < 400)
    .sort((left, right) => left - right)
}

function expectedStatuses(operation) {
  if (operation.compatibility?.expectedUnavailable) return [501]
  if (operation.testability.automaticReadProbe) return documentedSuccessStatuses(operation)
  if (operation.risk === 'read') {
    return [...new Set([...documentedSuccessStatuses(operation), ...safeNegativeStatuses])].sort(
      (left, right) => left - right,
    )
  }
  return [...safeNegativeStatuses]
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

function classifyResponse(operation, status) {
  if (operation.compatibility?.expectedUnavailable) {
    return status === 501
      ? { note: 'documented_unavailable', outcome: 'passed' }
      : { note: 'unexpected_status', outcome: 'failed' }
  }
  if (operation.testability.automaticReadProbe) {
    return documentedSuccessStatuses(operation).includes(status)
      ? { note: 'live_read_succeeded', outcome: 'passed' }
      : { note: 'unexpected_status', outcome: 'failed' }
  }
  if (operation.risk === 'read') {
    return expectedStatuses(operation).includes(status)
      ? { note: 'safe_negative_fixture_probe', outcome: 'passed' }
      : { note: 'unexpected_status', outcome: 'failed' }
  }
  if (status >= 200 && status < 300) {
    return { note: 'unsafe_unexpected_success', outcome: 'failed' }
  }
  return safeNegativeStatuses.has(status)
    ? { note: 'safe_negative_mutation_probe', outcome: 'passed' }
    : { note: 'unexpected_status', outcome: 'failed' }
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
        redirect: 'manual',
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

export async function executeSafeMutationSmokeConformance({
  config,
  fetchImpl = fetch,
  inventory,
  now = () => new Date(),
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  if (config.mode !== 'safe-mutation-smoke') {
    throw new Error('The safe mutation smoke runner requires safe-mutation-smoke mode.')
  }
  if (!config.cleanupJournalPath || !config.fixtureNamespace || !config.secrets || !config.target) {
    throw new Error('The safe mutation smoke runner requires live isolated-fixture configuration.')
  }

  assertJournalPathReady(config.cleanupJournalPath)
  let journal = createCleanupJournal({
    createdAt: now().toISOString(),
    fixtureNamespace: config.fixtureNamespace,
    runId: config.runId,
  })
  writeCleanupJournal(config.cleanupJournalPath, journal, {
    secrets: Object.values(config.secrets),
  })

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
    if (probed > 0) await sleep(config.requestIntervalMs)
    const result = await probeOperation({ config, fetchImpl, operation, sleep })
    results.push(result)
    probed += 1
    if (result.note === 'unsafe_unexpected_success') {
      throw new Error(
        `Safe mutation smoke stopped after an unsafe unexpected success: ${operation.operationId}.`,
      )
    }
  }

  journal = finalizeCleanupJournal(journal, { completedAt: now().toISOString() })
  writeCleanupJournal(config.cleanupJournalPath, journal, {
    secrets: Object.values(config.secrets),
  })
  return results
}
