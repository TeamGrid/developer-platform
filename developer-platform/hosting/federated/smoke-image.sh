#!/usr/bin/env bash
set -euo pipefail
image="${1:?Pass the built federated image.}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Colima shares the workspace, but macOS TMPDIR may be outside its mounted paths.
fixture_dir="$(mktemp -d "$script_dir/.federated-image.XXXXXX")"
nonce="$(basename "$fixture_dir" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
mongo="tg-global-mongo-$nonce"
provider="tg-global-provider-$nonce"
service_a="tg-global-a-$nonce"
service_b="tg-global-b-$nonce"
ingress="tg-global-ingress-$nonce"
cleanup() {
  result=$?
  if [[ "$result" != 0 ]]; then
    for name in "$mongo" "$provider" "$service_a" "$service_b" "$ingress"; do
      docker inspect --format '{{.Name}}: exit={{.State.ExitCode}} oom={{.State.OOMKilled}} status={{.State.Status}}' "$name" 2>/dev/null || true
    done
  fi
  docker unpause "$mongo" >/dev/null 2>&1 || true
  docker rm -f "$service_a" "$service_b" "$provider" "$ingress" "$mongo" >/dev/null 2>&1 || true
  docker run --rm --user 0:0 --entrypoint node --volume "$fixture_dir:/fixture" "$image" \
    -e "const fs=require('node:fs'); for(const name of fs.readdirSync('/fixture'))fs.rmSync('/fixture/'+name,{recursive:true,force:true});fs.chmodSync('/fixture',0o777)" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
cp "$script_dir/smoke-fixture.mjs" "$fixture_dir/smoke-fixture.mjs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:mcp.example.test' -keyout "$fixture_dir/key.pem" \
  -out "$fixture_dir/ca.pem" >/dev/null 2>&1
docker run --rm --user 0:0 --entrypoint node --volume "$fixture_dir:/fixture" "$image" \
  -e "const fs=require('node:fs');fs.chmodSync('/fixture',0o755);for(const name of fs.readdirSync('/fixture')){fs.chownSync('/fixture/'+name,1000,1000);fs.chmodSync('/fixture/'+name,0o600)}" >/dev/null
docker run --rm --user 0:0 --entrypoint node --volume "$fixture_dir:/fixture" \
  --volume "$script_dir/selfHosting.mjs:/opt/teamgrid/developer-platform/hosting/federated/selfHosting.mjs:ro" \
  --env "HOST_FIXTURE_DIR=$fixture_dir" "$image" /fixture/smoke-fixture.mjs seed
docker compose --file "$fixture_dir/compose.json" config --quiet
docker run -d --name "$mongo" --user 0:0 --memory 512m --volume "$fixture_dir:/fixture:ro" \
  --entrypoint mongod mongo:8.3.8 --replSet rs0 --bind_ip_all \
  --wiredTigerCacheSizeGB 0.25 \
  --keyFile /fixture/mongo-key --tlsMode requireTLS --tlsCertificateKeyFile /fixture/mongod.pem \
  --tlsCAFile /fixture/mongo-ca.pem --tlsAllowConnectionsWithoutCertificates >/dev/null
for attempt in {1..45}; do
  if docker exec "$mongo" mongosh --quiet --tls --tlsCAFile /fixture/mongo-ca.pem --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$mongo" mongosh --quiet --tls --tlsCAFile /fixture/mongo-ca.pem --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
for attempt in {1..45}; do
  if docker exec "$mongo" mongosh --quiet --tls --tlsCAFile /fixture/mongo-ca.pem --eval 'if(!db.hello().isWritablePrimary)quit(1)' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$mongo" mongosh --quiet --tls --tlsCAFile /fixture/mongo-ca.pem \
  --file /fixture/mongo-bootstrap.js >/dev/null
docker run -d --name "$provider" --network "container:$mongo" --read-only --cap-drop ALL \
    --security-opt no-new-privileges --volume "$fixture_dir:/fixture:ro" --entrypoint node "$image" \
  /fixture/smoke-fixture.mjs provider >/dev/null
provider_ready=false
for attempt in {1..30}; do
  if docker exec "$provider" node -e "require('node:https').get('https://127.0.0.1:9443/internal/developer/oauth/integrations/ai-global/metadata',{ca:require('node:fs').readFileSync('/fixture/ca.pem'),headers:{'X-TeamGrid-OAuth-Service-Authorization':'Bearer '+ 's'.repeat(48)}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
    provider_ready=true
    break
  fi
  sleep 1
done
if [[ "$provider_ready" != true ]]; then
  docker logs "$provider"
  exit 1
fi
for name in "$service_a" "$service_b"; do
  config=service-a
  if [[ "$name" == "$service_b" ]]; then config=service-b; fi
  docker run -d --name "$name" --network "container:$mongo" --read-only --cap-drop ALL \
    --memory 512m --cpus 0.75 --pids-limit 128 \
    --security-opt no-new-privileges --volume "$fixture_dir:/fixture:ro" \
    --env NODE_EXTRA_CA_CERTS=/fixture/ca.pem \
    --env "TEAMGRID_FEDERATION_CONFIG_FILE=/fixture/$config.json" "$image" >/dev/null
done
for name in "$service_a" "$service_b"; do
  port=8080
  if [[ "$name" == "$service_b" ]]; then port=8081; fi
  service_ready=false
  for attempt in {1..30}; do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      service_ready=true
      break
    fi
    sleep 1
  done
  if [[ "$service_ready" != true ]]; then
    docker logs "$service_a"
    docker logs "$service_b"
    exit 1
  fi
done
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs check
docker run -d --name "$ingress" --network "container:$mongo" --user 1000:1000 --read-only \
  --tmpfs /data:uid=1000,gid=1000 --tmpfs /config:uid=1000,gid=1000 \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
  --volume "$fixture_dir:/fixture:ro" \
  caddy:2.8-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17 \
  caddy run --config /fixture/Caddyfile --adapter caddyfile >/dev/null
for attempt in {1..20}; do
  if docker exec "$service_b" node -e "require('node:https').get('https://127.0.0.1:8443/unknown',{servername:'mcp.example.test',headers:{Host:'mcp.example.test'}},r=>process.exit(r.statusCode===404?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  sleep 1
done
if [[ "$(docker inspect --format '{{.State.Running}}' "$ingress")" != 'true' ]]; then
  docker logs "$ingress"
  exit 1
fi
docker logs "$ingress" > "$fixture_dir/ingress-startup.log" 2>&1
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture:ro" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs ingress
docker pause "$mongo" >/dev/null
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture:ro" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs outage
docker stop --time 10 "$service_a" "$service_b" >/dev/null
for name in "$service_a" "$service_b"; do
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" == '0' ]]
done
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture:ro" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs proxy-outage
docker logs "$ingress" > "$fixture_dir/ingress-audit.log" 2>&1
if grep -q 'tg_log_probe' "$fixture_dir/ingress-audit.log"; then
  exit 1
fi
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture:ro" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs audit
