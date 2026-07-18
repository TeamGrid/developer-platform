import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { TeamGridApiError, TeamGridClient } from '../packages/api-client/dist/index.js'
import {
  createSignedWebhookReceiver,
  createWebhookSiteReceiver,
} from './signed-webhook-receiver.mjs'

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
let webhookReceiver
let webhookCaptureCleanupVerified = false

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

try {
  if (verifyWebhookDelivery) webhookReceiver = await startSignedWebhookReceiver()
  const webhookUrl = webhookReceiver?.url || configuredWebhookUrl

  const workspace = await client.workspace.get()
  assert.equal(workspace.data.attributes.region, 'de')
  assert.equal(workspace.data.attributes.cellId, 'de-nbg-001')

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

  await expectApiError(
    () => client.webhooks.create({ actions: ['task_created'], url: 'http://127.0.0.1/hook' }),
    400,
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

  const idempotencyKey = `staging-e2e-task-${runId}`
  const taskInput = {
    description: `Developer Platform staging smoke ${runId}`,
    name: `Developer Platform staging smoke ${runId}`,
    plannedMinutes: 15,
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
    completed: true,
    name: `${taskInput.name} updated`,
  })
  assert.equal(updatedTask.data.attributes.completed, true)
  assert.equal((await client.tasks.get(taskId)).data.id, taskId)

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
  const runTargets = new Set([taskId, timeEntryId, webhookId])
  const runAuditEvents = audit.data.filter(event => runTargets.has(event.attributes.targetId || ''))
  assert(runAuditEvents.length >= 5, 'Expected durable audit events for staging mutations')
  assert(runAuditEvents.every(event => event.attributes.outcome === 'success'))

  if (webhookReceiver) {
    await webhookReceiver.close()
    webhookReceiver = null
    webhookCaptureCleanupVerified = true
  }

  console.log(JSON.stringify({
    auditEventsVerified: runAuditEvents.length,
    cellId: workspace.data.attributes.cellId,
    expiredCredentialVerified: Boolean(expiredToken),
    foreignTenantMissVerified: Boolean(foreignTaskId),
    idempotencyReplayVerified: true,
    negativeAuthVerified: true,
    originAuthVerified: Boolean(originUrl),
    readOnlyScopeVerified: Boolean(readOnlyToken),
    region: workspace.data.attributes.region,
    signedWebhookDeliveryVerified: Boolean(signedDelivery),
    webhookCaptureCleanupVerified,
    wrongCellRoutingVerified: Boolean(wrongCellToken),
    resources: {
      task: Boolean(taskId),
      timeEntry: Boolean(timeEntryId),
      webhook: Boolean(webhookId),
    },
    runId,
  }))
} finally {
  if (webhookId) await client.webhooks.remove(webhookId).catch(() => {})
  if (timeEntryId) await client.timeEntries.archive(timeEntryId).catch(() => {})
  if (taskId) await client.tasks.archive(taskId).catch(() => {})
  if (webhookReceiver) await webhookReceiver.close().catch(() => {})
}
