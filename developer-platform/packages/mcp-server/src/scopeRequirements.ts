import type { ScopeChallengeHandler } from '@modelcontextprotocol/server'
import { TeamGridApiError, type TeamGridClient } from '@teamgrid/api-client'
import catalog from './generated/domainCatalog.json' with { type: 'json' }
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
  if (
    [
      'teamgrid_members_list',
      'teamgrid_member_get',
      'teamgrid_invitations_list',
      'teamgrid_invitation_get',
    ].includes(name) &&
    input.includePii === true
  )
    scopes.add('members:pii:read')
  if (name.startsWith('teamgrid_custom_field_value')) {
    const target = {
      contact: 'contacts',
      project: 'projects',
      task: 'tasks',
      'project-journal-entry': 'project-statements',
    }[String(input.targetType)]
    if (target) scopes.add(`${target}:${catalog[name].write ? 'write' : 'read'}`)
  }
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

const commentById = new Set([
  'teamgrid_comment_get',
  'teamgrid_comment_update',
  'teamgrid_comment_archive',
  'teamgrid_comment_restore',
])
const resourceReadScopes = new Set([
  'tasks:read',
  'projects:read',
  'contacts:read',
  'audit:read',
  'task-recurrences:read',
  'time-entries:read',
])

/** Only a closed, backend-issued challenge can add resource-derived read scopes. */
export function resourceScopeChallenge(error: unknown, name?: McpToolName): string[] {
  if (
    !(error instanceof TeamGridApiError) ||
    error.status !== 403 ||
    error.errors[0]?.code !== 'insufficient_scope'
  )
    return []
  const challenge = error.transport?.headers['www-authenticate']
  const match = /^Bearer error="insufficient_scope", scope="([a-z:-]+(?: [a-z:-]+)*)"$/.exec(
    challenge ?? '',
  )
  const scopes = match?.[1]?.split(' ') ?? []
  const allowed = new Set(resourceReadScopes)
  if (name === 'teamgrid_invitations_list' || name === 'teamgrid_invitation_get')
    allowed.add('members:pii:read')
  if (name?.startsWith('teamgrid_custom_field_value')) {
    for (const scope of [
      'tags:read',
      'users:read',
      'project-statements:read',
      ...(catalog[name].write
        ? ['tasks:write', 'projects:write', 'contacts:write', 'project-statements:write']
        : []),
    ])
      allowed.add(scope)
  }
  if (name?.startsWith('teamgrid_appointment'))
    allowed.add(`appointments:delegated:${catalog[name].write ? 'write' : 'read'}`)
  if (name?.startsWith('teamgrid_absence'))
    allowed.add(catalog[name].write ? 'absences:admin:write' : 'absences:delegated:read')
  if (name === 'teamgrid_availability_list') allowed.add('availability:delegated:read')
  if (name) for (const scope of requiredToolScopes(name, {})) allowed.add(scope)
  return scopes.length > 0 && scopes.length <= 8 && scopes.every((scope) => allowed.has(scope))
    ? [...new Set(scopes)]
    : []
}

export function toolScopeChallenge(
  name: McpToolName,
  client?: TeamGridClient,
): ScopeChallengeHandler {
  return async ({ request, authInfo }) => {
    if (!authInfo) return undefined
    const consent = (scopes: readonly string[]) => ({
      scopes: [...new Set([...authInfo.scopes, ...scopes])].sort() as [string, ...string[]],
    })
    // The hosted verifier owns this workspace identity. A foreign target is a
    // business denial, so let the normal tool path report it without re-consent.
    const authorization = object(authInfo.extra?.authorization)
    if (
      catalog[name].write &&
      typeof authorization.workspaceId === 'string' &&
      object(request.params?.arguments).workspaceId !== authorization.workspaceId
    )
      return undefined
    const scopes = requiredToolScopes(name, request.params?.arguments)
    // A reviewed comment write needs its current target and version first.
    if (commentById.has(name) && !scopes.includes('comments:read')) scopes.push('comments:read')
    if (scopes.some((scope) => !authInfo.scopes.includes(scope))) return consent(scopes)
    if (!client || (!commentById.has(name) && name !== 'teamgrid_export_get')) return undefined
    const id = object(request.params?.arguments).id
    if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return undefined
    try {
      const options = { signal: AbortSignal.timeout(5000) }
      if (commentById.has(name)) await client.comments.get(id, options)
      else await client.exports.get(id, options)
    } catch (error) {
      const additional = resourceScopeChallenge(error, name)
      if (additional.some((scope) => !authInfo.scopes.includes(scope))) {
        return consent([...scopes, ...additional])
      }
      // Roles, sharing, missing resources and outages are reported by the normal tool path.
    }
    return undefined
  }
}
