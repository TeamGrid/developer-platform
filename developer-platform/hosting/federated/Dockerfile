FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS patched-runtime
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

FROM patched-runtime AS build
WORKDIR /opt/teamgrid/developer-platform
COPY developer-platform/package.json developer-platform/package-lock.json ./
COPY developer-platform/packages/api-client/package.json packages/api-client/package.json
COPY developer-platform/packages/cli/package.json packages/cli/package.json
COPY developer-platform/packages/mcp-server/package.json packages/mcp-server/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY openapi /opt/teamgrid/openapi
COPY developer-platform ./
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
RUN npm ci --prefix hosting/federated --ignore-scripts --no-audit --no-fund

FROM patched-runtime
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/TeamGrid/developer-platform"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL app.teamgrid.runtime="federated-mcp-v1"
WORKDIR /opt/teamgrid/developer-platform
ENV NODE_ENV=production
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/api-client/package.json ./packages/api-client/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/api-client/dist ./packages/api-client/dist
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/cli/package.json ./packages/cli/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/cli/dist ./packages/cli/dist
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/mcp-server/package.json ./packages/mcp-server/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/hosting/federated/package.json ./hosting/federated/package.json
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/hosting/federated/node_modules ./hosting/federated/node_modules
COPY --from=build --chown=node:node /opt/teamgrid/developer-platform/hosting/federated/main.mjs /opt/teamgrid/developer-platform/hosting/federated/config.mjs /opt/teamgrid/developer-platform/hosting/federated/service.mjs /opt/teamgrid/developer-platform/hosting/federated/io.mjs /opt/teamgrid/developer-platform/hosting/federated/admission.mjs /opt/teamgrid/developer-platform/hosting/federated/selfHosting.mjs ./hosting/federated/
USER node
EXPOSE 8080
ENTRYPOINT ["node", "hosting/federated/main.mjs"]
