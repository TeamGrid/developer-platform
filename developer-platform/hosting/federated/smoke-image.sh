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
cleanup() {
  docker unpause "$mongo" >/dev/null 2>&1 || true
  docker rm -f "$service_a" "$service_b" "$provider" "$mongo" >/dev/null 2>&1 || true
  docker run --rm --user 0:0 --entrypoint node --volume "$fixture_dir:/fixture" "$image" \
    -e "const fs=require('node:fs'); for(const name of fs.readdirSync('/fixture'))fs.rmSync('/fixture/'+name,{recursive:true,force:true});fs.chmodSync('/fixture',0o777)" >/dev/null 2>&1 || true
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
cp "$script_dir/smoke-fixture.mjs" "$fixture_dir/smoke-fixture.mjs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=127.0.0.1' \
  -addext 'subjectAltName=IP:127.0.0.1' -keyout "$fixture_dir/key.pem" \
  -out "$fixture_dir/ca.pem" >/dev/null 2>&1
docker run --rm --user 0:0 --entrypoint node --volume "$fixture_dir:/fixture" "$image" \
  -e "const fs=require('node:fs');fs.chmodSync('/fixture',0o755);for(const name of fs.readdirSync('/fixture')){fs.chownSync('/fixture/'+name,1000,1000);fs.chmodSync('/fixture/'+name,0o600)}" >/dev/null
docker run --rm --user 0:0 --entrypoint node --volume "$fixture_dir:/fixture" "$image" \
  /fixture/smoke-fixture.mjs seed
docker run -d --name "$mongo" --user 0:0 --volume "$fixture_dir:/fixture:ro" \
  --entrypoint mongod mongo:8.3.8 --replSet rs0 --bind_ip_all \
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
for name in "$service_a" "$service_b"; do
  config=service-a
  if [[ "$name" == "$service_b" ]]; then config=service-b; fi
  docker run -d --name "$name" --network "container:$mongo" --read-only --cap-drop ALL \
    --security-opt no-new-privileges --volume "$fixture_dir:/fixture:ro" \
    --env NODE_EXTRA_CA_CERTS=/fixture/ca.pem \
    --env "TEAMGRID_FEDERATION_CONFIG_FILE=/fixture/$config.json" "$image" >/dev/null
done
for attempt in {1..30}; do
  if docker exec "$service_b" node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs check
docker pause "$mongo" >/dev/null
docker run --rm --network "container:$mongo" --volume "$fixture_dir:/fixture:ro" \
  --entrypoint node "$image" /fixture/smoke-fixture.mjs outage
docker stop --time 10 "$service_a" "$service_b" >/dev/null
for name in "$service_a" "$service_b"; do
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" == '0' ]]
done
