import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import {
  assertJournalPathReady,
  cleanupResourcesInReverseOrder,
  createCleanupJournal,
  finalizeCleanupJournal,
  pendingMutationIntents,
  readCleanupJournal,
  recordCleanupResult,
  registerCleanupResource,
  registerMutationIntent,
  resolveMutationIntent,
  writeCleanupJournal,
} from './cleanup-journal.mjs'
import { evidenceResult } from './evidence.mjs'

const recipeContract = 'teamgrid-positive-fixture-recipes-v1'
const maximumResponseBytes = 2 * 1024 * 1024
const allowedRequestHeaders = new Set([
  'idempotency-key',
  'if-match',
  'x-teamgrid-export-download-intent',
])
const cleanupSuccessStatuses = new Set([200, 202, 204, 404, 410])
const documentedRejectionOperations = new Set(['exchangeCliAuthorizationCode'])
const templatePattern = /\$\{([A-Za-z][A-Za-z0-9_.-]{0,127})\}/g

function fail(message) {
  throw new Error(`Positive certification recipe failed: ${message}`)
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertBoundedString(value, label, maximum = 10_000) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    fail(`${label} must be bounded non-empty text`)
  }
}

function assertRequest(request, operation, label) {
  if (!isObject(request)) fail(`${label}.request must be an object`)
  const allowedKeys = new Set(['body', 'headers', 'pathParameters', 'query'])
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
    fail(`${label}.request contains an unsupported field`)
  }
  for (const [group, values] of [
    ['pathParameters', request.pathParameters || {}],
    ['query', request.query || {}],
    ['headers', request.headers || {}],
  ]) {
    if (!isObject(values)) fail(`${label}.request.${group} must be an object`)
  }
  for (const header of Object.keys(request.headers || {})) {
    if (!allowedRequestHeaders.has(header.toLowerCase())) {
      fail(`${label} uses forbidden request header ${header}`)
    }
  }
  const requiredPath = operation.requiredParameters
    .filter((parameter) => parameter.location === 'path')
    .map((parameter) => parameter.name)
  const suppliedPath = Object.keys(request.pathParameters || {})
  if (
    requiredPath.length !== suppliedPath.length ||
    requiredPath.some((parameter) => !Object.hasOwn(request.pathParameters || {}, parameter))
  ) {
    fail(`${label} must supply exactly the required path parameters`)
  }
  for (const parameter of operation.requiredParameters.filter(
    (item) => item.location === 'query',
  )) {
    if (!Object.hasOwn(request.query || {}, parameter.name)) {
      fail(`${label} is missing required query parameter ${parameter.name}`)
    }
  }
  if (operation.requestBodyRequired && request.body === undefined) {
    fail(`${label} is missing its required request body`)
  }
  if (
    operation.ifMatchRequired &&
    !Object.keys(request.headers || {}).some((header) => header.toLowerCase() === 'if-match')
  ) {
    fail(`${label} is missing If-Match`)
  }
}

function validateRecipe(recipe, operation, operationMap) {
  const label = recipe?.operationId || 'unknown operation'
  if (!isObject(recipe) || recipe.operationId !== operation.operationId) {
    fail(`${label} has an invalid operation identity`)
  }
  assertRequest(recipe.request || {}, operation, label)
  if (
    !Array.isArray(recipe.expectedStatuses) ||
    recipe.expectedStatuses.length === 0 ||
    recipe.expectedStatuses.some(
      (status) => !Number.isInteger(status) || !operation.responseStatuses.includes(String(status)),
    )
  ) {
    fail(`${label} expectedStatuses must be documented by OpenAPI`)
  }
  const hasSuccess = recipe.expectedStatuses.some((status) => status >= 200 && status < 300)
  const unavailable =
    operation.compatibility?.expectedUnavailable && recipe.expectedStatuses.includes(501)
  if (!hasSuccess && !unavailable && !documentedRejectionOperations.has(operation.operationId)) {
    fail(`${label} must exercise a documented successful response`)
  }
  if (recipe.captures !== undefined) {
    if (!isObject(recipe.captures)) fail(`${label}.captures must be an object`)
    for (const [name, capture] of Object.entries(recipe.captures)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) || !isObject(capture)) {
        fail(`${label} contains an invalid capture`)
      }
      const captureKeys = Object.keys(capture)
      if (
        captureKeys.length !== 1 ||
        !(typeof capture.jsonPointer === 'string' || typeof capture.header === 'string')
      ) {
        fail(`${label}.${name} must capture one JSON pointer or response header`)
      }
    }
  }
  if (operation.risk !== 'read') {
    if (!recipe.fixtureBound) fail(`${label} must explicitly assert fixture ownership`)
    const hasCleanup = isObject(recipe.cleanup)
    const hasReason =
      typeof recipe.cleanupNotRequiredReason === 'string' &&
      recipe.cleanupNotRequiredReason.length >= 10 &&
      recipe.cleanupNotRequiredReason.length <= 500
    if (hasCleanup === hasReason) {
      fail(`${label} must define cleanup or one explicit cleanup-not-required reason`)
    }
    if (hasCleanup) {
      const cleanupOperation = operationMap.get(recipe.cleanup.operationId)
      if (cleanupOperation?.version !== 'v1') {
        fail(`${label} references an unknown v1 cleanup operation`)
      }
      if (!isObject(recipe.cleanup.pathParameters)) {
        fail(`${label}.cleanup.pathParameters must be an object`)
      }
      assertBoundedString(recipe.cleanup.resourceId, `${label}.cleanup.resourceId`, 1024)
      assertBoundedString(recipe.cleanup.resourceType, `${label}.cleanup.resourceType`, 128)
      assertRequest(
        {
          headers: {
            ...(recipe.cleanup.idempotencyKey
              ? { 'idempotency-key': recipe.cleanup.idempotencyKey }
              : {}),
            ...(recipe.cleanup.ifMatch ? { 'if-match': recipe.cleanup.ifMatch } : {}),
          },
          pathParameters: recipe.cleanup.pathParameters,
        },
        cleanupOperation,
        `${label}.cleanup`,
      )
      if (cleanupOperation.requestBodyRequired) {
        fail(`${label} cleanup may not require a request body`)
      }
    }
  }
}

export async function loadCertificationRecipes(path, { fixtureNamespace, inventory }) {
  const payload = JSON.parse(await readFile(path, 'utf8'))
  if (
    payload?.recipeContract !== recipeContract ||
    payload?.schemaVersion !== 1 ||
    payload?.inventoryDigest !== inventory.inventoryDigest ||
    payload?.fixtureNamespace !== fixtureNamespace ||
    !Array.isArray(payload.recipes)
  ) {
    fail('the manifest identity does not match this fixture and contract inventory')
  }
  const selectedOperations = inventory.operations.filter((operation) => operation.version === 'v1')
  const operationMap = new Map(
    selectedOperations.map((operation) => [operation.operationId, operation]),
  )
  if (
    payload.recipes.length !== selectedOperations.length ||
    new Set(payload.recipes.map((recipe) => recipe?.operationId)).size !==
      selectedOperations.length ||
    payload.recipes.some((recipe) => !operationMap.has(recipe?.operationId))
  ) {
    fail('the manifest must cover every v1 operation exactly once')
  }
  for (const recipe of payload.recipes) {
    validateRecipe(recipe, operationMap.get(recipe.operationId), operationMap)
  }
  return payload.recipes
}

function resolveTemplate(value, variables, label) {
  if (typeof value === 'string') {
    const resolved = value.replaceAll(templatePattern, (_match, name) => {
      if (!Object.hasOwn(variables, name)) fail(`${label} references unavailable variable ${name}`)
      return String(variables[name])
    })
    if (resolved.includes('${')) fail(`${label} contains an invalid template`)
    return resolved
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveTemplate(item, variables, `${label}[${index}]`))
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveTemplate(item, variables, `${label}.${key}`),
      ]),
    )
  }
  return value
}

function templateVariables(value) {
  const names = new Set()
  JSON.stringify(value).replaceAll(templatePattern, (_match, name) => {
    names.add(name)
    return ''
  })
  return names
}

function ensureIdempotencyKey(request, operation, config) {
  if (!operation.idempotencyRequired) return request
  const headers = { ...(request.headers || {}) }
  const existingHeader = Object.keys(headers).find(
    (name) => name.toLowerCase() === 'idempotency-key',
  )
  if (!existingHeader) {
    headers['idempotency-key'] = `${config.fixtureNamespace}-${operation.operationId}`.slice(0, 128)
  }
  return { ...request, headers }
}

function requestUrl(baseUrl, operation, request) {
  let path = operation.path
  for (const [name, value] of Object.entries(request.pathParameters || {})) {
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)))
  }
  if (/\{[^}]+\}/.test(path)) fail(`${operation.operationId} has unresolved path parameters`)
  const url = new URL(`${baseUrl}${path}`)
  for (const [name, rawValue] of Object.entries(request.query || {})) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue]
    for (const value of values) url.searchParams.append(name, String(value))
  }
  return url
}

async function boundedResponse(response) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
    await response.body?.cancel()
    fail('a response exceeded the certification read ceiling')
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('json')) {
    await response.body?.cancel()
    return undefined
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
    fail('a response exceeded the certification read ceiling')
  }
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    fail('a JSON response was malformed')
  }
}

function jsonPointer(value, pointer) {
  if (pointer === '') return value
  if (!pointer.startsWith('/')) fail(`invalid JSON pointer ${pointer}`)
  return pointer
    .slice(1)
    .split('/')
    .reduce((current, part) => {
      if (current === undefined || current === null) return undefined
      return current[part.replaceAll('~1', '/').replaceAll('~0', '~')]
    }, value)
}

function applyCaptures(recipe, response, payload, variables) {
  for (const [name, capture] of Object.entries(recipe.captures || {})) {
    const value = capture.header
      ? response.headers.get(capture.header)
      : jsonPointer(payload, capture.jsonPointer)
    if (!['number', 'string'].includes(typeof value) || String(value).length > 1024) {
      fail(`${recipe.operationId} did not return bounded capture ${name}`)
    }
    variables[name] = String(value)
  }
}

function requestHeaders({ config, operation, request }) {
  const headers = new Headers({
    accept: 'application/json',
    'user-agent': 'teamgrid-positive-conformance/1.0',
    'x-request-id': `${config.runId}-${operation.operationId}`,
  })
  if (operation.authenticated) {
    headers.set('authorization', `Bearer ${config.secrets.TEAMGRID_CONFORMANCE_V1_TOKEN}`)
  }
  if (request.body !== undefined) headers.set('content-type', 'application/json')
  for (const [name, value] of Object.entries(request.headers || {})) {
    headers.set(name, String(value))
  }
  if (operation.idempotencyRequired && !headers.has('idempotency-key')) {
    headers.set('idempotency-key', `${config.runId}-${operation.operationId}`.slice(0, 128))
  }
  return headers
}

async function performRequest({ config, fetchImpl, operation, request }) {
  const response = await fetchImpl(requestUrl(config.target.v1BaseUrl, operation, request), {
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    headers: requestHeaders({ config, operation, request }),
    method: operation.method,
    redirect: 'manual',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  })
  const payload = await boundedResponse(response)
  return { payload, response }
}

function resultFor(operation, expectedStatuses, started, response, outcome, note) {
  return evidenceResult({
    durationMs: Math.round(performance.now() - started),
    expectedStatus: expectedStatuses,
    note,
    observedStatus: response?.status,
    operationId: operation.operationId,
    outcome,
    requestId: response?.headers.get('x-request-id') || undefined,
    version: operation.version,
  })
}

async function cleanJournal({ config, fetchImpl, inventory, journal, secrets }) {
  const operations = new Map(
    inventory.operations.map((operation) => [operation.operationId, operation]),
  )
  let current = journal
  for (const resource of cleanupResourcesInReverseOrder(current)) {
    const operation = operations.get(resource.cleanupOperationId)
    let response
    let errorCode
    try {
      const result = await performRequest({
        config,
        fetchImpl,
        operation,
        request: {
          headers: {
            ...(resource.cleanupRequest.idempotencyKey
              ? { 'idempotency-key': resource.cleanupRequest.idempotencyKey }
              : {}),
            ...(resource.cleanupRequest.ifMatch
              ? { 'if-match': resource.cleanupRequest.ifMatch }
              : {}),
          },
          pathParameters: resource.cleanupRequest.pathParameters,
        },
      })
      response = result.response
      if (!cleanupSuccessStatuses.has(response.status)) errorCode = `http_${response.status}`
    } catch {
      errorCode = 'cleanup_transport_error'
    }
    current = recordCleanupResult(current, {
      ...(errorCode ? { errorCode } : {}),
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      succeeded: !errorCode,
    })
    writeCleanupJournal(config.cleanupJournalPath, current, { secrets })
  }
  if (current.resources.some((resource) => resource.state !== 'cleaned')) {
    throw new Error('Positive certification cleanup is incomplete; recover from the journal.')
  }
  current = finalizeCleanupJournal(current)
  writeCleanupJournal(config.cleanupJournalPath, current, { secrets })
  return current
}

function registerResolvedCleanup(journal, { cleanup, operationId, registeredAt }) {
  return registerCleanupResource(journal, {
    cleanupOperationId: cleanup.operationId,
    cleanupRequest: {
      ...(cleanup.idempotencyKey ? { idempotencyKey: cleanup.idempotencyKey } : {}),
      ...(cleanup.ifMatch ? { ifMatch: cleanup.ifMatch } : {}),
      pathParameters: cleanup.pathParameters,
    },
    createdByOperationId: operationId,
    registeredAt,
    resourceId: cleanup.resourceId,
    resourceType: cleanup.resourceType,
  })
}

async function reconcileMutationIntents({
  config,
  fetchImpl,
  inventory,
  journal,
  now,
  recipes,
  secrets,
}) {
  const operations = new Map(
    inventory.operations.map((operation) => [operation.operationId, operation]),
  )
  const recipeMap = new Map(recipes.map((recipe) => [recipe.operationId, recipe]))
  let current = journal
  for (const intent of pendingMutationIntents(current)) {
    const operation = operations.get(intent.operationId)
    const recipe = recipeMap.get(intent.operationId)
    if (!operation || !recipe) {
      throw new Error('A pending certification mutation no longer matches the pinned recipes.')
    }
    const { payload, response } = await performRequest({
      config,
      fetchImpl,
      operation,
      request: intent.request,
    })
    if (!recipe.expectedStatuses.includes(response.status)) {
      throw new Error(
        `Could not reconcile ${intent.operationId}; replay returned HTTP ${response.status}.`,
      )
    }
    const variables = { fixtureNamespace: config.fixtureNamespace }
    applyCaptures({ ...recipe, captures: intent.captures }, response, payload, variables)
    const cleanup = resolveTemplate(intent.cleanup, variables, `${intent.operationId}.cleanup`)
    current = registerResolvedCleanup(current, {
      cleanup,
      operationId: intent.operationId,
      registeredAt: now().toISOString(),
    })
    current = resolveMutationIntent(current, {
      idempotencyKey: intent.idempotencyKey,
      operationId: intent.operationId,
      resolvedAt: now().toISOString(),
    })
    writeCleanupJournal(config.cleanupJournalPath, current, { secrets })
  }
  return current
}

export async function recoverPositiveCertification({
  config,
  fetchImpl = fetch,
  inventory,
  now = () => new Date(),
  recipes,
}) {
  if (config.mode !== 'certification') {
    throw new Error('Certification recovery requires certification mode.')
  }
  const secrets = Object.values(config.secrets)
  let journal = readCleanupJournal(config.cleanupJournalPath)
  if (journal.fixtureNamespace !== config.fixtureNamespace) {
    throw new Error('The cleanup journal belongs to a different fixture namespace.')
  }
  journal = await reconcileMutationIntents({
    config,
    fetchImpl,
    inventory,
    journal,
    now,
    recipes,
    secrets,
  })
  return cleanJournal({ config, fetchImpl, inventory, journal, secrets })
}

export async function executePositiveCertification({
  config,
  fetchImpl = fetch,
  inventory,
  now = () => new Date(),
  recipes,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (
    config.mode !== 'certification' ||
    JSON.stringify(config.versions) !== JSON.stringify(['v1'])
  ) {
    throw new Error('The positive certification runner requires v1 certification mode.')
  }
  assertJournalPathReady(config.cleanupJournalPath)
  const secrets = Object.values(config.secrets)
  let journal = createCleanupJournal({
    createdAt: now().toISOString(),
    fixtureNamespace: config.fixtureNamespace,
    runId: config.runId,
  })
  writeCleanupJournal(config.cleanupJournalPath, journal, { secrets })
  const variables = { fixtureNamespace: config.fixtureNamespace }
  const operationMap = new Map(
    inventory.operations.map((operation) => [operation.operationId, operation]),
  )
  const results = []
  let stopped = false
  try {
    for (const recipe of recipes) {
      const operation = operationMap.get(recipe.operationId)
      if (stopped) {
        results.push(
          evidenceResult({
            expectedStatus: recipe.expectedStatuses,
            note: 'stopped_after_failure',
            operationId: operation.operationId,
            outcome: 'not_run',
            version: operation.version,
          }),
        )
        continue
      }
      if (results.length > 0) await sleep(config.requestIntervalMs)
      const started = performance.now()
      try {
        const request = ensureIdempotencyKey(
          resolveTemplate(recipe.request || {}, variables, recipe.operationId),
          operation,
          config,
        )
        let pendingIntent
        if (recipe.cleanup) {
          const unavailableCleanupVariables = [...templateVariables(recipe.cleanup)].filter(
            (name) => !Object.hasOwn(variables, name),
          )
          if (unavailableCleanupVariables.length > 0) {
            if (!operation.idempotencyRequired) {
              throw new Error(
                `${operation.operationId} cannot safely recover an unknown created resource.`,
              )
            }
            const idempotencyKey = Object.entries(request.headers || {}).find(
              ([name]) => name.toLowerCase() === 'idempotency-key',
            )?.[1]
            journal = registerMutationIntent(journal, {
              captures: recipe.captures || {},
              cleanup: recipe.cleanup,
              idempotencyKey: String(idempotencyKey),
              operationId: operation.operationId,
              registeredAt: now().toISOString(),
              request,
            })
            writeCleanupJournal(config.cleanupJournalPath, journal, { secrets })
            pendingIntent = { idempotencyKey: String(idempotencyKey) }
          } else {
            journal = registerResolvedCleanup(journal, {
              cleanup: resolveTemplate(recipe.cleanup, variables, `${recipe.operationId}.cleanup`),
              operationId: operation.operationId,
              registeredAt: now().toISOString(),
            })
            writeCleanupJournal(config.cleanupJournalPath, journal, { secrets })
          }
        }
        const { payload, response } = await performRequest({
          config,
          fetchImpl,
          operation,
          request,
        })
        if (!recipe.expectedStatuses.includes(response.status)) {
          results.push(
            resultFor(
              operation,
              recipe.expectedStatuses,
              started,
              response,
              'failed',
              'unexpected_status',
            ),
          )
          stopped = true
          continue
        }
        applyCaptures(recipe, response, payload, variables)
        if (pendingIntent) {
          const cleanup = resolveTemplate(
            recipe.cleanup,
            variables,
            `${recipe.operationId}.cleanup`,
          )
          journal = registerResolvedCleanup(journal, {
            cleanup,
            operationId: operation.operationId,
            registeredAt: now().toISOString(),
          })
          journal = resolveMutationIntent(journal, {
            idempotencyKey: pendingIntent.idempotencyKey,
            operationId: operation.operationId,
            resolvedAt: now().toISOString(),
          })
          writeCleanupJournal(config.cleanupJournalPath, journal, { secrets })
        }
        results.push(
          resultFor(
            operation,
            recipe.expectedStatuses,
            started,
            response,
            'passed',
            recipe.cleanup
              ? 'positive_fixture_and_cleanup_registered'
              : 'positive_fixture_succeeded',
          ),
        )
      } catch {
        results.push(
          resultFor(
            operation,
            recipe.expectedStatuses,
            started,
            undefined,
            'failed',
            'fixture_or_transport_error',
          ),
        )
        stopped = true
      }
    }
  } finally {
    journal = await reconcileMutationIntents({
      config,
      fetchImpl,
      inventory,
      journal,
      now,
      recipes,
      secrets,
    })
    await cleanJournal({ config, fetchImpl, inventory, journal, secrets })
  }
  return results
}
