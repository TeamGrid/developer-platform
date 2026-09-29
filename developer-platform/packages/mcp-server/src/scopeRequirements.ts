import type { ScopeChallengeHandler } from '@modelcontextprotocol/server'
import type { McpToolName } from './toolProfiles.js'
import { toolScopes } from './toolScopes.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** Only contract fields affect consent. Role, sharing and lock failures never do. */
export function requiredToolScopes(name: McpToolName, arguments_: unknown): [string, ...string[]] {
  const scopes = new Set<string>(toolScopes[name])
  const input = object(arguments_)
  const data = object(input.data)
  if (
    ['teamgrid_product_create', 'teamgrid_product_update'].includes(name) &&
    Object.hasOwn(data, 'purchasePrice')
  )
    scopes.add('products:finance:write')
  if (
    ['teamgrid_project_statement_create', 'teamgrid_project_statement_update'].includes(name) &&
    Object.hasOwn(data, 'purchasePrice')
  )
    scopes.add('project-statements:finance:write')
  if (name === 'teamgrid_project_statements_list' && input.type === 'budget')
    scopes.add('project-statements:finance:read')
  if (['teamgrid_members_list', 'teamgrid_member_get'].includes(name) && input.includePii === true)
    scopes.add('members:pii:read')
  if (
    ['teamgrid_comments_list', 'teamgrid_comment_create', 'teamgrid_activity_list'].includes(name)
  ) {
    const target = object(data.target)
    const type = target.type ?? input.targetType ?? data.targetType
    if (type === 'task' || type === 'project' || type === 'contact') scopes.add(`${type}s:read`)
  }
  if (name === 'teamgrid_search') {
    const types = data.types ?? input.types
    if (Array.isArray(types))
      for (const type of types) {
        if (['tasks', 'projects', 'contacts'].includes(type)) scopes.add(`${type}:read`)
      }
  }
  if (name === 'teamgrid_export_create') {
    const required: Record<string, string[]> = {
      auditEvents: ['audit:read'],
      contacts: ['contacts:read'],
      projects: ['projects:read'],
      tasks: ['tasks:read'],
      taskRecurrences: ['task-recurrences:read', 'tasks:read'],
      timeEntries: ['time-entries:read'],
    }
    for (const scope of required[String(data.resourceType)] ?? []) scopes.add(scope)
  }
  return [...scopes].sort() as [string, ...string[]]
}

export function toolScopeChallenge(name: McpToolName): ScopeChallengeHandler {
  return ({ request, authInfo }) => {
    if (!authInfo) return undefined
    const scopes = requiredToolScopes(name, request.params?.arguments)
    return scopes.some((scope) => !authInfo.scopes.includes(scope)) ? { scopes } : undefined
  }
}
