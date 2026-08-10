# @teamgrid/cli

Official `teamgrid` command-line client for TeamGrid API v1.

```sh
teamgrid auth login
teamgrid auth status --check
teamgrid auth logout --revoke
teamgrid doctor
teamgrid --output json doctor
teamgrid tasks list --all --output json
teamgrid tasks create --data @task.json --idempotency-key task-1
teamgrid lists create --data @list.json --idempotency-key list-1
teamgrid services update service-id --data '{"billingRate":175}'
teamgrid tags archive tag-id --yes
teamgrid webhooks test webhook-id --idempotency-key webhook-test-1 --output json
teamgrid custom-field-values set project project-id field-id \
  --data '{"value":"ACME-42"}' --if-match "$REVISION" --output json
teamgrid custom-field-values get-many project project-id \
  --field-id field-id another-field-id --output json
teamgrid project-templates instantiate template-id \
  --data @project.json --idempotency-key rollout-1 --wait --output json
teamgrid planned-work replace task-id --data @schedule.json \
  --if-match "$REVISION" --idempotency-key schedule-1 --yes --wait --output json
teamgrid changes checkpoint --resource-type task --output json
teamgrid changes list --cursor "$CHECKPOINT" --resource-type task --all --output jsonl
teamgrid time-entries billing get time-entry-id --output json
teamgrid time-entries billing update time-entry-id --billed --if-match "$REVISION"
```

Browser login is the default. The CLI opens the system browser, uses PKCE S256
with an exact IPv4 loopback callback, asks the user to select one workspace and
approve the displayed scopes, then stores the resulting credential in the
operating-system credential store. Use `--preset daily-work` for the bounded
write preset or repeat `--scope` for an exact custom scope set.

Sensitive scopes are intentionally unavailable through browser login until
TeamGrid can carry a reviewed recent-authentication signal across regions.
Create a narrowly scoped personal credential in Developer settings and import
it with `--manual` when one is required.

`--no-browser` prints the approval URL while still waiting on the local
callback. Treat that short-lived URL as private and never paste it into logs or
another person's browser. `--manual` prompts for an existing reveal-once
credential; `--token-stdin` is the non-echoing compatibility path.

An existing profile is never overwritten implicitly. Select another
`--profile`, or pass `--replace` after deciding how to revoke the previous
credential. Plain `teamgrid auth logout` removes only the local profile and
credential-store entry. `teamgrid auth logout --revoke` revokes the exact
selected credential first and removes local state only after TeamGrid confirms
the revocation. It refuses an ambiguous `TEAMGRID_API_TOKEN` override so it
cannot revoke a credential different from the selected saved profile.

Credentials are read from `TEAMGRID_API_TOKEN` or stored in macOS Keychain,
Linux Secret Service, or Windows Credential Manager. They are never written to
profile JSON or passed to a credential helper as a command argument. Use
JSON/JSONL for automation and `--yes` for destructive non-interactive
operations.

`teamgrid doctor` is a read-only diagnostic. It validates local configuration,
the selected credential and routing metadata, the resolved API base URL,
network reachability, CLI/API version compatibility, and authenticated API
capability discovery. Human output is the default; use `--output json` for a
stable report in support or automation workflows. Reports contain no credential,
authorization header, raw API error detail, or credential-store content.

Doctor returns `0` when every required check passes, `2` for invalid local
configuration or routing, `3` for a missing/invalid/expired credential, `4` for
an authorization failure, `7` for rate limiting, and `1` for network, server,
protocol, or compatibility failures. An expiring-soon credential is a warning
and does not fail an otherwise healthy diagnosis.

`TEAMGRID_API_TOKEN` completely overrides the selected local profile for that
process, including its saved region, cell, and base URL. The CLI derives routing
from the environment credential unless `--base-url` is supplied explicitly.

Node.js 22.14 through 24 is supported on Linux, macOS, and Windows. Persistent
profiles use each operating system's native credential store. CI/CD and
unattended services should continue to use a scoped service-account credential
from a secret manager through `TEAMGRID_API_TOKEN`; they must not start an
interactive browser login.

The CLI mirrors every public API operation, including project lifecycle jobs,
products and product groups, finance-gated project statements, call notes,
contact groups, custom-field definitions, and credential-owned webhook delivery
history, custom-field values, project templates, and planned work. Use
`teamgrid <group> --help` for the contract-derived filters. The
original direct list form for lists, services, and tags remains available as a
compatibility alias.

The stable `changes` commands expose metadata-only, cell-local reconciliation. Create a checkpoint
immediately before taking a full resource snapshot, persist the returned opaque cursor verbatim,
then use `changes list`. `--all` remains bounded by `--max-pages`; JSONL emits an explicit
checkpoint record after each page. A `410` response requires a new checkpoint and full snapshot.

Custom-field `set`/`clear`, planned-work `replace`, and every mutating task, project, or
project-template command require the revision from the latest GET through `--if-match`. A stale
revision returns exit code `6` and must be refreshed before retrying. Planned-work replacement is a full schedule replacement, so
non-interactive use additionally requires `--yes`; always provide a stable idempotency key.
Project lifecycle operations, template instantiation, and planned-work replacement can be polled to
a terminal state with `--wait`, bounded by `--max-wait`.
Billing updates likewise require an explicit revision and exactly one of
`--billed` or `--unbilled`; the separate billing scope is never implied by
ordinary time-entry write access.
