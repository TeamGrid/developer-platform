export type McpToolProfile = 'all' | 'collaboration' | 'core' | 'governance'

const coreTools = [
  'teamgrid_lists_list',
  'teamgrid_list_get',
  'teamgrid_product_get',
  'teamgrid_product_group_get',
  'teamgrid_product_groups_list',
  'teamgrid_products_list',
  'teamgrid_project_get',
  'teamgrid_projects_list',
  'teamgrid_tag_get',
  'teamgrid_tags_list',
  'teamgrid_task_get',
  'teamgrid_tasks_list',
  'teamgrid_time_entries_list',
  'teamgrid_time_entry_get',
  'teamgrid_workspace_get',
] as const
const collaborationTools = [
  ...coreTools,
  'teamgrid_call_note_get',
  'teamgrid_call_notes_list',
  'teamgrid_contact_get',
  'teamgrid_contact_group_get',
  'teamgrid_contact_groups_list',
  'teamgrid_contacts_list',
  'teamgrid_users_list',
] as const
const governanceTools = [
  ...coreTools,
  'teamgrid_custom_field_definition_get',
  'teamgrid_custom_field_definitions_list',
  'teamgrid_service_get',
  'teamgrid_services_list',
  'teamgrid_webhook_get',
  'teamgrid_webhooks_list',
] as const
const allTools = Array.from(new Set([...collaborationTools, ...governanceTools, 'teamgrid_search']))

export type McpToolName = (typeof allTools)[number]

export const allMcpTools: readonly McpToolName[] = Object.freeze([...allTools])

export const toolsByProfile: Readonly<Record<McpToolProfile, readonly string[]>> = Object.freeze({
  all: allTools,
  collaboration: collaborationTools,
  core: coreTools,
  governance: governanceTools,
})

export function parseMcpToolProfile(value: string | undefined): McpToolProfile {
  const profile = String(value || 'core')
    .trim()
    .toLowerCase()
  if (!Object.hasOwn(toolsByProfile, profile)) {
    throw new Error("MCP tool profile must be 'core', 'collaboration', 'governance', or 'all'.")
  }
  return profile as McpToolProfile
}

export function parseMcpToolFilter(value: string | undefined, option: string): McpToolName[] {
  if (!value?.trim()) return []
  const names = Array.from(
    new Set(
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  )
  const knownTools = new Set<string>(allMcpTools)
  if (
    !names.length ||
    names.length > allMcpTools.length ||
    names.some((name) => !knownTools.has(name))
  ) {
    throw new Error(`${option} must contain only registered TeamGrid MCP tool names.`)
  }
  return names as McpToolName[]
}

export function enabledMcpTools(
  profile: McpToolProfile,
  {
    allowTools,
    denyTools = [],
  }: { allowTools?: readonly McpToolName[]; denyTools?: readonly McpToolName[] } = {},
) {
  const profileTools = new Set<McpToolName>(toolsByProfile[profile] as readonly McpToolName[])
  const allow = allowTools === undefined ? new Set(profileTools) : new Set(allowTools)
  const deny = new Set(denyTools)
  const outsideProfile = [...allow].filter((name) => !profileTools.has(name))
  const overlap = allowTools === undefined ? [] : [...allow].filter((name) => deny.has(name))
  if (outsideProfile.length) {
    throw new Error(
      `MCP allow filter cannot enable tools outside the '${profile}' profile: ${outsideProfile.join(', ')}.`,
    )
  }
  if (overlap.length) {
    throw new Error(`MCP allow and deny filters overlap: ${overlap.join(', ')}.`)
  }
  return Object.freeze([...allow].filter((name) => !deny.has(name)))
}
