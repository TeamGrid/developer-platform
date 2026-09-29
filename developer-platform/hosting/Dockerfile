FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /opt/teamgrid/developer-platform
COPY developer-platform/package.json developer-platform/package-lock.json ./
COPY developer-platform/packages/api-client/package.json packages/api-client/package.json
COPY developer-platform/packages/cli/package.json packages/cli/package.json
COPY developer-platform/packages/mcp-server/package.json packages/mcp-server/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY openapi /opt/teamgrid/openapi
COPY developer-platform ./
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/TeamGrid/developer-platform"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
WORKDIR /opt/teamgrid/developer-platform
ENV NODE_ENV=production TEAMGRID_MCP_LISTEN_HOST=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/api-client/package.json ./packages/api-client/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/api-client/dist ./packages/api-client/dist
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/cli/package.json ./packages/cli/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/mcp-server/dist ./packages/mcp-server/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "packages/mcp-server/dist/httpBin.js"]
