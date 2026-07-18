# @teamgrid/cli

Official `teamgrid` command-line client for TeamGrid API v1.

```sh
teamgrid auth login
teamgrid auth status --check
teamgrid tasks list --all --output json
teamgrid tasks create --data @task.json --idempotency-key task-1
```

Credentials are read from `TEAMGRID_API_TOKEN` or stored in macOS Keychain /
Linux Secret Service; they are never written to the profile JSON or passed to a
credential helper as a command argument. Use JSON/JSONL for automation and
`--yes` for destructive non-interactive operations.
