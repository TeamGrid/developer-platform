// Generated from the canonical capability contract. Run generate:mcp-scopes.
import type { McpToolName } from './toolProfiles.js'

export const toolScopes = {
  "teamgrid_absence_archive": [
    "absences:write",
    "workspace:read"
  ],
  "teamgrid_absence_create": [
    "absences:write",
    "workspace:read"
  ],
  "teamgrid_absence_get": [
    "absences:read"
  ],
  "teamgrid_absence_restore": [
    "absences:write",
    "workspace:read"
  ],
  "teamgrid_absence_update": [
    "absences:write",
    "workspace:read"
  ],
  "teamgrid_absences_list": [
    "absences:read"
  ],
  "teamgrid_activity_list": [
    "activity:read"
  ],
  "teamgrid_appointment_archive": [
    "appointments:write",
    "workspace:read"
  ],
  "teamgrid_appointment_create": [
    "appointments:write",
    "workspace:read"
  ],
  "teamgrid_appointment_get": [
    "appointments:read"
  ],
  "teamgrid_appointment_restore": [
    "appointments:write",
    "workspace:read"
  ],
  "teamgrid_appointment_update": [
    "appointments:write",
    "workspace:read"
  ],
  "teamgrid_appointments_list": [
    "appointments:read"
  ],
  "teamgrid_audit_events_list": [
    "audit:read"
  ],
  "teamgrid_automation_actions_list": [
    "automations:read"
  ],
  "teamgrid_automation_definition_archive": [
    "automations:write",
    "workspace:read"
  ],
  "teamgrid_automation_definition_create": [
    "automations:write",
    "workspace:read"
  ],
  "teamgrid_automation_definition_get": [
    "automations:read"
  ],
  "teamgrid_automation_definition_restore": [
    "automations:write",
    "workspace:read"
  ],
  "teamgrid_automation_definition_update": [
    "automations:write",
    "workspace:read"
  ],
  "teamgrid_automation_definition_versions_list": [
    "automations:read"
  ],
  "teamgrid_automation_definitions_list": [
    "automations:read"
  ],
  "teamgrid_automation_run_abort": [
    "automations:run",
    "workspace:read"
  ],
  "teamgrid_automation_run_get": [
    "automations:read"
  ],
  "teamgrid_automation_runs_list": [
    "automations:read"
  ],
  "teamgrid_availability_list": [
    "availability:read"
  ],
  "teamgrid_call_note_archive": [
    "call-notes:write",
    "workspace:read"
  ],
  "teamgrid_call_note_create": [
    "call-notes:write",
    "workspace:read"
  ],
  "teamgrid_call_note_get": [
    "call-notes:read"
  ],
  "teamgrid_call_note_restore": [
    "call-notes:write",
    "workspace:read"
  ],
  "teamgrid_call_notes_list": [
    "call-notes:read"
  ],
  "teamgrid_comment_archive": [
    "comments:write",
    "workspace:read"
  ],
  "teamgrid_comment_create": [
    "comments:write",
    "workspace:read"
  ],
  "teamgrid_comment_get": [
    "comments:read"
  ],
  "teamgrid_comment_restore": [
    "comments:write",
    "workspace:read"
  ],
  "teamgrid_comment_update": [
    "comments:write",
    "workspace:read"
  ],
  "teamgrid_comments_list": [
    "comments:read"
  ],
  "teamgrid_contact_create": [
    "contacts:write",
    "workspace:read"
  ],
  "teamgrid_contact_get": [
    "contacts:read"
  ],
  "teamgrid_contact_group_archive": [
    "contact-groups:write",
    "workspace:read"
  ],
  "teamgrid_contact_group_create": [
    "contact-groups:write",
    "workspace:read"
  ],
  "teamgrid_contact_group_get": [
    "contact-groups:read"
  ],
  "teamgrid_contact_group_restore": [
    "contact-groups:write",
    "workspace:read"
  ],
  "teamgrid_contact_group_update": [
    "contact-groups:write",
    "workspace:read"
  ],
  "teamgrid_contact_groups_list": [
    "contact-groups:read"
  ],
  "teamgrid_contact_update": [
    "contacts:write",
    "workspace:read"
  ],
  "teamgrid_contacts_list": [
    "contacts:read"
  ],
  "teamgrid_custom_field_definition_archive": [
    "custom-field-definitions:write",
    "workspace:read"
  ],
  "teamgrid_custom_field_definition_create": [
    "custom-field-definitions:write",
    "workspace:read"
  ],
  "teamgrid_custom_field_definition_get": [
    "custom-field-definitions:read"
  ],
  "teamgrid_custom_field_definition_restore": [
    "custom-field-definitions:write",
    "workspace:read"
  ],
  "teamgrid_custom_field_definition_update": [
    "custom-field-definitions:write",
    "workspace:read"
  ],
  "teamgrid_custom_field_definitions_list": [
    "custom-field-definitions:read"
  ],
  "teamgrid_custom_field_value_clear": [
    "custom-field-values:write",
    "workspace:read"
  ],
  "teamgrid_custom_field_value_get": [
    "custom-field-values:read"
  ],
  "teamgrid_custom_field_value_set": [
    "custom-field-values:write",
    "workspace:read"
  ],
  "teamgrid_custom_field_values_get": [
    "custom-field-values:read"
  ],
  "teamgrid_document_archive": [
    "documents:write",
    "workspace:read"
  ],
  "teamgrid_document_create": [
    "documents:write",
    "workspace:read"
  ],
  "teamgrid_document_get": [
    "documents:read"
  ],
  "teamgrid_document_restore": [
    "documents:write",
    "workspace:read"
  ],
  "teamgrid_document_update": [
    "documents:write",
    "workspace:read"
  ],
  "teamgrid_documents_list": [
    "documents:read"
  ],
  "teamgrid_event_catalog_get": [
    "events:read"
  ],
  "teamgrid_export_create": [
    "exports:write",
    "workspace:read"
  ],
  "teamgrid_export_get": [
    "exports:read"
  ],
  "teamgrid_file_archive": [
    "files:write",
    "workspace:read"
  ],
  "teamgrid_file_get": [
    "files:read"
  ],
  "teamgrid_file_rename": [
    "files:write",
    "workspace:read"
  ],
  "teamgrid_file_restore": [
    "files:write",
    "workspace:read"
  ],
  "teamgrid_files_list": [
    "files:read"
  ],
  "teamgrid_group_create": [
    "groups:write",
    "workspace:read"
  ],
  "teamgrid_group_delete": [
    "groups:write",
    "workspace:read"
  ],
  "teamgrid_group_get": [
    "groups:read"
  ],
  "teamgrid_group_update": [
    "groups:write",
    "workspace:read"
  ],
  "teamgrid_groups_list": [
    "groups:read"
  ],
  "teamgrid_integration_installations_list": [
    "integrations:read"
  ],
  "teamgrid_invitation_cancel": [
    "invitations:write",
    "workspace:read"
  ],
  "teamgrid_invitation_create": [
    "invitations:write",
    "workspace:read"
  ],
  "teamgrid_invitation_get": [
    "invitations:read"
  ],
  "teamgrid_invitation_resend": [
    "invitations:write",
    "workspace:read"
  ],
  "teamgrid_invitations_list": [
    "invitations:read"
  ],
  "teamgrid_list_archive": [
    "lists:write",
    "workspace:read"
  ],
  "teamgrid_list_create": [
    "lists:write",
    "workspace:read"
  ],
  "teamgrid_list_get": [
    "lists:read"
  ],
  "teamgrid_list_restore": [
    "lists:write",
    "workspace:read"
  ],
  "teamgrid_list_update": [
    "lists:write",
    "workspace:read"
  ],
  "teamgrid_lists_list": [
    "lists:read"
  ],
  "teamgrid_member_get": [
    "members:read"
  ],
  "teamgrid_member_remove": [
    "members:write",
    "workspace:read"
  ],
  "teamgrid_member_role_update": [
    "members:write",
    "workspace:read"
  ],
  "teamgrid_members_list": [
    "members:read"
  ],
  "teamgrid_planned_work_list": [
    "planned-work:read"
  ],
  "teamgrid_planned_work_operation_get": [
    "planned-work:write"
  ],
  "teamgrid_product_archive": [
    "products:write",
    "workspace:read"
  ],
  "teamgrid_product_create": [
    "products:write",
    "workspace:read"
  ],
  "teamgrid_product_get": [
    "products:read"
  ],
  "teamgrid_product_group_archive": [
    "product-groups:write",
    "workspace:read"
  ],
  "teamgrid_product_group_create": [
    "product-groups:write",
    "workspace:read"
  ],
  "teamgrid_product_group_get": [
    "product-groups:read"
  ],
  "teamgrid_product_group_update": [
    "product-groups:write",
    "workspace:read"
  ],
  "teamgrid_product_groups_list": [
    "product-groups:read"
  ],
  "teamgrid_product_update": [
    "products:write",
    "workspace:read"
  ],
  "teamgrid_products_list": [
    "products:read"
  ],
  "teamgrid_project_archive": [
    "projects:lifecycle",
    "workspace:read"
  ],
  "teamgrid_project_complete": [
    "projects:lifecycle",
    "workspace:read"
  ],
  "teamgrid_project_create": [
    "projects:write",
    "workspace:read"
  ],
  "teamgrid_project_get": [
    "projects:read"
  ],
  "teamgrid_project_lifecycle_operation_get": [
    "projects:lifecycle"
  ],
  "teamgrid_project_reopen": [
    "projects:lifecycle",
    "workspace:read"
  ],
  "teamgrid_project_restore": [
    "projects:lifecycle",
    "workspace:read"
  ],
  "teamgrid_project_sharing_get": [
    "projects:sharing"
  ],
  "teamgrid_project_sharing_replace": [
    "projects:sharing",
    "workspace:read"
  ],
  "teamgrid_project_statement_archive": [
    "project-statements:write",
    "workspace:read"
  ],
  "teamgrid_project_statement_create": [
    "project-statements:write",
    "workspace:read"
  ],
  "teamgrid_project_statement_get": [
    "project-statements:read"
  ],
  "teamgrid_project_statement_restore": [
    "project-statements:write",
    "workspace:read"
  ],
  "teamgrid_project_statement_update": [
    "project-statements:write",
    "workspace:read"
  ],
  "teamgrid_project_statements_list": [
    "project-statements:read"
  ],
  "teamgrid_project_template_archive": [
    "project-templates:write",
    "workspace:read"
  ],
  "teamgrid_project_template_create": [
    "project-templates:write",
    "workspace:read"
  ],
  "teamgrid_project_template_get": [
    "project-templates:read"
  ],
  "teamgrid_project_template_instantiate": [
    "project-templates:write",
    "projects:write",
    "workspace:read"
  ],
  "teamgrid_project_template_instantiation_get": [
    "project-templates:write",
    "projects:write"
  ],
  "teamgrid_project_template_restore": [
    "project-templates:write",
    "workspace:read"
  ],
  "teamgrid_project_template_update": [
    "project-templates:write",
    "workspace:read"
  ],
  "teamgrid_project_templates_list": [
    "project-templates:read"
  ],
  "teamgrid_project_update": [
    "projects:write",
    "workspace:read"
  ],
  "teamgrid_projects_list": [
    "projects:read"
  ],
  "teamgrid_role_create": [
    "roles:write",
    "workspace:read"
  ],
  "teamgrid_role_delete": [
    "roles:write",
    "workspace:read"
  ],
  "teamgrid_role_get": [
    "roles:read"
  ],
  "teamgrid_role_update": [
    "roles:write",
    "workspace:read"
  ],
  "teamgrid_roles_list": [
    "roles:read"
  ],
  "teamgrid_search": [
    "search:read"
  ],
  "teamgrid_service_archive": [
    "services:write",
    "workspace:read"
  ],
  "teamgrid_service_create": [
    "services:write",
    "workspace:read"
  ],
  "teamgrid_service_get": [
    "services:read"
  ],
  "teamgrid_service_restore": [
    "services:write",
    "workspace:read"
  ],
  "teamgrid_service_update": [
    "services:write",
    "workspace:read"
  ],
  "teamgrid_services_list": [
    "services:read"
  ],
  "teamgrid_tag_archive": [
    "tags:write",
    "workspace:read"
  ],
  "teamgrid_tag_create": [
    "tags:write",
    "workspace:read"
  ],
  "teamgrid_tag_get": [
    "tags:read"
  ],
  "teamgrid_tag_restore": [
    "tags:write",
    "workspace:read"
  ],
  "teamgrid_tag_update": [
    "tags:write",
    "workspace:read"
  ],
  "teamgrid_tags_list": [
    "tags:read"
  ],
  "teamgrid_task_archive": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_complete": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_create": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_duplicate": [
    "tasks:read",
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
  "teamgrid_task_planned_work_get": [
    "planned-work:read"
  ],
  "teamgrid_task_planned_work_replace": [
    "planned-work:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_apply_task_template": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_archive": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_create": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_end": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_event_submit": [
    "task-recurrences:run",
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
  "teamgrid_task_recurrence_occurrence_override": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_occurrence_override_clear": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_occurrence_retry": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_occurrences_list": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_operation_cancel": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_operation_get": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_owner_transfer": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_pause": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_preview": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_preview_input": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write"
  ],
  "teamgrid_task_recurrence_recheck": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_remove_from_tasks": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_restore": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_resume": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_update": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_recurrence_version_get": [
    "task-recurrences:read",
    "tasks:read"
  ],
  "teamgrid_task_recurrence_version_restore": [
    "task-recurrences:write",
    "tasks:read",
    "tasks:write",
    "workspace:read"
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
  "teamgrid_task_restore": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_subtasks_replace": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_task_timer_start": [
    "tasks:write",
    "time-entries:write",
    "workspace:read"
  ],
  "teamgrid_task_timer_stop": [
    "tasks:write",
    "time-entries:write",
    "workspace:read"
  ],
  "teamgrid_task_update": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_tasks_bulk_update": [
    "tasks:write",
    "workspace:read"
  ],
  "teamgrid_tasks_list": [
    "tasks:read"
  ],
  "teamgrid_time_entries_list": [
    "time-entries:read"
  ],
  "teamgrid_time_entry_archive": [
    "time-entries:write",
    "workspace:read"
  ],
  "teamgrid_time_entry_billing_get": [
    "time-entries:billing"
  ],
  "teamgrid_time_entry_billing_update": [
    "time-entries:billing",
    "workspace:read"
  ],
  "teamgrid_time_entry_create": [
    "time-entries:write",
    "workspace:read"
  ],
  "teamgrid_time_entry_get": [
    "time-entries:read"
  ],
  "teamgrid_time_entry_restore": [
    "time-entries:write",
    "workspace:read"
  ],
  "teamgrid_time_entry_update": [
    "time-entries:write",
    "workspace:read"
  ],
  "teamgrid_users_list": [
    "users:read"
  ],
  "teamgrid_webhook_deliveries_list": [
    "webhooks:read"
  ],
  "teamgrid_webhook_delivery_get": [
    "webhooks:read"
  ],
  "teamgrid_webhook_delivery_test": [
    "webhooks:write",
    "workspace:read"
  ],
  "teamgrid_webhook_get": [
    "webhooks:read"
  ],
  "teamgrid_webhook_remove": [
    "webhooks:write",
    "workspace:read"
  ],
  "teamgrid_webhook_update": [
    "webhooks:write",
    "workspace:read"
  ],
  "teamgrid_webhooks_list": [
    "webhooks:read"
  ],
  "teamgrid_workspace_get": [
    "workspace:read"
  ],
  "teamgrid_workspace_settings_get": [
    "workspace-settings:read"
  ],
  "teamgrid_workspace_settings_update": [
    "workspace-settings:write",
    "workspace:read"
  ]
} as const satisfies Record<McpToolName, readonly [string, ...string[]]>

/** Advertised support is distinct from initial consent and never grants authority. */
export const supportedOAuthScopes = [
  "absences:admin:write",
  "absences:delegated:read",
  "absences:read",
  "absences:write",
  "activity:read",
  "appointments:delegated:read",
  "appointments:delegated:write",
  "appointments:read",
  "appointments:write",
  "audit:read",
  "automations:read",
  "automations:run",
  "automations:write",
  "availability:delegated:read",
  "availability:read",
  "call-notes:read",
  "call-notes:write",
  "comments:read",
  "comments:write",
  "contact-groups:read",
  "contact-groups:write",
  "contacts:read",
  "contacts:write",
  "custom-field-definitions:read",
  "custom-field-definitions:write",
  "custom-field-values:read",
  "custom-field-values:write",
  "documents:read",
  "documents:write",
  "events:read",
  "exports:read",
  "exports:write",
  "files:read",
  "files:write",
  "groups:read",
  "groups:write",
  "integrations:read",
  "invitations:read",
  "invitations:write",
  "lists:read",
  "lists:write",
  "members:pii:read",
  "members:read",
  "members:write",
  "planned-work:read",
  "planned-work:write",
  "product-groups:read",
  "product-groups:write",
  "products:finance:read",
  "products:finance:write",
  "products:read",
  "products:write",
  "project-statements:finance:read",
  "project-statements:finance:write",
  "project-statements:read",
  "project-statements:write",
  "project-templates:read",
  "project-templates:write",
  "projects:lifecycle",
  "projects:read",
  "projects:sharing",
  "projects:write",
  "roles:read",
  "roles:write",
  "search:read",
  "services:read",
  "services:write",
  "tags:read",
  "tags:write",
  "task-recurrences:read",
  "task-recurrences:run",
  "task-recurrences:write",
  "tasks:read",
  "tasks:write",
  "time-entries:billing",
  "time-entries:read",
  "time-entries:write",
  "users:read",
  "webhooks:read",
  "webhooks:write",
  "workspace-settings:read",
  "workspace-settings:write",
  "workspace:read"
] as const
