# TeamGrid Developer Platform

Official TypeScript SDK, command-line interface, and optional MCP
adapter for TeamGrid API v1.

The packages live in [`developer-platform/`](developer-platform/):

- [`@teamgrid/api-client`](developer-platform/packages/api-client)
- [`@teamgrid/cli`](developer-platform/packages/cli)
- [`@teamgrid/mcp-server`](developer-platform/packages/mcp-server)

The checked API contracts are available at [`openapi/v0.json`](openapi/v0.json) and
[`openapi/v1.json`](openapi/v1.json). The same directory also mirrors the capability ledger,
canonical 90-scope policy, complete 87-route v0 migration map, the 238-operation action-policy
registry identity, and SHA-256 contract manifest used by CI.
See the [workspace documentation](developer-platform/README.md) for usage,
credential handling, regional routing, and development instructions.

## Install

Version 1.2.2 is the stable release for the default `latest` dist-tag. It includes
browser login, explicit MCP write profiles and the regional hosted MCP service.
Hosted access is available across Production workspaces, subject to the user's
membership, permissions and approved OAuth scopes.

```sh
npm install @teamgrid/api-client@1.2.2
npm install --global @teamgrid/cli@1.2.2
npm install --global @teamgrid/mcp-server@1.2.2
```

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not open a public issue for a suspected vulnerability.

## License

MIT © TeamGrid
