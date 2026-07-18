# @teamgrid/api-client

Typed, region-aware client for TeamGrid API v1. It validates `tg_sk_v1`
credentials, derives the regional endpoint, applies bounded timeouts/retries,
supports stable cursor iterators, and exposes versioned errors without retaining
the bearer secret.

```ts
import { TeamGridClient } from '@teamgrid/api-client'

const teamgrid = new TeamGridClient({ token: process.env.TEAMGRID_API_TOKEN! })
const tasks = await teamgrid.tasks.list({ projectId: 'project-id' })
```

Node.js 22.13–24 is supported. See the workspace README and checked OpenAPI v1
contract for the complete resource and security model.
