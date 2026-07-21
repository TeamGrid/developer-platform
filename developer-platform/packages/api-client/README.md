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
discovery. Every public operation is checked against the canonical capability
manifest during CI. Finance-gated fields are typed as optional and are absent
unless the credential has the documented overlay scope and workspace entitlement.

The change feed is deliberately deferred beyond the `1.0.0-beta.2` public contract. This release
does not expose a `changes` client or a `changes:read` scope. Use signed webhooks for event-driven
integration and regular bounded list requests for reconciliation.

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

Tasks, projects, and project templates use the static Beta 2 resource contract. These resources do
not expose developer revisions or strong ETags, and their update and lifecycle methods do not take
an `ifMatch` option. Project lifecycle changes and template instantiation remain asynchronous and
accept a stable idempotency key for safe retries:

```ts
const updated = await teamgrid.tasks.update(
  'task-id',
  { name: 'Reviewed task' },
)

const operation = await teamgrid.projects.complete('project-id', {
  idempotencyKey: 'complete-project-id-v1',
})
await teamgrid.projectLifecycleOperations.wait(operation.data.id, {
  acceptedOperation: operation.data,
})
```

Pass the accepted operation to `wait` as shown above: the client then binds every poll to the
accepted operation ID, action, and target resource, and rejects inconsistent terminal states.
Independent compare-and-set contracts such as custom-field values and planned work keep their
documented `ifMatch` requirements.

Node.js 22.14–24 is supported. See the workspace README and checked OpenAPI v1
contract for the complete resource and security model.
