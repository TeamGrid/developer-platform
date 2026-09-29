# Candidate MCP coverage

Generated from the reviewed canonical API contract. Not a publication or live qualification claim.

The full profile contains 207 tools: 84 reads and 123 writes. 30 API operations use other connection or transfer surfaces.

All writes require workspaceId and current API authorization. Conditional tools accept the exact quoted meta.etag returned by the preceding read. Per-item revision uses data.items[].revision. Unconditional means the API has no revision precondition. Idempotency keys protect repetition of one intent, not concurrent edits.

Domain profiles include their listed tools plus teamgrid_workspace_get. Scope reports list base/compound scopes; optional finance, sharing and cross-resource fields can require additional server-side scopes. A listed tool does not grant roles, scopes or product entitlements.

| Tool | Domain profile | Mode | Concurrency | Stable key required |
| --- | --- | --- | --- | --- |
| `teamgrid_absence_archive` | schedule-write | write | conditional | — |
| `teamgrid_absence_create` | schedule-write | write | unconditional | yes |
| `teamgrid_absence_get` | schedule-write | read | read | — |
| `teamgrid_absence_restore` | schedule-write | write | conditional | — |
| `teamgrid_absence_update` | schedule-write | write | conditional | — |
| `teamgrid_absences_list` | schedule-write | read | read | — |
| `teamgrid_activity_list` | content-write | read | read | — |
| `teamgrid_appointment_archive` | schedule-write | write | conditional | — |
| `teamgrid_appointment_create` | schedule-write | write | unconditional | yes |
| `teamgrid_appointment_get` | schedule-write | read | read | — |
| `teamgrid_appointment_restore` | schedule-write | write | conditional | — |
| `teamgrid_appointment_update` | schedule-write | write | conditional | — |
| `teamgrid_appointments_list` | schedule-write | read | read | — |
| `teamgrid_audit_events_list` | admin-write | read | read | — |
| `teamgrid_automation_actions_list` | automation-write | read | read | — |
| `teamgrid_automation_definition_archive` | automation-write | write | conditional | — |
| `teamgrid_automation_definition_create` | automation-write | write | unconditional | yes |
| `teamgrid_automation_definition_get` | automation-write | read | read | — |
| `teamgrid_automation_definition_restore` | automation-write | write | conditional | — |
| `teamgrid_automation_definition_update` | automation-write | write | conditional | — |
| `teamgrid_automation_definition_versions_list` | automation-write | read | read | — |
| `teamgrid_automation_definitions_list` | automation-write | read | read | — |
| `teamgrid_automation_run_abort` | automation-write | write | conditional | — |
| `teamgrid_automation_run_get` | automation-write | read | read | — |
| `teamgrid_automation_runs_list` | automation-write | read | read | — |
| `teamgrid_availability_list` | schedule-write | read | read | — |
| `teamgrid_call_note_archive` | crm-write | write | unconditional | — |
| `teamgrid_call_note_create` | crm-write | write | unconditional | yes |
| `teamgrid_call_note_get` | crm-write | read | read | — |
| `teamgrid_call_note_restore` | crm-write | write | unconditional | — |
| `teamgrid_call_notes_list` | crm-write | read | read | — |
| `teamgrid_comment_archive` | content-write | write | conditional | — |
| `teamgrid_comment_create` | content-write | write | unconditional | yes |
| `teamgrid_comment_get` | content-write | read | read | — |
| `teamgrid_comment_restore` | content-write | write | conditional | — |
| `teamgrid_comments_list` | content-write | read | read | — |
| `teamgrid_contact_create` | crm-write | write | unconditional | yes |
| `teamgrid_contact_get` | crm-write | read | read | — |
| `teamgrid_contact_group_archive` | crm-write | write | unconditional | — |
| `teamgrid_contact_group_create` | crm-write | write | unconditional | yes |
| `teamgrid_contact_group_get` | crm-write | read | read | — |
| `teamgrid_contact_group_restore` | crm-write | write | unconditional | — |
| `teamgrid_contact_group_update` | crm-write | write | unconditional | — |
| `teamgrid_contact_groups_list` | crm-write | read | read | — |
| `teamgrid_contact_update` | crm-write | write | unconditional | — |
| `teamgrid_contacts_list` | crm-write | read | read | — |
| `teamgrid_custom_field_definition_archive` | catalog-write | write | unconditional | — |
| `teamgrid_custom_field_definition_create` | catalog-write | write | unconditional | yes |
| `teamgrid_custom_field_definition_get` | catalog-write | read | read | — |
| `teamgrid_custom_field_definition_restore` | catalog-write | write | unconditional | — |
| `teamgrid_custom_field_definition_update` | catalog-write | write | unconditional | — |
| `teamgrid_custom_field_definitions_list` | catalog-write | read | read | — |
| `teamgrid_custom_field_value_clear` | catalog-write | write | conditional | — |
| `teamgrid_custom_field_value_get` | catalog-write | read | read | — |
| `teamgrid_custom_field_value_set` | catalog-write | write | conditional | — |
| `teamgrid_custom_field_values_get` | catalog-write | read | read | — |
| `teamgrid_document_archive` | content-write | write | conditional | — |
| `teamgrid_document_create` | content-write | write | unconditional | yes |
| `teamgrid_document_get` | content-write | read | read | — |
| `teamgrid_document_restore` | content-write | write | conditional | — |
| `teamgrid_document_update` | content-write | write | conditional | — |
| `teamgrid_documents_list` | content-write | read | read | — |
| `teamgrid_event_catalog_get` | integrations-write | read | read | — |
| `teamgrid_export_create` | admin-write | write | unconditional | yes |
| `teamgrid_export_get` | admin-write | read | read | — |
| `teamgrid_file_archive` | content-write | write | conditional | — |
| `teamgrid_file_get` | content-write | read | read | — |
| `teamgrid_file_rename` | content-write | write | conditional | — |
| `teamgrid_file_restore` | content-write | write | conditional | — |
| `teamgrid_files_list` | content-write | read | read | — |
| `teamgrid_group_create` | admin-write | write | unconditional | yes |
| `teamgrid_group_delete` | admin-write | write | conditional | — |
| `teamgrid_group_get` | admin-write | read | read | — |
| `teamgrid_group_update` | admin-write | write | conditional | — |
| `teamgrid_groups_list` | admin-write | read | read | — |
| `teamgrid_integration_installations_list` | integrations-write | read | read | — |
| `teamgrid_invitation_cancel` | admin-write | write | conditional | — |
| `teamgrid_invitation_create` | admin-write | write | unconditional | yes |
| `teamgrid_invitation_get` | admin-write | read | read | — |
| `teamgrid_invitation_resend` | admin-write | write | conditional | yes |
| `teamgrid_invitations_list` | admin-write | read | read | — |
| `teamgrid_list_archive` | catalog-write | write | unconditional | — |
| `teamgrid_list_create` | catalog-write | write | unconditional | yes |
| `teamgrid_list_get` | catalog-write | read | read | — |
| `teamgrid_list_restore` | catalog-write | write | unconditional | — |
| `teamgrid_list_update` | catalog-write | write | unconditional | — |
| `teamgrid_lists_list` | catalog-write | read | read | — |
| `teamgrid_member_get` | admin-write | read | read | — |
| `teamgrid_member_remove` | admin-write | write | conditional | — |
| `teamgrid_member_role_update` | admin-write | write | conditional | — |
| `teamgrid_members_list` | admin-write | read | read | — |
| `teamgrid_planned_work_list` | schedule-write | read | read | — |
| `teamgrid_planned_work_operation_get` | schedule-write | read | read | — |
| `teamgrid_product_archive` | catalog-write | write | unconditional | — |
| `teamgrid_product_create` | catalog-write | write | unconditional | yes |
| `teamgrid_product_get` | catalog-write | read | read | — |
| `teamgrid_product_group_archive` | catalog-write | write | unconditional | — |
| `teamgrid_product_group_create` | catalog-write | write | unconditional | yes |
| `teamgrid_product_group_get` | catalog-write | read | read | — |
| `teamgrid_product_group_update` | catalog-write | write | unconditional | — |
| `teamgrid_product_groups_list` | catalog-write | read | read | — |
| `teamgrid_product_update` | catalog-write | write | unconditional | — |
| `teamgrid_products_list` | catalog-write | read | read | — |
| `teamgrid_project_archive` | projects-write | write | conditional | yes |
| `teamgrid_project_complete` | projects-write | write | conditional | yes |
| `teamgrid_project_create` | projects-write | write | unconditional | yes |
| `teamgrid_project_get` | projects-write | read | read | — |
| `teamgrid_project_lifecycle_operation_get` | projects-write | read | read | — |
| `teamgrid_project_reopen` | projects-write | write | conditional | yes |
| `teamgrid_project_restore` | projects-write | write | conditional | yes |
| `teamgrid_project_sharing_get` | projects-write | read | read | — |
| `teamgrid_project_sharing_replace` | projects-write | write | conditional | — |
| `teamgrid_project_statement_archive` | finance-write | write | unconditional | — |
| `teamgrid_project_statement_create` | finance-write | write | unconditional | yes |
| `teamgrid_project_statement_get` | finance-write | read | read | — |
| `teamgrid_project_statement_restore` | finance-write | write | unconditional | — |
| `teamgrid_project_statement_update` | finance-write | write | unconditional | — |
| `teamgrid_project_statements_list` | finance-write | read | read | — |
| `teamgrid_project_template_archive` | projects-write | write | conditional | — |
| `teamgrid_project_template_create` | projects-write | write | unconditional | yes |
| `teamgrid_project_template_get` | projects-write | read | read | — |
| `teamgrid_project_template_instantiate` | projects-write | write | conditional | yes |
| `teamgrid_project_template_instantiation_get` | projects-write | read | read | — |
| `teamgrid_project_template_restore` | projects-write | write | conditional | — |
| `teamgrid_project_template_update` | projects-write | write | conditional | — |
| `teamgrid_project_templates_list` | projects-write | read | read | — |
| `teamgrid_project_update` | projects-write | write | conditional | — |
| `teamgrid_projects_list` | projects-write | read | read | — |
| `teamgrid_role_create` | admin-write | write | unconditional | yes |
| `teamgrid_role_delete` | admin-write | write | conditional | — |
| `teamgrid_role_get` | admin-write | read | read | — |
| `teamgrid_role_update` | admin-write | write | conditional | — |
| `teamgrid_roles_list` | admin-write | read | read | — |
| `teamgrid_search` | context | read | read | — |
| `teamgrid_service_archive` | catalog-write | write | unconditional | — |
| `teamgrid_service_create` | catalog-write | write | unconditional | yes |
| `teamgrid_service_get` | catalog-write | read | read | — |
| `teamgrid_service_restore` | catalog-write | write | unconditional | — |
| `teamgrid_service_update` | catalog-write | write | unconditional | — |
| `teamgrid_services_list` | catalog-write | read | read | — |
| `teamgrid_tag_archive` | catalog-write | write | unconditional | — |
| `teamgrid_tag_create` | catalog-write | write | unconditional | yes |
| `teamgrid_tag_get` | catalog-write | read | read | — |
| `teamgrid_tag_restore` | catalog-write | write | unconditional | — |
| `teamgrid_tag_update` | catalog-write | write | unconditional | — |
| `teamgrid_tags_list` | catalog-write | read | read | — |
| `teamgrid_task_archive` | tasks-write | write | conditional | — |
| `teamgrid_task_complete` | tasks-write | write | conditional | — |
| `teamgrid_task_create` | tasks-write | write | unconditional | yes |
| `teamgrid_task_duplicate` | tasks-write | write | conditional | yes |
| `teamgrid_task_get` | tasks-write | read | read | — |
| `teamgrid_task_move` | tasks-write | write | conditional | — |
| `teamgrid_task_planned_work_get` | schedule-write | read | read | — |
| `teamgrid_task_planned_work_replace` | schedule-write | write | conditional | yes |
| `teamgrid_task_recurrence_apply_task_template` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_archive` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_create` | tasks-write | write | unconditional | yes |
| `teamgrid_task_recurrence_end` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_event_submit` | tasks-write | write | unconditional | — |
| `teamgrid_task_recurrence_get` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_occurrence_get` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_occurrence_override` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_occurrence_override_clear` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_occurrence_retry` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_occurrences_list` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_operation_cancel` | tasks-write | write | unconditional | — |
| `teamgrid_task_recurrence_operation_get` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_owner_transfer` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_pause` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_preview` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_preview_input` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_recheck` | tasks-write | write | unconditional | — |
| `teamgrid_task_recurrence_remove_from_tasks` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_restore` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_resume` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_update` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_version_get` | tasks-write | read | read | — |
| `teamgrid_task_recurrence_version_restore` | tasks-write | write | conditional | — |
| `teamgrid_task_recurrence_versions_list` | tasks-write | read | read | — |
| `teamgrid_task_recurrences_list` | tasks-write | read | read | — |
| `teamgrid_task_reopen` | tasks-write | write | conditional | — |
| `teamgrid_task_restore` | tasks-write | write | conditional | — |
| `teamgrid_task_subtasks_replace` | tasks-write | write | conditional | — |
| `teamgrid_task_timer_start` | time-write | write | unconditional | — |
| `teamgrid_task_timer_stop` | time-write | write | unconditional | — |
| `teamgrid_task_update` | tasks-write | write | conditional | — |
| `teamgrid_tasks_bulk_update` | tasks-write | write | per-item revision | — |
| `teamgrid_tasks_list` | tasks-write | read | read | — |
| `teamgrid_time_entries_list` | time-write | read | read | — |
| `teamgrid_time_entry_archive` | time-write | write | unconditional | — |
| `teamgrid_time_entry_billing_get` | finance-write | read | read | — |
| `teamgrid_time_entry_billing_update` | finance-write | write | conditional | — |
| `teamgrid_time_entry_create` | time-write | write | unconditional | yes |
| `teamgrid_time_entry_get` | time-write | read | read | — |
| `teamgrid_time_entry_restore` | time-write | write | unconditional | — |
| `teamgrid_time_entry_update` | time-write | write | unconditional | — |
| `teamgrid_users_list` | context | read | read | — |
| `teamgrid_webhook_deliveries_list` | integrations-write | read | read | — |
| `teamgrid_webhook_delivery_get` | integrations-write | read | read | — |
| `teamgrid_webhook_delivery_test` | integrations-write | write | unconditional | yes |
| `teamgrid_webhook_get` | integrations-write | read | read | — |
| `teamgrid_webhook_remove` | integrations-write | write | unconditional | — |
| `teamgrid_webhook_update` | integrations-write | write | conditional | — |
| `teamgrid_webhooks_list` | integrations-write | read | read | — |
| `teamgrid_workspace_get` | context | read | read | — |
| `teamgrid_workspace_settings_get` | admin-write | read | read | — |
| `teamgrid_workspace_settings_update` | admin-write | write | conditional | yes |

## Operations deliberately outside MCP

| API operation | Reason |
| --- | --- |
| `getApiVersion` | Transport discovery remains outside task tools. |
| `exchangeCliAuthorizationCode` | Interactive authorization belongs to the host connection flow. |
| `compensateCliAuthorizationStorage` | Credential storage recovery belongs to the CLI connection flow. |
| `getCurrentCredentialContext` | Credential diagnostics must not enter a model transcript. |
| `revokeCurrentCredential` | Use the explicit host or CLI disconnect action. |
| `getSystemCapabilities` | Used internally for capability negotiation. |
| `getWorkspaceEntitlements` | Entitlement discovery is not a business operation. |
| `listPersonalAccessTokens` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `createPersonalAccessToken` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `rotatePersonalAccessToken` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `revokePersonalAccessToken` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `listServiceAccounts` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `createServiceAccount` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `getServiceAccount` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `updateServiceAccount` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `revokeServiceAccount` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `createServiceAccountCredential` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `rotateServiceAccountCredential` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `revokeServiceAccountCredential` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `getServiceAccountResourceGrants` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `replaceServiceAccountResourceGrants` | Credential and principal administration remains in the human-controlled Developer settings flow. |
| `listChanges` | High-volume synchronization transport belongs to an integration worker. |
| `createFileDownloadIntent` | Signed transfer credentials must not enter a model transcript. |
| `createFileUploadIntent` | Upload credentials and bytes require a host-managed file transfer. |
| `finalizeFileUploadIntent` | Part of the host-managed upload transaction. |
| `cancelFileUploadIntent` | Part of the host-managed upload transaction. |
| `createWebhook` | Reveal-once signing secrets require human-controlled integration setup. |
| `rotateWebhookSecret` | Reveal-once signing secrets require human-controlled integration setup. |
| `createExportDownloadIntent` | Signed export credentials must not enter a model transcript. |
| `downloadExport` | Bulk export bytes require a host-managed download, not tool text. |
