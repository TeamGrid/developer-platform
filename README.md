# TeamGrid Developer Platform

Official TypeScript SDK, command-line interface, and optional read-only MCP
adapter for TeamGrid API v1.

The packages live in [`developer-platform/`](developer-platform/):

- [`@teamgrid/api-client`](developer-platform/packages/api-client)
- [`@teamgrid/cli`](developer-platform/packages/cli)
- [`@teamgrid/mcp-server`](developer-platform/packages/mcp-server)

The checked API contracts are available at [`openapi/v0.json`](openapi/v0.json) and
[`openapi/v1.json`](openapi/v1.json). The same directory also mirrors the capability ledger,
canonical 87-scope policy, complete 87-route v0 migration map, the 211-operation action-policy
registry identity, and SHA-256 contract manifest used by CI.
See the [workspace documentation](developer-platform/README.md) for usage,
credential handling, regional routing, and development instructions.

## Install

The stable 1.0.6 release is prepared for the default `latest` dist-tag:

```sh
npm install @teamgrid/api-client@1.0.6
npm install --global @teamgrid/cli@1.0.6
npm install --global @teamgrid/mcp-server@1.0.6
```

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not open a public issue for a suspected vulnerability.

## License

MIT © TeamGrid
