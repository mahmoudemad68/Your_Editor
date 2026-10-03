#!/bin/sh
# Start or update staging from digest-pinned images.
# Never removes volumes. Never runs compose down -v.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

"$ROOT/infra/scripts/staging-preflight.sh" --compose

docker compose -f compose.staging.yaml pull
docker compose -f compose.staging.yaml up -d --no-build --wait --wait-timeout 300

echo "staging deploy finished without deleting volumes"
