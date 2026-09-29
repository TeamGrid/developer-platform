// Generated from the canonical capability contract. Run generate:mcp-scopes.
import type { McpToolName } from './toolProfiles.js'

export const toolScopes = {
  "teamgrid_appointment_get": [
    "appointments:read"
  ],
  "teamgrid_appointments_list": [
    "appointments:read"
  ],
  "teamgrid_availability_list": [
    "availability:read"
  ],
  "teamgrid_call_note_get": [
    "call-notes:read"
  ],
  "teamgrid_call_notes_list": [
    "call-notes:read"
  ],
  "teamgrid_comment_create": [
    "comments:write",
    "workspace:read"
  ],
  "teamgrid_comment_get": [
    "comments:read"
  ],
  "teamgrid_comments_list": [
    "comments:read"
  ],
  "teamgrid_contact_get": [
    "contacts:read"
  ],
  "teamgrid_contact_group_get": [
    "contact-groups:read"
  ],
  "teamgrid_contact_groups_list": [
    "contact-groups:read"
  ],
  "teamgrid_contacts_list": [
    "contacts:read"
  ],
  "teamgrid_custom_field_definition_get": [
    "custom-field-definitions:read"
  ],
  "teamgrid_custom_field_definitions_list": [
    "custom-field-definitions:read"
  ],
  "teamgrid_custom_field_value_get": [
    "custom-field-values:read"
  ],
  "teamgrid_document_get": [
    "documents:read"
  ],
  "teamgrid_documents_list": [
    "documents:read"
  ],
  "teamgrid_file_get": [
    "files:read"
  ],
  "teamgrid_files_list": [
    "files:read"
  ],
  "teamgrid_list_get": [
    "lists:read"
  ],
  "teamgrid_lists_list": [
    "lists:read"
  ],
  "teamgrid_product_get": [
    "products:read"
  ],
  "teamgrid_product_group_get": [
    "product-groups:read"
  ],
  "teamgrid_product_groups_list": [
    "product-groups:read"
  ],
  "teamgrid_products_list": [
    "products:read"
  ],
  "teamgrid_project_get": [
    "projects:read"
  ],
  "teamgrid_project_update": [
    "projects:write",
    "workspace:read"
  ],
  "teamgrid_projects_list": [
    "projects:read"
  ],
  "teamgrid_search": [
    "search:read"
  ],
  "teamgrid_service_get": [
    "services:read"
  ],
  "teamgrid_services_list": [
    "services:read"
  ],
  "teamgrid_tag_get": [
    "tags:read"
  ],
  "teamgrid_tags_list": [
    "tags:read"
  ],
  "teamgrid_task_complete": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_create": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_get": [
    "tasks:read"
  ],
  "teamgrid_task_move": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_get": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_occurrence_get": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_occurrences_list": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_preview": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_version_get": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_versions_list": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrences_list": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_reopen": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_update": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_tasks_list": [
    "tasks:read"
  ],
  "teamgrid_time_entries_list": [
    "time-entries:read"
  ],
  "teamgrid_time_entry_get": [
    "time-entries:read"
  ],
  "teamgrid_users_list": [
    "users:read"
  ],
  "teamgrid_webhook_get": [
    "webhooks:read"
  ],
  "teamgrid_webhooks_list": [
    "webhooks:read"
  ],
  "teamgrid_workspace_get": [
    "workspace:read"
  ]
} as const satisfies Record<McpToolName, readonly [string, ...string[]]>
