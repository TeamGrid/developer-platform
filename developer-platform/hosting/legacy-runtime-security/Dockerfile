# Preserve the exact deployed regional gateway application and dependency bytes.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS patched-node
FROM ghcr.io/teamgrid/teamgrid-mcp@sha256:ac21142267ccd1a3cae587fd681aa0ce3dbde0bb95dd38a5a5a5f69e2d869818
USER root
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
COPY --from=patched-node /usr/local/ /usr/local/
ARG SECURITY_BUILD_REVISION
LABEL org.opencontainers.image.revision="a40140bc74e3056b698b0a50cf886d690d9dbb9f"
LABEL com.teamgrid.runtime-security-build-revision="${SECURITY_BUILD_REVISION}"
LABEL com.teamgrid.runtime-security-base-image="ghcr.io/teamgrid/teamgrid-mcp@sha256:ac21142267ccd1a3cae587fd681aa0ce3dbde0bb95dd38a5a5a5f69e2d869818"
LABEL com.teamgrid.runtime-security-node="24.22.1"
RUN test "$(node --version)" = v24.22.1
USER node
