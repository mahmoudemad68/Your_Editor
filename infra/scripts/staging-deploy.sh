#!/bin/sh
# Start or update staging from digest-pinned images.
# Never removes volumes. Never runs compose down -v.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

"$ROOT/infra/scripts/staging-preflight.sh" --compose

export SEAWEED_SECRET_DIR="${SEAWEED_SECRET_DIR:-$ROOT/seaweedfs-secrets}"
export SEAWEED_REQUIRE_S3_ENV=1
"$ROOT/infra/seaweedfs/prepare-secrets.sh"

docker compose -f compose.staging.yaml pull
docker compose -f compose.staging.yaml up -d --no-build
"$ROOT/infra/seaweedfs/apply-compose-isolation.sh" compose.staging.yaml
docker compose -f compose.staging.yaml up -d --no-build --wait --wait-timeout 300

echo "staging deploy finished without deleting volumes"
