#!/bin/sh
# Bring up the frozen product's real Compose services. Images are built from the product checkout.
set -eu
APP=$1
cd "$APP"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-qa93}"
export EDITAGENT_RUNTIME=development
export AUTH_COOKIE_SECURE=false
export AUTH_TRUSTED_ORIGINS=http://127.0.0.1:3000
export EDITAGENT_ASR_MODEL=small
export S3_PORT="${S3_PORT:-9000}"

build() {
  docker compose build api web media-worker ai-worker render-executor render-worker postgres redis
}
build || build

rv="$(docker run --rm --network none --entrypoint node editagent-render-worker:local -p "require('./dist/bundle/catalog.json').renderVersion")"
printf '%s\n' "$rv" | grep -Eq '^[a-f0-9]{64}$'
export EDITAGENT_RENDER_VERSION="$rv"
printf '%s\n' "$rv" > "${QA_OUT:-/tmp}/render-version.txt"

docker compose up -d --wait --wait-timeout 180 postgres redis
sh infra/seaweedfs/start-storage.sh --from-boot
QA_APP_ROOT="$APP" node "${QA_HARNESS:?}/bucket.mjs"
docker compose up -d --no-build --wait --wait-timeout 300 api web media-worker ai-worker render-executor render-worker
docker compose ps --format '{{.Service}} {{.State}} {{.Health}}'
