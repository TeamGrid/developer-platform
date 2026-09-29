import { TeamGridApiError, TeamGridClientError } from '@teamgrid/api-client'

const statusTools: Record<string, string> = {
  projectLifecycleOperation: 'teamgrid_project_lifecycle_operation_get',
  plannedWorkOperation: 'teamgrid_planned_work_operation_get',
  taskRecurrenceOperation: 'teamgrid_task_recurrence_operation_get',
  export: 'teamgrid_export_get',
}

/** Completion describes the underlying action, not merely a successful HTTP response. */
export function operationOutcome(data: unknown, write: boolean) {
  if (
    Array.isArray(data) &&
    data.length &&
    data.every((item) => item?.type === 'taskBulkUpdateResult')
  ) {
    const statuses = data.map((item) => item.attributes?.status)
    const done = statuses.filter((status) => status === 'updated').length
    return {
      outcome:
        done === statuses.length
          ? 'completed'
          : done > 0
            ? 'partial'
            : statuses.includes('unavailable')
              ? 'unknown'
              : 'failed',
    }
  }
  if (data && typeof data === 'object' && 'type' in data && typeof data.type === 'string') {
    const tool = statusTools[data.type]
    if (tool && 'id' in data && typeof data.id === 'string' && 'attributes' in data) {
      const attrs = data.attributes as Record<string, unknown>
      const state = attrs.state ?? attrs.status
      const outcome =
        state === 'succeeded'
          ? 'completed'
          : ['failed', 'cancelled'].includes(String(state))
            ? 'failed'
            : 'accepted'
      return { outcome, resume: { tool, arguments: { id: data.id } } }
    }
  }
  return write ? { outcome: 'completed' } : {}
}

export function mutationErrorOutcome(error: unknown, dispatched: boolean) {
  if (!dispatched) return 'failed'
  if (error instanceof TeamGridApiError && error.status >= 400 && error.status < 500)
    return 'failed'
  if (
    error instanceof TeamGridClientError &&
    [
      'workspace_mismatch',
      'resource_cas_required',
      'revision_required',
      'revision_conflict',
      'invalid_content_offset',
      'invalid_request',
    ].includes(error.code)
  )
    return 'failed'
  // A lost/invalid response cannot establish whether the mutation committed.
  return 'unknown'
}
