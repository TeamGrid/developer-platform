# @teamgrid/api-client

Typed, region-aware client for TeamGrid API v1. It validates native
`tg_pat_v2` personal-access credentials, `tg_sa_v2` service-account credentials,
and supported legacy `tg_sk_v1` credentials, derives the regional endpoint,
applies bounded timeouts/retries, supports stable cursor iterators, and exposes
versioned errors without retaining the bearer secret.

```ts
import { TeamGridClient } from '@teamgrid/api-client'

const teamgrid = new TeamGridClient({ token: process.env.TEAMGRID_API_TOKEN! })
const tasks = await teamgrid.tasks.list({ projectId: 'project-id' })
const list = await teamgrid.lists.create(
  { name: 'Delivery', parentId: 'project-id', type: 'tasks' },
  { idempotencyKey: 'delivery-list-1' },
)

const context = await teamgrid.authorization.getContext()
console.log(context.data.attributes.scopes)

const testDelivery = await teamgrid.webhooks.testDelivery('webhook-id', {
  idempotencyKey: 'webhook-test-1',
})
```

`authorization.getContext()` returns only safe, no-store metadata for the exact
current credential and requires no additional scope. Use
`authorization.revokeCurrentCredential()` only for an explicit permanent
self-revocation flow; the credential cannot be restored after success.

The typed surface covers projects and lifecycle operations, tasks and timers,
time entries, contacts, call notes, contact groups, products and product groups,
project statements, lists, services, tags, custom-field definitions and values,
project templates and instantiations, recurring-task definitions, immutable versions and
occurrence ledgers, planned work and replacement operations, users,
webhooks and credential-owned delivery history, audit events, and workspace
discovery. Every public operation is checked against the canonical capability
manifest during CI. Finance-gated fields are typed as optional and are absent
unless the credential has the documented overlay scope and workspace entitlement.
Time-entry billing is isolated behind `time-entries:billing` and the workspace's
existing lock permission:

```ts
const billing = await teamgrid.timeEntries.getBilling('time-entry-id')
await teamgrid.timeEntries.updateBilling(
  'time-entry-id',
  { billed: true },
  { ifMatch: billing.data.attributes.revision },
)
```

The update fails with `412` if the billing state changed after the read.

Large CSV exports can be consumed as a bounded Web `ReadableStream` instead of
being buffered in memory. Always select an application-specific ceiling and
fully consume or cancel the one-shot stream:

```ts
const intent = await teamgrid.exports.createDownloadIntent('export-id')
const download = await teamgrid.exports.downloadStream('export-id', {
  intentToken: intent.data.attributes.token,
  maxBytes: 10 * 1024 * 1024,
})
await download.data.pipeTo(yourWritableStream)
```

The stable change feed exposes metadata-only resource changes through `teamgrid.changes`.
Create a checkpoint immediately before a full snapshot, then consume bounded pages from that
checkpoint. Cursors are opaque and bound to the credential, workspace, cell, epoch, and exact
filters; persist and replay them verbatim against the same regional endpoint:

```ts
const bootstrap = await teamgrid.changes.snapshotThenCatchUp(
  async () => teamgrid.tasks.list({ limit: 200 }),
  { resourceTypes: ['task'] },
)
for await (const page of bootstrap.pages) {
  await persistChanges(page.data, page.meta.page.nextCursor)
}
```

A `410` response requires a fresh checkpoint and full snapshot. Use signed webhooks for
low-latency notifications and the change feed for durable reconciliation.

Custom-field values and planned-work schedules use strong compare-and-set revisions. Read the
latest resource first and pass its revision explicitly; the SDK sends a strong `If-Match` header:

```ts
const current = await teamgrid.customFieldValues.get('project', 'project-id', 'field-id')
const values = await teamgrid.customFieldValues.getMany(
  'project',
  'project-id',
  ['field-id', 'another-field-id'],
)
await teamgrid.customFieldValues.set(
  'project',
  'project-id',
  'field-id',
  { value: 'ACME-42' },
  { ifMatch: current.data.attributes.revision },
)

const schedule = await teamgrid.plannedWork.getForTask('task-id')
const accepted = await teamgrid.plannedWork.replaceForTask(
  'task-id',
  {
    dayLoads: [480, 240],
    plannedStart: '2026-07-20T00:00:00.000Z',
    plannedEnd: '2026-07-21T23:59:59.999Z',
  },
  { idempotencyKey: 'schedule-task-id-v2', ifMatch: schedule.data.attributes.revision },
)
await teamgrid.plannedWorkOperations.wait(accepted.data.id)
```

Tasks, projects, and project templates expose a developer revision and strong ETag. Read the
resource first, then pass that ETag or its prefixed revision to every update or lifecycle mutation.
Project lifecycle changes and template instantiation remain asynchronous and also accept a stable
idempotency key for safe retries:

```ts
const task = await teamgrid.tasks.get('task-id')
const updated = await teamgrid.tasks.update(
  'task-id',
  { name: 'Reviewed task' },
  { ifMatch: task.transport.headers.etag },
)

const project = await teamgrid.projects.get('project-id')
const operation = await teamgrid.projects.complete('project-id', {
  idempotencyKey: 'complete-project-id-v1',
  ifMatch: project.transport.headers.etag,
})
await teamgrid.projectLifecycleOperations.wait(operation.data.id, {
  acceptedOperation: operation.data,
})
```

Pass the accepted operation to `wait` as shown above: the client then binds every poll to the
accepted operation ID, action, and target resource, and rejects inconsistent terminal states.
Independent compare-and-set contracts such as custom-field values and planned work keep their
documented `ifMatch` requirements.

Recurring tasks have their own strong `tr1` series and `tro1` occurrence validators. Creation is
idempotent and existing series/occurrence mutations require the latest ETag. A stored preview also
returns an opaque `placeholderToken`: combine it with `{ createIfMissing: true }` to atomically
override a future occurrence before the scanner has created its ledger row. A bounded draft
preview returns the preview directly; a high-cost policy returns an
encrypted recoverable preview operation. Recheck and preview operations can be polled to a
monotonic terminal state:

```ts
const created = await teamgrid.taskRecurrences.create(
  { sourceTaskId: 'task-id', policy: recurrencePolicy },
  { idempotencyKey: 'daily-review-v1' },
)
const preview = await teamgrid.taskRecurrences.previewStored(created.data.id, { count: 10 })
const future = preview.data.attributes.occurrences[0]
await teamgrid.taskRecurrenceOccurrences.override(
  created.data.id,
  future.occurrenceKey,
  { action: 'skip', placeholderToken: future.placeholderToken! },
  { createIfMissing: true },
)
const draft = await teamgrid.taskRecurrences.preview({ policy: recurrencePolicy })
if (draft.data.type === 'taskRecurrenceOperation') {
  await teamgrid.taskRecurrenceOperations.wait(draft.data.id)
}
const operation = await teamgrid.taskRecurrences.recheck(created.data.id)
await teamgrid.taskRecurrenceOperations.wait(operation.data.id)
// Ends the series and detaches its materialized tasks without deleting history.
await teamgrid.taskRecurrences.removeFromTasks(created.data.id, {
  ifMatch: created.etag!,
})
```

After detachment, occurrence resources expose `cardId: null` together with the immutable
`detachedCardId`, `detachedAt`, and `detachedBy` audit fields.

The generated policy types include all materialization strategies (`none`, `latest`, `bounded`,
`all`; `allow`, `defer`, `skip`, `latest-only`, `pause-series`), invalid monthly-date handling,
wall-clock versus elapsed time, and completion-transition semantics. Completion-relative rules
default to the first completion; opt into `every-completion-transition` only for workflows that
must react again after reopen/complete cycles.

Node.js 22.14–24 is supported. See the workspace README and checked OpenAPI v1
contract for the complete resource and security model.
