#!/bin/sh
# Start or update staging from digest-pinned images.
# Never removes volumes. Never runs compose down -v.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export SEAWEED_SECRET_DIR="${SEAWEED_SECRET_DIR:-$ROOT/seaweedfs-secrets}"
export SEAWEED_REQUIRE_S3_ENV=1
export EDITAGENT_INSTALL_BOOT_UNIT=1
unset EDITAGENT_FIREWALL_BIN_DIR
"$ROOT/infra/seaweedfs/secure-up.sh" compose.staging.yaml

# The S3 gateway is on the application network. The host firewall drops the
# internal subnet, so the bucket is created from a container that can reach s3.
export S3_HOST="${S3_HOST:-s3}"
export S3_PORT="${S3_PORT:-8333}"
docker compose -f compose.staging.yaml run --rm --no-deps \
  -v "$ROOT/infra/scripts/ensure_bucket.py:/ensure_bucket.py:ro" \
  -e S3_ACCESS_KEY_ID \
  -e S3_SECRET_ACCESS_KEY \
  -e S3_BUCKET \
  -e S3_REGION \
  -e S3_HOST \
  -e S3_PORT \
  --entrypoint python \
  ai-worker /ensure_bucket.py

echo "staging deploy finished without deleting volumes"
