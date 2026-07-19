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
```

Credentials are read from `TEAMGRID_API_TOKEN` or stored in macOS Keychain /
Linux Secret Service; they are never written to the profile JSON or passed to a
credential helper as a command argument. Use JSON/JSONL for automation and
`--yes` for destructive non-interactive operations.

The CLI mirrors every public API operation, including project lifecycle jobs,
products and product groups, finance-gated project statements, call notes,
contact groups, custom-field definitions, and credential-owned webhook delivery
history. Use `teamgrid <group> --help` for the contract-derived filters. The
original direct list form for lists, services, and tags remains available as a
compatibility alias.
