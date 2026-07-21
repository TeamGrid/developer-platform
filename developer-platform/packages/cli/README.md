# @teamgrid/cli

Official `teamgrid` command-line client for TeamGrid API v1.

```sh
teamgrid auth login
teamgrid auth status --check
teamgrid tasks list --all --output json
teamgrid tasks create --data @task.json --idempotency-key task-1
teamgrid lists create --data @list.json --idempotency-key list-1
teamgrid services update service-id --data '{"billingRate":175}'
teamgrid tags archive tag-id --yes
teamgrid changes checkpoint --resource-type project,task --output json
teamgrid changes list --cursor "$CHECKPOINT" --resource-type project,task --output json
teamgrid custom-field-values set project project-id field-id \
  --data '{"value":"ACME-42"}' --if-match "$REVISION" --output json
teamgrid project-templates instantiate template-id \
  --data @project.json --if-match "$TEMPLATE_REVISION" \
  --idempotency-key rollout-1 --wait --output json
teamgrid planned-work replace task-id --data @schedule.json \
  --if-match "$REVISION" --idempotency-key schedule-1 --yes --wait --output json
```

Credentials are read from `TEAMGRID_API_TOKEN` or stored in macOS Keychain /
Linux Secret Service; they are never written to the profile JSON or passed to a
credential helper as a command argument. Use JSON/JSONL for automation and
`--yes` for destructive non-interactive operations.

The CLI mirrors every public API operation, including project lifecycle jobs,
products and product groups, finance-gated project statements, call notes,
contact groups, custom-field definitions, and credential-owned webhook delivery
history, custom-field values, project templates, and planned work. Use
`teamgrid <group> --help` for the contract-derived filters. The
original direct list form for lists, services, and tags remains available as a
compatibility alias.

`changes checkpoint` creates the empty latest checkpoint required before a full snapshot.
`changes list` performs exactly one request unless `--all` is explicitly supplied; `--all` remains
bounded by `--max-pages`. Repeat `--operation` and `--resource-type` or supply comma-separated
values. JSON output preserves the response envelope and cursor. JSONL emits one `kind: "change"`
record per event followed by an explicit `kind: "checkpoint"` record so scripts can durably advance
only after applying the preceding events. Every checkpoint also carries `caughtUp`; `--all` stops
only when the API marks the fixed watermark as reached.

`--resource-type` accepts all 23 canonical types: `absence`, `appointment`,
`automationDefinition`, `automationRun`, `callNote`, `comment`, `contact`, `contactGroup`,
`customFieldDefinition`, `document`, `file`, `integration`, `list`, `product`, `productGroup`,
`project`, `projectStatement`, `projectTemplate`, `service`, `tag`, `task`, `timeEntry`, and
`webhook`. Unknown values are rejected before any network request.

Custom-field `set`/`clear` and planned-work `replace` require a revision from the latest GET.
Task, project, and project-template updates and state changes also require `--if-match`. Read the
latest resource as JSON, use its `attributes.developerRevision`, and do not reuse revisions across
resource types. A stale revision returns exit code `6` with instructions to fetch and retry; the CLI
does not silently overwrite or automatically replay the change. Task and project-template archive
commands print the new strong `etag`, which can be passed directly to a later restore command.
Planned-work replacement is a full schedule replacement, so non-interactive use additionally
requires `--yes`; always provide a stable idempotency key. Template instantiation and planned-work
replacement can be polled to a terminal state with `--wait`, bounded by `--max-wait`.
