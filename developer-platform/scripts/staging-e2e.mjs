import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TeamGridApiError, TeamGridClient } from '../packages/api-client/dist/index.js'
import {
  createSignedWebhookReceiver,
  createWebhookSiteReceiver,
} from './signed-webhook-receiver.mjs'
import {
  buildQualificationEvidence,
  resolveQualificationConfig,
  writeQualificationEvidence,
} from './staging-e2e-evidence.mjs'

const token = String(process.env.TEAMGRID_API_TOKEN || '').trim()
const baseUrl = String(process.env.TEAMGRID_API_BASE_URL || '').trim()
const originUrl = String(process.env.TEAMGRID_API_ORIGIN_URL || '').trim()
const expiredToken = String(process.env.TEAMGRID_E2E_EXPIRED_API_TOKEN || '').trim()
const foreignTaskId = String(process.env.TEAMGRID_E2E_FOREIGN_TASK_ID || '').trim()
const readOnlyToken = String(process.env.TEAMGRID_E2E_READ_ONLY_API_TOKEN || '').trim()
const wrongCellToken = String(process.env.TEAMGRID_E2E_WRONG_CELL_API_TOKEN || '').trim()
const configuredWebhookUrl = String(
  process.env.TEAMGRID_WEBHOOK_SMOKE_URL || 'https://example.com/teamgrid-staging-e2e',
).trim()
const verifyWebhookDelivery = process.env.TEAMGRID_E2E_WEBHOOK_DELIVERY === 'true'
const webhookReceiverMode = String(
  process.env.TEAMGRID_E2E_WEBHOOK_RECEIVER || 'webhook-site',
).trim()
const webhookReceiverAttempts = 3
const qualification = resolveQualificationConfig(process.env)
const execFileAsync = promisify(execFile)
const cliBinary = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url))
const mcpBinary = fileURLToPath(new URL('../packages/mcp-server/dist/bin.js', import.meta.url))

if (!token || !baseUrl) {
  throw new Error('TEAMGRID_API_TOKEN and TEAMGRID_API_BASE_URL are required.')
}
const parsedBaseUrl = new URL(baseUrl)
if (
  process.env.TEAMGRID_E2E_ALLOW_NON_STAGING !== 'true'
  && parsedBaseUrl.hostname !== 'localhost'
  && parsedBaseUrl.hostname !== '127.0.0.1'
  && !parsedBaseUrl.hostname.includes('staging')
) {
  throw new Error('Refusing to run mutation smoke outside staging or loopback.')
}
if (parsedBaseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsedBaseUrl.hostname)) {
  throw new Error('Staging API base URL must use HTTPS.')
}

const runId = randomUUID()
const client = new TeamGridClient({ baseUrl, retries: 2, timeoutMs: 30_000, token })
let taskId
let timeEntryId
let webhookId
let exportId
let customFieldDefinitionId
let projectTemplateId
let sourceProjectId
let instantiatedProjectId
let webhookReceiver
let webhookReceiverWasStarted = false
let webhookCaptureCleanupVerified = false
let observedWorkspace
let smokeClaims
let smokeFailure

async function runBinarySmokes(expectedWorkspaceId) {
  const environment = {
    ...process.env,
    TEAMGRID_API_BASE_URL: baseUrl,
    TEAMGRID_API_TOKEN: token,
  }
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliBinary, '--base-url', baseUrl, '--output', 'json', 'workspace'],
    { env: environment, maxBuffer: 1024 * 1024, timeout: 30_000 },
  )
  assert.equal(stderr, '')
  const cliWorkspace = JSON.parse(stdout)
  assert.equal(cliWorkspace.id, expectedWorkspaceId)
  assert.equal(stdout.includes(token), false)

  const transport = new StdioClientTransport({
    args: [mcpBinary, '--tool-profile', 'core'],
    command: process.execPath,
    env: environment,
    stderr: 'pipe',
  })
  const mcp = new McpClient({ name: 'teamgrid-staging-e2e', version: '1.0.0' })
  await mcp.connect(transport)
  try {
    const tools = await mcp.listTools()
    const names = tools.tools.map(tool => tool.name)
    assert(names.includes('teamgrid_workspace_get'))
    assert(names.every(name => !/(change|custom_field_value|planned_work|project_template)/i.test(name)))
    const result = await mcp.callTool({ arguments: {}, name: 'teamgrid_workspace_get' })
    const structuredContent = /** @type {{ data?: { id?: string } }} */ (
      result.structuredContent
    )
    assert.equal(structuredContent?.data?.id, expectedWorkspaceId)
    assert.equal(JSON.stringify(result).includes(token), false)
  } finally {
    await mcp.close()
  }
}

async function expectApiError(operation, expectedStatus) {
  try {
    await operation()
  } catch (error) {
    assert(error instanceof TeamGridApiError)
    assert.equal(error.status, expectedStatus)
    assert.match(error.requestId, /^[A-Za-z0-9._:-]{1,128}$/)
    return
  }
  assert.fail(`Expected TeamGrid API status ${expectedStatus}`)
}

async function expectRawFailure(candidateToken, expectedStatus) {
  const response = await fetch(new URL('workspace', `${baseUrl.replace(/\/$/, '')}/`), {
    headers: { authorization: `Bearer ${candidateToken}` },
    redirect: 'manual',
  })
  assert.equal(response.status, expectedStatus)
  assert.match(response.headers.get('x-request-id') || '', /^[A-Za-z0-9._:-]+$/)
}

async function expectRawJsonApiError({ body, idempotencyKey, path }, expectedStatus, expectedCode) {
  const response = await fetch(new URL(path, `${baseUrl.replace(/\/$/, '')}/`), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    method: 'POST',
    redirect: 'manual',
  })
  assert.equal(response.status, expectedStatus)
  const requestId = response.headers.get('x-request-id') || ''
  assert.match(requestId, /^[A-Za-z0-9._:-]{1,128}$/)
  const payload = await response.json()
  assert.equal(payload?.errors?.[0]?.code, expectedCode)
  assert.equal(payload?.meta?.requestId, requestId)
}

async function archiveProject(id) {
  const current = await client.projects.get(id)
  const accepted = await client.projects.archive(id, {
    idempotencyKey: `staging-e2e-cleanup-project-${id}-${runId}`,
    ifMatch: current.data.attributes.developerRevision,
  })
  const completed = await client.projectLifecycleOperations.wait(accepted.data.id, {
    maxWaitMs: 120_000,
    pollIntervalMs: 500,
  })
  assert.equal(completed.data.attributes.state, 'succeeded')
  return completed
}

async function archiveProjectTemplate(id) {
  const current = await client.projectTemplates.get(id)
  return client.projectTemplates.archive(id, {
    ifMatch: current.data.attributes.developerRevision,
  })
}

async function archiveTask(id) {
  const current = await client.tasks.get(id)
  return client.tasks.archive(id, {
    ifMatch: current.data.attributes.developerRevision,
  })
}

async function startSignedWebhookReceiver() {
  if (!['quick-tunnel', 'webhook-site'].includes(webhookReceiverMode)) {
    throw new Error('TEAMGRID_E2E_WEBHOOK_RECEIVER must be quick-tunnel or webhook-site.')
  }
  let lastError
  for (let attempt = 1; attempt <= webhookReceiverAttempts; attempt += 1) {
    try {
      return webhookReceiverMode === 'quick-tunnel'
        ? await createSignedWebhookReceiver()
        : await createWebhookSiteReceiver()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function waitUntilReconciled(verifyResource, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await verifyResource()) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Cleanup reconciliation did not observe the terminal state for ${label}.`)
}

async function waitForExport(id) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const current = await client.exports.get(id)
    if (current.data.attributes.state === 'succeeded') return current
    if (current.data.attributes.state === 'failed') {
      throw new Error('The private export job failed.')
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('The private export job did not complete before the deadline.')
}

async function verifyAbsent(readResource) {
  try {
    await readResource()
    return false
  } catch (error) {
    if (error instanceof TeamGridApiError && error.status === 404) {
      assert.match(error.requestId, /^[A-Za-z0-9._:-]{1,128}$/)
      return true
    }
    throw error
  }
}

async function verifyArchived(readResource) {
  const resource = await readResource()
  return resource.data.attributes.archived === true
}

async function reconcileResourceCleanup({ cleanup, id, label, verify }, report, failures) {
  if (!id) {
    report[label] = {
      cleanupAttempted: false,
      cleanupSucceeded: true,
      created: false,
      reconciliationVerified: true,
    }
    return
  }

  const record = {
    cleanupAttempted: true,
    cleanupSucceeded: false,
    created: true,
    reconciliationVerified: false,
  }
  report[label] = record
  try {
    await cleanup()
    record.cleanupSucceeded = true
  } catch (error) {
    failures.push(new Error(`${label} cleanup failed.`, { cause: error }))
  }
  try {
    await waitUntilReconciled(verify, label)
    record.reconciliationVerified = true
  } catch (error) {
    failures.push(new Error(`${label} terminal-state reconciliation failed.`, { cause: error }))
  }
}

try {
  if (verifyWebhookDelivery) {
    webhookReceiver = await startSignedWebhookReceiver()
    webhookReceiverWasStarted = true
  }
  const webhookUrl = webhookReceiver?.url || configuredWebhookUrl

  const workspace = await client.workspace.get()
  observedWorkspace = workspace
  if (qualification.expectedRegion) {
    assert.equal(workspace.data.attributes.region, qualification.expectedRegion)
  }
  if (qualification.expectedCellId) {
    assert.equal(workspace.data.attributes.cellId, qualification.expectedCellId)
  }
  await runBinarySmokes(workspace.data.id)

  const [projects, users, contacts] = await Promise.all([
    client.projects.list({ limit: 2 }),
    client.users.list({ limit: 2 }),
    client.contacts.list({ limit: 2 }),
  ])
  assert(projects.meta.requestId)
  assert(contacts.meta.requestId)
  assert(users.data.length > 0, 'Staging workspace requires at least one user')

  const invalidToken = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`
  const invalidClient = new TeamGridClient({ baseUrl, retries: 0, token: invalidToken })
  await expectApiError(() => invalidClient.workspace.get(), 401)
  if (expiredToken) await expectRawFailure(expiredToken, 401)
  if (wrongCellToken) await expectRawFailure(wrongCellToken, 503)
  if (foreignTaskId) await expectApiError(() => client.tasks.get(foreignTaskId), 404)
  if (readOnlyToken) {
    const readOnlyClient = new TeamGridClient({ baseUrl, retries: 0, token: readOnlyToken })
    await expectApiError(() => readOnlyClient.tasks.create({
      name: `Forbidden staging smoke ${runId}`,
    }, { idempotencyKey: `staging-e2e-forbidden-${runId}` }), 403)
  }

  if (originUrl) {
    const directOriginResponse = await fetch(new URL('/v1/workspace', originUrl), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
    })
    assert.equal(directOriginResponse.status, 403)
    assert.match(directOriginResponse.headers.get('x-request-id') || '', /^[A-Za-z0-9._:-]+$/)
  }

  await expectRawJsonApiError({
    body: { actions: ['task_created'], url: 'https://127.0.0.1/hook' },
    idempotencyKey: `staging-e2e-forbidden-webhook-${runId}`,
    path: 'webhooks',
  },
    400,
    'invalid_request',
  )
  const createdWebhook = await client.webhooks.create({
    actions: ['task_created'],
    url: webhookUrl,
  }, { idempotencyKey: `staging-e2e-webhook-${runId}` })
  webhookId = createdWebhook.data.id
  assert.equal(createdWebhook.data.attributes.version, 2)
  assert.match(createdWebhook.data.attributes.signingSecret || '', /^whsec_v2_[A-Za-z0-9_-]{43}$/)
  webhookReceiver?.setSigningSecret(createdWebhook.data.attributes.signingSecret)
  const readWebhook = await client.webhooks.get(webhookId)
  assert.equal(readWebhook.data.id, webhookId)
  assert.equal('signingSecret' in readWebhook.data.attributes, false)

  const sourceProject = await client.projects.create({
    name: `Developer Platform staging source ${runId}`,
  }, { idempotencyKey: `staging-e2e-project-${runId}` })
  sourceProjectId = sourceProject.data.id

  const changeCheckpointPage = await client.changes.checkpoint({
    limit: 50,
    resourceTypes: ['task'],
  })
  assert.equal(changeCheckpointPage.data.length, 0)
  assert.equal(changeCheckpointPage.meta.page.caughtUp, true)
  let changeCheckpoint = changeCheckpointPage.meta.page.nextCursor

  const idempotencyKey = `staging-e2e-task-${runId}`
  const taskInput = {
    assigneeId: users.data[0].id,
    description: `Developer Platform staging smoke ${runId}`,
    name: `Developer Platform staging smoke ${runId}`,
    plannedMinutes: 15,
    projectId: sourceProjectId,
  }
  const createdTask = await client.tasks.create(taskInput, { idempotencyKey })
  taskId = createdTask.data.id
  const replayedTask = await client.tasks.create(taskInput, { idempotencyKey })
  assert.equal(replayedTask.data.id, taskId)
  await expectApiError(
    () => client.tasks.create({ ...taskInput, name: `${taskInput.name} conflict` }, { idempotencyKey }),
    409,
  )

  let signedDelivery
  if (webhookReceiver) {
    signedDelivery = await webhookReceiver.waitForDelivery()
    assert.equal(signedDelivery.payload.event, 'task_created')
    assert.equal(signedDelivery.payload.item?._id, taskId)

    const deliveryDeadline = Date.now() + 30_000
    while (Date.now() < deliveryDeadline) {
      const deliveredWebhook = await client.webhooks.get(webhookId)
      if (deliveredWebhook.data.attributes.lastStatus === 204) {
        assert.equal(deliveredWebhook.data.attributes.failCount, 0)
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    const deliveredWebhook = await client.webhooks.get(webhookId)
    assert.equal(deliveredWebhook.data.attributes.lastStatus, 204)
    assert.equal(deliveredWebhook.data.attributes.failCount, 0)
  }

  const updatedTask = await client.tasks.update(taskId, {
    name: `${taskInput.name} updated`,
  }, {
    ifMatch: createdTask.data.attributes.developerRevision,
  })
  assert.equal(updatedTask.data.attributes.name, `${taskInput.name} updated`)
  assert.equal((await client.tasks.get(taskId)).data.id, taskId)

  const exportFileName = `staging-private-export-${runId}`
  const createdExport = await client.exports.create({
    fields: ['id', 'name'],
    fileName: exportFileName,
    maxRows: 50,
    resourceType: 'tasks',
    updatedFrom: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }, { idempotencyKey: `staging-e2e-export-${runId}` })
  exportId = createdExport.data.id
  const completedExport = await waitForExport(exportId)
  assert.equal(completedExport.data.attributes.fileName, `${exportFileName}.csv`)
  assert.equal(completedExport.data.attributes.resourceType, 'tasks')
  assert.equal(completedExport.data.attributes.rowCount > 0, true)
  const exportIntent = await client.exports.createDownloadIntent(exportId)
  assert.equal(exportIntent.data.attributes.fileName, `${exportFileName}.csv`)
  const downloadedExport = await client.exports.download(exportId, {
    intentToken: exportIntent.data.attributes.token,
    maxBytes: 64 * 1024,
  })
  assert.equal(downloadedExport.contentType, 'text/csv; charset=utf-8')
  assert.equal(downloadedExport.fileName, `${exportFileName}.csv`)
  assert.equal('url' in downloadedExport, false)
  const exportCsv = new TextDecoder().decode(downloadedExport.data)
  assert.equal(exportCsv.startsWith('"id";"name"\r\n'), true)
  assert.equal(exportCsv.includes(`"${taskId}";"${taskInput.name} updated"`), true)

  const changeDeadline = Date.now() + 30_000
  let taskChangeVerified = false
  while (!taskChangeVerified && Date.now() < changeDeadline) {
    for await (const page of client.changes.pages({
      cursor: changeCheckpoint,
      limit: 50,
      resourceTypes: ['task'],
    }, { maxPages: 100 })) {
      changeCheckpoint = page.meta.page.nextCursor
      taskChangeVerified = page.data.some(event => event.attributes.resourceId === taskId)
      assert.equal(page.meta.page.caughtUp || page.data.length === page.meta.page.limit, true)
    }
    if (!taskChangeVerified) await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  assert.equal(taskChangeVerified, true, 'Expected the disposable task in the v1 change feed')

  const customFieldDefinition = await client.customFieldDefinitions.create({
    configuration: { type: 'text' },
    defaultEnabled: true,
    fieldType: 'text',
    targetType: 'task',
    title: `Staging reference ${runId}`,
  }, { idempotencyKey: `staging-e2e-field-${runId}` })
  customFieldDefinitionId = customFieldDefinition.data.id
  assert.equal(customFieldDefinition.data.attributes.defaultEnabled, true)
  const emptyCustomValue = await client.customFieldValues.get(
    'task',
    taskId,
    customFieldDefinitionId,
  )
  const setCustomValue = await client.customFieldValues.set(
    'task',
    taskId,
    customFieldDefinitionId,
    { value: `staging-${runId}` },
    { ifMatch: emptyCustomValue.data.attributes.revision },
  )
  assert.equal(setCustomValue.data.attributes.value, `staging-${runId}`)
  const clearedCustomValue = await client.customFieldValues.clear(
    'task',
    taskId,
    customFieldDefinitionId,
    { ifMatch: setCustomValue.data.attributes.revision },
  )
  assert.equal(clearedCustomValue.data.attributes.state, 'unset')

  const currentPlannedWork = await client.plannedWork.getForTask(taskId)
  const plannedStart = new Date()
  plannedStart.setUTCHours(0, 0, 0, 0)
  const plannedEnd = new Date(plannedStart)
  plannedEnd.setUTCHours(23, 59, 59, 999)
  const plannedOperation = await client.plannedWork.replaceForTask(
    taskId,
    {
      dayLoads: [15],
      plannedEnd: plannedEnd.toISOString(),
      plannedStart: plannedStart.toISOString(),
    },
    {
      idempotencyKey: `staging-e2e-planned-${runId}`,
      ifMatch: currentPlannedWork.data.attributes.revision,
    },
  )
  const completedPlannedOperation = await client.plannedWorkOperations.wait(
    plannedOperation.data.id,
    { maxWaitMs: 120_000, pollIntervalMs: 500 },
  )
  assert.equal(completedPlannedOperation.data.attributes.state, 'succeeded')
  const replacedPlannedWork = await client.plannedWork.getForTask(taskId)
  assert.equal(replacedPlannedWork.data.attributes.revision, plannedOperation.data.attributes.targetRevision)
  const plannedWindow = await client.plannedWork.list({
    end: plannedEnd,
    start: plannedStart,
    taskId,
  })
  assert(plannedWindow.data.some(item => item.attributes.taskId === taskId))

  const projectTemplate = await client.projectTemplates.create({
    color: '#1557ed',
    description: `Developer Platform staging template ${runId}`,
    projectId: sourceProjectId,
    title: `Staging template ${runId}`,
  }, { idempotencyKey: `staging-e2e-template-${runId}` })
  projectTemplateId = projectTemplate.data.id
  const listedTemplates = await client.projectTemplates.list({ originProjectId: sourceProjectId })
  assert(listedTemplates.data.some(template => template.id === projectTemplateId))
  const instantiation = await client.projectTemplates.instantiate(
    projectTemplateId,
    { name: `Staging instantiated project ${runId}` },
    {
      idempotencyKey: `staging-e2e-instantiate-${runId}`,
      ifMatch: projectTemplate.data.attributes.developerRevision,
    },
  )
  const completedInstantiation = await client.projectTemplateInstantiations.wait(
    instantiation.data.id,
    { maxWaitMs: 120_000, pollIntervalMs: 500 },
  )
  assert.equal(completedInstantiation.data.attributes.state, 'succeeded')
  instantiatedProjectId = completedInstantiation.data.attributes.projectId

  const endAt = new Date()
  const startAt = new Date(endAt.getTime() - 5 * 60 * 1000)
  const createdTimeEntry = await client.timeEntries.create({
    comment: `Developer Platform staging smoke ${runId}`,
    endAt: endAt.toISOString(),
    startAt: startAt.toISOString(),
    taskId,
    userId: users.data[0].id,
  }, { idempotencyKey: `staging-e2e-time-${runId}` })
  timeEntryId = createdTimeEntry.data.id
  const updatedTimeEntry = await client.timeEntries.update(timeEntryId, {
    comment: `Developer Platform staging smoke ${runId} updated`,
  })
  assert.equal(updatedTimeEntry.data.id, timeEntryId)
  assert.equal((await client.timeEntries.get(timeEntryId)).data.attributes.taskId, taskId)

  const audit = await client.auditEvents.list({ limit: 100 })
  const runTargets = new Set([exportId, taskId, timeEntryId, webhookId])
  const runAuditEvents = audit.data.filter(event => runTargets.has(event.attributes.targetId || ''))
  assert(runAuditEvents.length >= 5, 'Expected durable audit events for staging mutations')
  assert(runAuditEvents.every(event => event.attributes.outcome === 'success'))

  if (webhookReceiver) {
    await webhookReceiver.close()
    webhookReceiver = null
    webhookCaptureCleanupVerified = true
  }

  smokeClaims = {
    auditEventsVerified: runAuditEvents.length,
    expiredCredentialVerified: Boolean(expiredToken),
    foreignTenantMissVerified: Boolean(foreignTaskId),
    idempotencyReplayVerified: true,
    binaryCliVerified: true,
    binaryMcpVerified: true,
    changeFeedVerified: taskChangeVerified,
    customFieldValuesVerified: true,
    negativeAuthVerified: true,
    originAuthVerified: Boolean(originUrl),
    readOnlyScopeVerified: Boolean(readOnlyToken),
    plannedWorkVerified: true,
    privateExportVerified: true,
    projectTemplatesVerified: true,
    signedWebhookDeliveryVerified: Boolean(signedDelivery),
    webhookCaptureCleanupVerified,
    wrongCellRoutingVerified: Boolean(wrongCellToken),
  }
} catch (error) {
  smokeFailure = error
}

const cleanupFailures = []
const cleanupResources = {}
await reconcileResourceCleanup({
  cleanup: () => client.webhooks.remove(webhookId),
  id: webhookId,
  label: 'webhook',
  verify: () => verifyAbsent(() => client.webhooks.get(webhookId)),
}, cleanupResources, cleanupFailures)
await reconcileResourceCleanup({
  cleanup: () => client.timeEntries.archive(timeEntryId),
  id: timeEntryId,
  label: 'timeEntry',
  verify: () => verifyArchived(() => client.timeEntries.get(timeEntryId)),
}, cleanupResources, cleanupFailures)
await reconcileResourceCleanup({
  cleanup: () => client.customFieldDefinitions.archive(customFieldDefinitionId),
  id: customFieldDefinitionId,
  label: 'customFieldDefinition',
  verify: () => verifyArchived(() => client.customFieldDefinitions.get(customFieldDefinitionId)),
}, cleanupResources, cleanupFailures)
await reconcileResourceCleanup({
  cleanup: () => archiveProjectTemplate(projectTemplateId),
  id: projectTemplateId,
  label: 'projectTemplate',
  verify: () => verifyArchived(() => client.projectTemplates.get(projectTemplateId)),
}, cleanupResources, cleanupFailures)
await reconcileResourceCleanup({
  cleanup: () => archiveTask(taskId),
  id: taskId,
  label: 'task',
  verify: () => verifyArchived(() => client.tasks.get(taskId)),
}, cleanupResources, cleanupFailures)
await reconcileResourceCleanup({
  cleanup: () => archiveProject(instantiatedProjectId),
  id: instantiatedProjectId,
  label: 'instantiatedProject',
  verify: () => verifyArchived(() => client.projects.get(instantiatedProjectId)),
}, cleanupResources, cleanupFailures)
await reconcileResourceCleanup({
  cleanup: () => archiveProject(sourceProjectId),
  id: sourceProjectId,
  label: 'sourceProject',
  verify: () => verifyArchived(() => client.projects.get(sourceProjectId)),
}, cleanupResources, cleanupFailures)

if (webhookReceiver) {
  try {
    await webhookReceiver.close()
    webhookReceiver = null
    webhookCaptureCleanupVerified = true
  } catch (error) {
    cleanupFailures.push(new Error('Webhook capture receiver cleanup failed.', { cause: error }))
  }
}
cleanupResources.webhookCaptureReceiver = {
  cleanupAttempted: webhookReceiverWasStarted,
  cleanupSucceeded: webhookCaptureCleanupVerified || !webhookReceiverWasStarted,
  created: webhookReceiverWasStarted,
  reconciliationVerified: webhookCaptureCleanupVerified || !webhookReceiverWasStarted,
}

if (smokeFailure || cleanupFailures.length > 0) {
  throw new AggregateError(
    [...(smokeFailure ? [smokeFailure] : []), ...cleanupFailures],
    'Developer Platform E2E or cleanup reconciliation failed.',
  )
}

smokeClaims.webhookCaptureCleanupVerified = webhookCaptureCleanupVerified
const cleanup = {
  complete: true,
  reconciled: Object.values(cleanupResources).every(resource => (
    resource.cleanupSucceeded && resource.reconciliationVerified
  )),
  resources: cleanupResources,
}
const evidence = buildQualificationEvidence({
  bindings: qualification.bindings,
  claims: smokeClaims,
  cleanup,
  qualifying: qualification.qualifying,
  runId,
  target: {
    cellId: observedWorkspace.data.attributes.cellId,
    region: observedWorkspace.data.attributes.region,
  },
})
const evidenceSha256 = writeQualificationEvidence(qualification.evidencePath, evidence)
console.log(JSON.stringify({ ...evidence, evidenceSha256 }))
