#!/usr/bin/env bash
set -Eeuo pipefail
image="${1:?Pass the exact built MCP image reference}"
container="teamgrid-mcp-smoke-${RANDOM}-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$container" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=128 --memory=256m \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m -p 127.0.0.1::8080 \
  -e TEAMGRID_MCP_RESOURCE=https://mcp.example.test/mcp \
  -e TEAMGRID_OAUTH_ISSUER=https://auth.example.test/ \
  -e TEAMGRID_MCP_SERVICE_SECRET=synthetic-smoke-secret-never-use-in-a-real-cell \
  -e TEAMGRID_API_BASE_URL=https://api.de.example.test/v1 \
  -e TEAMGRID_API_ORIGIN_SECRET=synthetic-origin-smoke \
  -e TEAMGRID_REGION=de -e TEAMGRID_CELL_ID=de-test \
  -e TEAMGRID_MCP_ENABLED=false -e TEAMGRID_MCP_WRITES_ENABLED=false \
  "$image" >/dev/null
endpoint="$(docker port "$container" 8080/tcp | head -n 1)"
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "http://${endpoint}/healthz" >/dev/null; then break; fi
  sleep 1
done
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  "http://${endpoint}/healthz")" == 200 ]]
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  -H 'Host: mcp.example.test' "http://${endpoint}/readyz")" == 503 ]]
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  -X POST -H 'Host: mcp.example.test' -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://${endpoint}/mcp")" == 503 ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$container")" == node ]]
echo 'Hosted MCP image smoke passed: non-root, read-only, alive, disabled readiness, closed MCP gate.'
