# Freeze the regional application; replace only audited runtime dependencies and Node/OS.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS dependencies
WORKDIR /opt/teamgrid/developer-platform
COPY developer-platform/hosting/legacy-dependency-security/manifests/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm audit --omit=dev --audit-level=low

FROM ghcr.io/teamgrid/teamgrid-mcp@sha256:ac21142267ccd1a3cae587fd681aa0ce3dbde0bb95dd38a5a5a5f69e2d869818
USER root
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
    && rm -rf /opt/teamgrid/developer-platform/node_modules
COPY --from=dependencies /usr/local/ /usr/local/
COPY --from=dependencies --chown=node:node /opt/teamgrid/developer-platform/node_modules /opt/teamgrid/developer-platform/node_modules
COPY --from=dependencies --chown=node:node /opt/teamgrid/developer-platform/packages/mcp-server/package.json /opt/teamgrid/developer-platform/packages/mcp-server/package.json
ARG SECURITY_BUILD_REVISION
LABEL org.opencontainers.image.revision="a40140bc74e3056b698b0a50cf886d690d9dbb9f"
LABEL com.teamgrid.dependency-security-build-revision="${SECURITY_BUILD_REVISION}"
LABEL com.teamgrid.dependency-security-base-image="ghcr.io/teamgrid/teamgrid-mcp@sha256:ac21142267ccd1a3cae587fd681aa0ce3dbde0bb95dd38a5a5a5f69e2d869818"
RUN test "$(node --version)" = v24.22.1
USER node
