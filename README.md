# TeamGrid Developer Platform

Official TypeScript SDK, command-line interface, and optional read-only MCP
adapter for TeamGrid API v1.

The packages live in [`developer-platform/`](developer-platform/):

- [`@teamgrid/api-client`](developer-platform/packages/api-client)
- [`@teamgrid/cli`](developer-platform/packages/cli)
- [`@teamgrid/mcp-server`](developer-platform/packages/mcp-server)

The checked API contract is available at [`openapi/v1.json`](openapi/v1.json).
See the [workspace documentation](developer-platform/README.md) for usage,
credential handling, regional routing, and development instructions.

## Install

The current release is an alpha and is published under the `next` dist-tag:

```sh
npm install @teamgrid/api-client@next
npm install --global @teamgrid/cli@next
npm install --global @teamgrid/mcp-server@next
```

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Do not open a public issue for a suspected vulnerability.

## License

MIT © TeamGrid
