#!/usr/bin/env bash
set -euo pipefail

image=${1:?Supply a locally available application image}
suffix="lms-smoke-$$-$RANDOM"
network="$suffix"
db="$suffix-db"
app="$suffix-app"
secret="$(openssl rand -hex 32)"
fixture_password="$(openssl rand -hex 20)"
credentials=(
  --env "DATABASE_URL=postgres://lms:local-smoke-only@$db:5432/lms"
  --env "SESSION_PEPPER=$secret"
  --env "APP_ORIGIN=http://localhost:3000"
)

cleanup() {
  if [[ $? -ne 0 ]]; then
    docker logs "$app" 2>/dev/null || true
    docker logs "$db" 2>/dev/null || true
  fi
  docker rm -f -v "$app" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker run --detach --network "$network" --name "$db" \
  --env POSTGRES_USER=lms --env POSTGRES_DB=lms --env POSTGRES_PASSWORD=local-smoke-only \
  postgres:18-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$db" pg_isready -h 127.0.0.1 -U lms -d lms >/dev/null 2>&1; then
    break
  fi
  if [[ $attempt == 30 ]]; then
    exit 1
  fi
  sleep 1
done
docker run --rm --network "$network" "${credentials[@]}" "$image" node dist/api/cli.js migrate
docker run --rm --network "$network" "${credentials[@]}" "$image" node dist/api/cli.js migrate
docker run --rm --network "$network" "${credentials[@]}" \
  --env BOOTSTRAP_ADMIN_EMAIL=smoke@example.test --env "BOOTSTRAP_ADMIN_PASSWORD=$fixture_password" \
  "$image" node dist/api/cli.js bootstrap-admin
docker run --detach --network "$network" --name "$app" "${credentials[@]}" "$image" >/dev/null
for attempt in {1..30}; do
  if docker exec "$app" node -e "fetch('http://localhost:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  if [[ $attempt == 30 ]]; then
    exit 1
  fi
  sleep 1
done

docker exec --env "SMOKE_PASSWORD=$fixture_password" "$app" node --input-type=module -e '
  import assert from "node:assert/strict";
  const origin = "http://localhost:3000";
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Mini LMS/);
  const asset = html.match(/src="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(origin + asset)).status, 200);
  const login = await fetch(origin + "/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: "smoke@example.test", password: process.env.SMOKE_PASSWORD }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("Set-Cookie"), /HttpOnly/);
  assert.equal((await login.json()).data.mustChangePassword, true);
'
docker stop --time 30 "$app" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$app")" = "0"
printf 'Container smoke test passed.\n'
