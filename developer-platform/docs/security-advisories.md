# Dependency security decisions

## MCP stdio transport and GHSA-frvp-7c67-39w9

The stable TeamGrid MCP package uses `@modelcontextprotocol/sdk` `1.29.0`.
That SDK transitively installs `@hono/node-server` `1.x`, which npm reports
under [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9).
The affected code is Hono's Windows `serve-static` middleware.

The TeamGrid MCP executable is a local stdio-only process. Its production
source imports only:

- `@modelcontextprotocol/sdk/server/mcp.js`;
- `@modelcontextprotocol/sdk/server/stdio.js`.

It does not create an HTTP server, serve files, or import an HTTP/SSE/
Streamable HTTP transport. Consequently the vulnerable code is installed but
not reachable in the shipped product.

`npm run audit:production` fails closed if:

- any other production advisory appears;
- this advisory changes severity;
- a high or critical production finding appears;
- MCP production code imports any additional SDK transport or surface.

This narrow exception must be removed when the stable MCP SDK line accepts
`@hono/node-server` `2.0.5` or newer. It must not be broadened to cover an HTTP
transport.
