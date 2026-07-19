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
  'teamgrid_audit_events_list',
  'teamgrid_custom_field_definition_get',
  'teamgrid_custom_field_definitions_list',
  'teamgrid_service_get',
  'teamgrid_services_list',
  'teamgrid_webhook_get',
  'teamgrid_webhooks_list',
] as const
const allTools = Array.from(new Set([...collaborationTools, ...governanceTools]))

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
