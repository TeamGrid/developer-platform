import { listAllMcpTools } from './lib/mcp-tool-discovery.mjs'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  TEAMGRID_CHANGE_FEED_RESOURCE_TYPES,
  TeamGridClient,
} from '../packages/api-client/dist/index.js'
import { createProgram } from '../packages/cli/dist/index.js'
import { createTeamGridMcpServer, toolsByProfile } from '../packages/mcp-server/dist/index.js'

const syntheticToken = // gitleaks:allow -- fixed-format non-secret contract fixture
  'tg_sk_v1_us_us-mnz-001_0123456789abcdef01234567_' +
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function fail(message) {
  throw new Error(`Operation surface gate failed: ${message}`)
}

function openApiOperations(openapi) {
  const operations = []
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation?.operationId) continue
      if ((operation.security || []).some((item) => item.bearerAuth?.length)) {
        fail(`${operation.operationId} puts TeamGrid scopes on an HTTP bearer scheme`)
      }
      const scopes = operation['x-teamgrid-required-scopes'] || []
      operations.push({
        method: method.toUpperCase(),
        operationId: operation.operationId,
        path,
        scope: scopes[0] || null,
      })
    }
  }
  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId))
}

function commandPaths(command, prefix = []) {
  const result = []
  for (const child of command.commands) {
    const current = [...prefix, child.name()]
    result.push(current.join(' '), ...commandPaths(child, current))
  }
  return result
}

function commandsByPath(command, prefix = [], result = new Map()) {
  for (const child of command.commands) {
    const current = [...prefix, child.name()]
    result.set(current.join(' '), child)
    commandsByPath(child, current, result)
  }
  return result
}

function hasFunction(root, dottedPath) {
  const parts = dottedPath.split('.')
  let current = root
  for (const part of parts) current = current?.[part]
  return typeof current === 'function'
}

const [openapi, ledger, manifest, scopes] = await Promise.all([
  readFile(new URL('../../openapi/v1.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../../openapi/developer-capabilities.json', import.meta.url), 'utf8').then(
    JSON.parse,
  ),
  readFile(new URL('../../openapi/developer-platform-manifest.json', import.meta.url), 'utf8').then(
    JSON.parse,
  ),
  readFile(new URL('../../openapi/developer-scopes.json', import.meta.url), 'utf8').then(JSON.parse),
])

const expectedOperations = openApiOperations(openapi)
const policyOperations = ledger.operationPolicy
  .map((operation) => ({
    method: operation.method,
    operationId: operation.operationId,
    path: operation.path,
    scope: operation.scope,
  }))
  .sort((left, right) => left.operationId.localeCompare(right.operationId))
if (JSON.stringify(expectedOperations) !== JSON.stringify(policyOperations)) {
  fail('OpenAPI and developer capability policy operation sets differ')
}

const issuedScopes = Array.isArray(scopes) ? scopes : scopes.scopes
const changeOperation = openapi.paths['/changes']?.get
const changeResourceTypes = changeOperation?.parameters
  ?.find((parameter) => parameter.name === 'resourceTypes')
  ?.schema?.items?.enum
const changeEventResourceTypes = openapi.components?.schemas?.ChangeEvent?.properties?.attributes
  ?.properties?.resourceType?.enum
if (
  !Array.isArray(changeResourceTypes) ||
  changeResourceTypes.length !== 24 ||
  new Set(changeResourceTypes).size !== changeResourceTypes.length ||
  JSON.stringify(changeResourceTypes) !== JSON.stringify(changeEventResourceTypes) ||
  JSON.stringify(changeResourceTypes) !== JSON.stringify(TEAMGRID_CHANGE_FEED_RESOURCE_TYPES) ||
  !Array.isArray(issuedScopes) ||
  !issuedScopes.some((scope) => scope?.name === 'changes:read')
) {
  fail('change-feed resource types or the changes:read scope differ across release contracts')
}

const changePolicy = ledger.operationPolicy.find((operation) => operation.operationId === 'listChanges')
if (
  changePolicy?.sdk !== 'changes.list' ||
  changePolicy?.cli !== 'changes list' ||
  changePolicy?.mcp?.exposure !== 'forbidden' ||
  'tool' in changePolicy.mcp ||
  !/high-volume.*(?:synchronization|transport)/i.test(changePolicy.mcp.reason || '')
) {
  fail('listChanges must stay available through SDK/CLI and explicitly forbidden through MCP')
}

const expectedCoreOperationIds = [
  'archiveProject',
  'archiveProjectTemplate',
  'archiveTask',
  'completeProject',
  'completeTask',
  'createProject',
  'createProjectTemplate',
  'createTask',
  'duplicateTask',
  'getProject',
  'getProjectLifecycleOperation',
  'getProjectSharing',
  'getProjectTemplate',
  'getProjectTemplateInstantiation',
  'getTask',
  'instantiateProjectTemplate',
  'listProjects',
  'listProjectTemplates',
  'listTasks',
  'moveTask',
  'reopenProject',
  'reopenTask',
  'replaceProjectSharing',
  'replaceTaskSubtasks',
  'restoreProject',
  'restoreProjectTemplate',
  'restoreTask',
  'updateProject',
  'updateProjectTemplate',
  'updateTask',
]
const expectedIndependentIfMatchOperationIds = [
  'abortAutomationRun',
  'applyTaskAsTaskRecurrenceTemplate',
  'archiveAbsence',
  'archiveAppointment',
  'archiveAutomationDefinition',
  'archiveComment',
  'archiveDocument',
  'archiveFile',
  'archiveTaskRecurrence',
  'cancelInvitation',
  'clearCustomFieldValue',
  'clearTaskRecurrenceOccurrenceOverride',
  'deleteGroup',
  'deleteRole',
  'endTaskRecurrence',
  'removeMember',
  'removeTaskRecurrenceFromTasks',
  'renameFile',
  'overrideTaskRecurrenceOccurrence',
  'pauseTaskRecurrence',
  'replaceServiceAccountResourceGrants',
  'replaceTaskPlannedWork',
  'resendInvitation',
  'restoreAbsence',
  'restoreAppointment',
  'restoreAutomationDefinition',
  'restoreComment',
  'restoreDocument',
  'restoreFile',
  'restoreTaskRecurrence',
  'restoreTaskRecurrenceVersion',
  'resumeTaskRecurrence',
  'retryTaskRecurrenceOccurrence',
  'rotateWebhookSecret',
  'setCustomFieldValue',
  'transferTaskRecurrenceOwner',
  'updateAbsence',
  'updateAppointment',
  'updateAutomationDefinition',
  'updateComment',
  'updateDocument',
  'updateGroup',
  'updateMemberRole',
  'updateRole',
  'updateTimeEntryBilling',
  'updateTaskRecurrence',
  'updateWebhook',
  'updateWorkspaceSettings',
]
const expectedCoreCasOperationIds = [
  'archiveProject',
  'archiveProjectTemplate',
  'archiveTask',
  'completeProject',
  'completeTask',
  'duplicateTask',
  'instantiateProjectTemplate',
  'moveTask',
  'reopenProject',
  'reopenTask',
  'replaceProjectSharing',
  'replaceTaskSubtasks',
  'restoreProject',
  'restoreProjectTemplate',
  'restoreTask',
  'updateProject',
  'updateProjectTemplate',
  'updateTask',
]
const allOpenApiOperations = Object.values(openapi.paths)
  .flatMap((pathItem) => Object.values(pathItem))
  .filter((operation) => operation?.operationId)
const coreOperations = allOpenApiOperations
  .filter((operation) => expectedCoreOperationIds.includes(operation.operationId))
  .sort((left, right) => left.operationId.localeCompare(right.operationId))
const residualCasOperations = allOpenApiOperations
  .filter((operation) => operation?.['x-teamgrid-resource-cas'] === 'resource-cas-v1')
const residualCasReads = allOpenApiOperations.filter(
  (operation) => operation?.['x-teamgrid-resource-cas-read'] === 'resource-cas-v1',
)
const independentIfMatchOperations = allOpenApiOperations
  .filter((operation) =>
    (operation.parameters || []).some((parameter) =>
      /IfMatch/.test(parameter.$ref || parameter.name || ''),
    ),
  )
  .sort((left, right) => left.operationId.localeCompare(right.operationId))
if (
  coreOperations.length !== 30 ||
  JSON.stringify(coreOperations.map((operation) => operation.operationId)) !==
    JSON.stringify(expectedCoreOperationIds) ||
  manifest.summary?.resourceCasMutationOperations !== 18 ||
  manifest.summary?.resourceCasOperationReads !== 2 ||
  JSON.stringify(residualCasOperations.map((operation) => operation.operationId).sort()) !==
    JSON.stringify(expectedCoreCasOperationIds) ||
  JSON.stringify(residualCasReads.map((operation) => operation.operationId).sort()) !==
    JSON.stringify(['getProjectLifecycleOperation', 'getProjectTemplateInstantiation'])
) {
  fail('the stable contract must preserve 30 core operations with 18 CAS mutations and 2 qualified operation reads')
}
const expectedAllIfMatchOperationIds = [
  ...expectedCoreCasOperationIds,
  ...expectedIndependentIfMatchOperationIds,
].sort()
if (
  JSON.stringify(independentIfMatchOperations.map((operation) => operation.operationId)) !==
  JSON.stringify(expectedAllIfMatchOperationIds)
) {
  fail('the stable contract must expose the exact qualified If-Match operation set')
}
if (manifest.contractVersion !== openapi.info.version) {
  fail('contract manifest and OpenAPI versions differ')
}
for (const operation of residualCasOperations) {
  const ifMatchParameters = (operation.parameters || []).filter((parameter) =>
    /IfMatch(?:Project|ProjectTemplate|Task)$/.test(parameter.$ref || parameter.name || ''),
  )
  if (
    ifMatchParameters.length !== 1 ||
    operation.responses?.['412'] === undefined ||
    operation.responses?.['428'] === undefined ||
    operation['x-teamgrid-resource-cas'] !== 'resource-cas-v1'
  ) {
    fail(`${operation.operationId} lacks its required resource-CAS contract`)
  }
}
for (const parameterName of ['IfMatchProject', 'IfMatchProjectTemplate', 'IfMatchTask']) {
  if (openapi.components?.parameters?.[parameterName] === undefined) {
    fail(`required core parameter ${parameterName} is absent from OpenAPI`)
  }
}
for (const [schemaName, retiredFields] of Object.entries({
  Project: ['developerRevision', 'developerUpdatedAt'],
  ProjectLifecycleOperation: ['resultRevision', 'sourceRevision'],
  ProjectTemplate: ['developerRevision', 'developerUpdatedAt'],
  ProjectTemplateInstantiation: ['resultRevision', 'sourceRevision'],
  Task: ['developerRevision', 'developerUpdatedAt'],
})) {
  const properties = openapi.components?.schemas?.[schemaName]?.properties?.attributes?.properties
  if (!properties || retiredFields.some((field) => properties[field] === undefined)) {
    fail(`${schemaName} lacks required core resource-CAS fields`)
  }
}

const finalExpansionRoots = new Set([
  'automation-actions',
  'automation-definitions',
  'automation-runs',
  'exports',
  'groups',
  'integration-installations',
  'invitations',
  'members',
  'roles',
  'search',
])
const finalExpansionPolicy = ledger.operationPolicy.filter((operation) =>
  finalExpansionRoots.has(operation.path.split('/').filter(Boolean)[0]),
)
if (finalExpansionPolicy.length !== 36) fail('final domain operation inventory changed without review')

const sdk = new TeamGridClient({ fetch: async () => new Response(null, { status: 500 }), token: syntheticToken })
for (const operation of ledger.operationPolicy) {
  if (operation.sdk === null) {
    if (
      operation.operationId !== 'exchangeCliAuthorizationCode' ||
      typeof operation.sdkExclusionReason !== 'string' ||
      operation.sdkExclusionReason.length === 0
    ) {
      fail(`${operation.operationId} has an invalid SDK exclusion`)
    }
  } else if (!hasFunction(sdk, operation.sdk)) {
    fail(`${operation.operationId} lacks SDK method ${operation.sdk}`)
  }
}

const cliCommands = new Set(commandPaths(createProgram()))
const cliCommandMap = commandsByPath(createProgram())
for (const operation of ledger.operationPolicy) {
  if (!cliCommands.has(operation.cli)) fail(`${operation.operationId} lacks CLI command ${operation.cli}`)
}
for (const operation of residualCasOperations) {
  const policy = ledger.operationPolicy.find((entry) => entry.operationId === operation.operationId)
  const command = policy && cliCommandMap.get(policy.cli)
  const ifMatchOptions = command?.options.filter((option) => option.long === '--if-match') || []
  if (!policy || ifMatchOptions.length !== 1 || ifMatchOptions[0].mandatory !== true) {
    fail(`${operation.operationId} must expose one required CLI --if-match option`)
  }
}
for (const operation of independentIfMatchOperations) {
  const policy = ledger.operationPolicy.find((entry) => entry.operationId === operation.operationId)
  const command = policy && cliCommandMap.get(policy.cli)
  const ifMatchOptions = command?.options.filter((option) => option.long === '--if-match') || []
  const createIfMissingOptions =
    command?.options.filter((option) => option.long === '--create-if-missing') || []
  const createsFutureOccurrence = operation.operationId === 'overrideTaskRecurrenceOccurrence'
  if (
    !policy ||
    ifMatchOptions.length !== 1 ||
    ifMatchOptions[0].mandatory !== !createsFutureOccurrence ||
    (createsFutureOccurrence
      ? createIfMissingOptions.length !== 1 || createIfMissingOptions[0].mandatory === true
      : createIfMissingOptions.length !== 0)
  ) {
    fail(`${operation.operationId} must preserve one required CLI --if-match option`)
  }
}

const method = async () => ({ data: [], meta: {} })
const fakeClient = new Proxy({}, {
  get: () => new Proxy({}, { get: () => method }),
})
for (const profile of Object.keys(toolsByProfile)) {
  const mcpServer = createTeamGridMcpServer(fakeClient, { toolProfile: profile })
  const mcpClient = new Client({ name: 'surface-gate', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)])
  try {
    const { tools } = await listAllMcpTools(mcpClient)
    const advertised = new Set(tools.map((tool) => tool.name))
    for (const tool of tools) {
      const policy = ledger.operationPolicy.find((operation) => operation.mcp.tool === tool.name)?.mcp
      if (!policy || policy.exposure === 'forbidden' || (policy.profiles && !policy.profiles.includes(profile) && tool.name !== 'teamgrid_workspace_get')) {
        fail(`${profile} advertises ${tool.name} without explicit capability permission`)
      }
      const write = policy.exposure === 'gated-write'
      if (tool.annotations?.readOnlyHint !== !write || (write && profile !== 'work' && profile !== 'full' && !profile.endsWith('-write'))) {
        fail(`${profile}/${tool.name} has incorrect read/write metadata`)
      }
      if (write && !policy.requiredArguments.every((name) => tool.inputSchema.required?.includes(name))) {
        fail(`${tool.name} lacks required workspace/revision/idempotency arguments`)
      }
    }
    const expected = profile === 'all'
      ? ledger.operationPolicy.filter((operation) => operation.mcp.exposure === 'read' && !operation.mcp.profiles).map((operation) => operation.mcp.tool)
      : toolsByProfile[profile]
    if (JSON.stringify([...advertised].sort()) !== JSON.stringify([...expected].sort())) {
      fail(`${profile} differs from its explicit tool policy`)
    }
    for (const operation of ledger.operationPolicy.filter((operation) => operation.mcp.profiles?.includes(profile))) {
      if (!advertised.has(operation.mcp.tool)) fail(`${profile} is missing ${operation.mcp.tool}`)
    }
  } finally {
    await mcpClient.close()
    await mcpServer.close()
  }
}

console.log(`${ledger.operationPolicy.length} operations have verified SDK, CLI, and MCP decisions`)
