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
teamgrid custom-field-values set project project-id field-id \
  --data '{"value":"ACME-42"}' --if-match "$REVISION" --output json
teamgrid project-templates instantiate template-id \
  --data @project.json --idempotency-key rollout-1 --wait --output json
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

The change feed is deliberately deferred beyond the `1.0.0-rc.1` public contract. This release
does not install `teamgrid changes` commands or request a `changes:read` scope. Use signed webhooks
for event-driven integration and bounded list commands for reconciliation.

Custom-field `set`/`clear`, planned-work `replace`, and every mutating task, project, or
project-template command require the revision from the latest GET through `--if-match`. A stale
revision returns exit code `6` and must be refreshed before retrying. Planned-work replacement is a full schedule replacement, so
non-interactive use additionally requires `--yes`; always provide a stable idempotency key.
Project lifecycle operations, template instantiation, and planned-work replacement can be polled to
a terminal state with `--wait`, bounded by `--max-wait`.
