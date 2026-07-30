import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const httpMethods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'])
const privilegedOperationPattern =
  /(?:credential|invitation|member|personalAccessToken|role|serviceAccount|workspaceSettings)/i
const destructiveOperationPattern =
  /^(?:abort|archive|cancel|clear|delete|remove|revoke|rotate|stop)/i

const defaultContractUrls = {
  bindings: new URL('../../../openapi/developer-operation-bindings.json', import.meta.url),
  capabilities: new URL('../../../openapi/developer-capabilities.json', import.meta.url),
  manifest: new URL('../../../openapi/developer-platform-manifest.json', import.meta.url),
  migration: new URL('../../../openapi/v0-to-v1-migration.json', import.meta.url),
  v0: new URL('../../../openapi/v0.json', import.meta.url),
  v1: new URL('../../../openapi/v1.json', import.meta.url),
}

function fail(message) {
  throw new Error(`Conformance inventory failed: ${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)))
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1
}

function resolveReference(document, value) {
  if (!value?.$ref) return value
  if (!value.$ref.startsWith('#/')) fail(`external reference is unsupported: ${value.$ref}`)

  let current = document
  for (const part of value.$ref.slice(2).split('/')) {
    current = current?.[part.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  if (!current) fail(`reference cannot be resolved: ${value.$ref}`)
  return current
}

function collectParameters(document, pathItem, operation) {
  const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])]
  return parameters.map((candidate) => {
    const parameter = resolveReference(document, candidate)
    return {
      location: parameter.in,
      name: parameter.name,
      required: parameter.required === true,
    }
  })
}

function effectiveSecurity(document, operation) {
  return operation.security === undefined ? document.security || [] : operation.security
}

function classifyRisk(method, operationId) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'read'
  if (privilegedOperationPattern.test(operationId)) return 'privileged-mutation'
  if (method === 'DELETE' || destructiveOperationPattern.test(operationId)) {
    return 'destructive-mutation'
  }
  return 'mutation'
}

function operationExtensions(operation) {
  return Object.fromEntries(
    Object.entries(operation)
      .filter(([key]) => key.startsWith('x-teamgrid-'))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function baseOperation({ document, method, operation, path, pathItem, version }) {
  if (!operation.operationId) fail(`${version.toUpperCase()} ${method} ${path} has no operationId`)
  const parameters = collectParameters(document, pathItem, operation)
  const requiredParameters = parameters.filter((parameter) => parameter.required)
  const requestBodyRequired = operation.requestBody?.required === true
  const risk = classifyRisk(method, operation.operationId)

  return {
    authenticated: effectiveSecurity(document, operation).length > 0,
    cleanupRequired: risk !== 'read',
    conditionalScopes: sorted(operation['x-teamgrid-conditional-scopes'] || []),
    dynamicScopes: operation['x-teamgrid-dynamic-scopes'] || null,
    extensions: operationExtensions(operation),
    idempotencyRequired: parameters.some(
      (parameter) => parameter.location === 'header' && parameter.name === 'Idempotency-Key',
    ),
    ifMatchRequired: parameters.some(
      (parameter) => parameter.location === 'header' && parameter.name === 'If-Match',
    ),
    method,
    operationId: operation.operationId,
    optionalScopes: sorted(operation['x-teamgrid-optional-scopes'] || []),
    parameters,
    path,
    requestBodyRequired,
    requiredParameters,
    requiredScopes: sorted(operation['x-teamgrid-required-scopes'] || []),
    responseStatuses: sorted(Object.keys(operation.responses || {})),
    risk,
    testability: {
      automaticReadProbe:
        risk === 'read' && requiredParameters.length === 0 && !requestBodyRequired,
      requiresFixture: requiredParameters.length > 0 || requestBodyRequired || risk !== 'read',
    },
    version,
  }
}

function extractOperations(document, version) {
  const operations = []
  for (const [path, pathItem] of Object.entries(document.paths || {})) {
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      if (!httpMethods.has(rawMethod) || !operation) continue
      operations.push(
        baseOperation({
          document,
          method: rawMethod.toUpperCase(),
          operation,
          path,
          pathItem,
          version,
        }),
      )
    }
  }

  const operationIds = new Set()
  for (const operation of operations) {
    if (operationIds.has(operation.operationId)) {
      fail(`${version.toUpperCase()} operationId is duplicated: ${operation.operationId}`)
    }
    operationIds.add(operation.operationId)
  }
  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId))
}

function compareStringArrays(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

function bindV1Operations(operations, capabilities, bindings) {
  const policies = new Map(
    capabilities.operationPolicy.map((operation) => [operation.operationId, operation]),
  )
  const executionBindings = new Map(
    bindings.operations.map((operation) => [operation.operationId, operation]),
  )

  if (policies.size !== operations.length || executionBindings.size !== operations.length) {
    fail('V1 OpenAPI, capability policy, and execution-binding operation counts differ')
  }

  return operations.map((operation) => {
    const policy = policies.get(operation.operationId)
    const binding = executionBindings.get(operation.operationId)
    if (!policy || !binding) fail(`V1 operation is missing governance: ${operation.operationId}`)

    for (const governed of [policy, binding]) {
      if (governed.method !== operation.method || governed.path !== operation.path) {
        fail(`V1 governance route differs for ${operation.operationId}`)
      }
    }
    if (
      !compareStringArrays(operation.requiredScopes, binding.requiredScopes || []) ||
      !compareStringArrays(operation.conditionalScopes, binding.conditionalScopes || []) ||
      !compareStringArrays(operation.optionalScopes, binding.optionalScopes || [])
    ) {
      fail(`V1 scope governance differs for ${operation.operationId}`)
    }
    if (policy.scope !== (operation.requiredScopes[0] || null)) {
      fail(`V1 primary scope differs for ${operation.operationId}`)
    }
    if (!policy.sdk || !policy.cli || !policy.mcp?.exposure) {
      fail(`V1 surface policy is incomplete for ${operation.operationId}`)
    }

    return {
      ...operation,
      governance: {
        authMode: binding.authMode,
        dynamicPolicyIds: sorted(binding.dynamicPolicyIds || []),
        executionBindingCount: binding.executionBindings?.length || 0,
        handlerId: binding.handlerId,
      },
      surfaces: {
        api: { exposure: 'supported' },
        cli: { command: policy.cli, exposure: 'supported' },
        mcp: {
          exposure: policy.mcp.exposure,
          ...(policy.mcp.tool ? { tool: policy.mcp.tool } : {}),
          ...(policy.mcp.reason ? { reason: policy.mcp.reason } : {}),
        },
        sdk: { method: policy.sdk, exposure: 'supported' },
      },
    }
  })
}

function bindV0Operations(operations, migration) {
  const migrations = new Map(migration.routes.map((route) => [route.v0.operationId, route]))
  if (migrations.size !== operations.length) {
    fail('V0 OpenAPI and V0-to-V1 migration operation counts differ')
  }
  return operations.map((operation) => {
    const routeMigration = migrations.get(operation.operationId)
    const contractStatus =
      operation.extensions['x-teamgrid-contract-status'] ||
      routeMigration?.v0.contractStatus ||
      'documented'
    if (
      !routeMigration ||
      routeMigration.v0.method !== operation.method ||
      routeMigration.v0.path !== operation.path ||
      routeMigration.v0.contractStatus !== contractStatus
    ) {
      fail(`V0 migration mapping differs for ${operation.operationId}`)
    }
    return {
      ...operation,
      compatibility: {
        classification: routeMigration.classification,
        contractStatus,
        expectedUnavailable: contractStatus === 'unavailable',
        replacement: routeMigration.v1,
      },
      surfaces: {
        api: { exposure: contractStatus },
        cli: { exposure: 'not-applicable' },
        mcp: { exposure: 'not-applicable' },
        sdk: { exposure: 'not-applicable' },
      },
    }
  })
}

function buildSummary(operations) {
  const summary = {
    automaticReadProbes: 0,
    byContractStatus: {},
    byMethod: {},
    byRisk: {},
    byVersion: {},
    mcp: { forbidden: 0, read: 0, total: 0 },
    requiresFixture: 0,
    total: operations.length,
  }

  for (const operation of operations) {
    increment(summary.byVersion, operation.version)
    increment(summary.byMethod, operation.method)
    increment(summary.byRisk, operation.risk)
    if (operation.testability.automaticReadProbe) summary.automaticReadProbes += 1
    if (operation.testability.requiresFixture) summary.requiresFixture += 1
    if (operation.compatibility?.contractStatus) {
      increment(summary.byContractStatus, operation.compatibility.contractStatus)
    }
    if (operation.version === 'v1') {
      increment(summary.mcp, operation.surfaces.mcp.exposure)
      summary.mcp.total += 1
    }
  }
  return summary
}

function assertManifestCounts(manifest, v0Operations, v1Operations) {
  if (
    manifest.summary?.v0Operations !== v0Operations.length ||
    manifest.summary?.v1Operations !== v1Operations.length ||
    manifest.summary?.governedV1Operations !== v1Operations.length ||
    manifest.summary?.operationBindings !== v1Operations.length
  ) {
    fail('contract manifest operation counts differ from the local contracts')
  }
}

export async function buildConformanceInventory({ contractUrls = defaultContractUrls } = {}) {
  const entries = await Promise.all(
    Object.entries(contractUrls).map(async ([key, url]) => {
      const content = await readFile(url)
      return [key, { content, document: JSON.parse(content) }]
    }),
  )
  const contracts = Object.fromEntries(entries)
  const rawV0Operations = extractOperations(contracts.v0.document, 'v0')
  const rawV1Operations = extractOperations(contracts.v1.document, 'v1')
  const v0Operations = bindV0Operations(rawV0Operations, contracts.migration.document)
  const v1Operations = bindV1Operations(
    rawV1Operations,
    contracts.capabilities.document,
    contracts.bindings.document,
  )
  assertManifestCounts(contracts.manifest.document, v0Operations, v1Operations)

  const operations = [...v0Operations, ...v1Operations]
  return {
    contractVersion: contracts.manifest.document.contractVersion,
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([key, contract]) => [
        key,
        {
          bytes: contract.content.length,
          sha256: sha256(contract.content),
        },
      ]),
    ),
    inventoryDigest: sha256(JSON.stringify(operations)),
    operations,
    schemaVersion: 1,
    summary: buildSummary(operations),
  }
}

export function formatInventorySummary(inventory) {
  const { summary } = inventory
  return [
    `TeamGrid Developer Platform ${inventory.contractVersion}`,
    `${summary.total} API operations (${summary.byVersion.v0} V0, ${summary.byVersion.v1} V1)`,
    `${summary.automaticReadProbes} safe automatic read probes`,
    `${summary.requiresFixture} operations require parameters, fixtures, or cleanup`,
    `${summary.mcp.read} MCP reads; ${summary.mcp.forbidden} operations intentionally forbidden`,
    `Inventory digest: ${inventory.inventoryDigest}`,
  ].join('\n')
}
