#!/bin/sh
# Start or update staging from digest-pinned images.
# Never removes volumes. Never runs compose down -v.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export SEAWEED_SECRET_DIR="${SEAWEED_SECRET_DIR:-$ROOT/seaweedfs-secrets}"
export SEAWEED_REQUIRE_S3_ENV=1
export EDITAGENT_INSTALL_BOOT_UNIT=1
"$ROOT/infra/seaweedfs/secure-up.sh" compose.staging.yaml

echo "staging deploy finished without deleting volumes"
