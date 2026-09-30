#!/bin/sh
# Validate the committed Compose file, including the optional GPU profile.
# `docker compose config` does not start containers and does not need a GPU.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

docker compose config >/dev/null
docker compose --profile gpu config >/dev/null

echo "compose config ok"
