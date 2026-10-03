#!/bin/sh
# Reject a staging deploy that would pull a mutable image or delete data.
# This script does not start containers and does not print secret values.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

node --input-type=module <<'EOF'
import { assertDigestPinned, STAGING_IMAGE_ENV } from "./infra/scripts/image-digest.mjs";

for (const name of STAGING_IMAGE_ENV) {
  assertDigestPinned(name, process.env[name]);
}
EOF

if [ "${1:-}" = "--compose" ]; then
  docker compose -f compose.staging.yaml config >/dev/null
fi

echo "staging preflight ok"
