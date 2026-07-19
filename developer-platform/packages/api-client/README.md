# @teamgrid/api-client

Typed, region-aware client for TeamGrid API v1. It validates `tg_sk_v1`
credentials, derives the regional endpoint, applies bounded timeouts/retries,
supports stable cursor iterators, and exposes versioned errors without retaining
the bearer secret.

```ts
import { TeamGridClient } from '@teamgrid/api-client'

const teamgrid = new TeamGridClient({ token: process.env.TEAMGRID_API_TOKEN! })
const tasks = await teamgrid.tasks.list({ projectId: 'project-id' })
const list = await teamgrid.lists.create(
  { name: 'Delivery', parentId: 'project-id', type: 'tasks' },
  { idempotencyKey: 'delivery-list-1' },
)
```

The typed surface covers projects and lifecycle operations, tasks and timers,
time entries, contacts, call notes, contact groups, products and product groups,
project statements, lists, services, tags, custom-field definitions and values,
project templates and instantiations, planned work and replacement operations, users,
webhooks and credential-owned delivery history, audit events, and workspace
discovery. The `changes` client adds metadata-only checkpoints, bounded catch-up
pages, and a checkpoint-before-snapshot bootstrap helper. Every public operation is checked against the canonical capability
manifest during CI. Finance-gated fields are typed as optional and are absent
unless the credential has the documented overlay scope and workspace entitlement.

```ts
const bootstrap = await teamgrid.changes.snapshotThenCatchUp(async () => {
  const projects = []
  for await (const page of teamgrid.projects.pages()) projects.push(...page.data)
  return projects
}, { resourceTypes: ['project'] })

for await (const page of bootstrap.pages) {
  // Persist this only after applying page.data successfully.
  await saveCheckpoint(page.meta.page.nextCursor)
  if (page.meta.page.caughtUp) break
}
```

Change-feed cursors are bound to the credential, workspace, cell, and filter set. HTTP `410`
requires a new checkpoint plus a full resynchronization; HTTP `503` is a temporary fail-closed
condition and does not invalidate the last durable checkpoint.

Custom-field values and planned-work schedules use strong compare-and-set revisions. Read the
latest resource first and pass its revision explicitly; the SDK sends a strong `If-Match` header:

```ts
const current = await teamgrid.customFieldValues.get('project', 'project-id', 'field-id')
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

Tasks, projects, and project templates use the same rule for every update and state transition.
Their returned `developerRevision` values and canonical strong ETags are branded by resource type,
so a project ETag cannot accidentally be supplied to a task mutation. All five project mutations,
all five task mutations, and all four project-template mutations require `ifMatch` at compile time
and validate it again before network I/O. Project lifecycle changes and template instantiation also
require a stable idempotency key for safe retries:

```ts
const task = await teamgrid.tasks.get('task-id')
const updated = await teamgrid.tasks.update(
  task.data.id,
  { name: 'Reviewed task' },
  { ifMatch: task.data.attributes.developerRevision },
)

const project = await teamgrid.projects.get('project-id')
const operation = await teamgrid.projects.complete(project.data.id, {
  idempotencyKey: 'complete-project-id-v1',
  ifMatch: project.data.attributes.developerRevision,
})
await teamgrid.projectLifecycleOperations.wait(operation.data.id, {
  acceptedOperation: operation.data,
})
```

HTTP `412` means the resource changed: fetch it again, re-apply the intended change, and retry with
the new revision. The client never retries a stale mutation automatically. It also rejects a
successful response when the body revision and ETag differ. Pass the accepted operation to `wait`
as shown above: the client then binds every poll to the accepted operation ID, source revision,
action, and target resource, and also rejects inconsistent result revisions or terminal states.

Node.js 22.13–24 is supported. See the workspace README and checked OpenAPI v1
contract for the complete resource and security model.
