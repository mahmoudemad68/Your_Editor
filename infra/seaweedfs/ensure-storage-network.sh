#!/bin/sh
# Recreate an empty storage network whose subnet does not match the pinned range.
# Attached containers and named volumes are left alone.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$root/infra/seaweedfs/storage-network.env"
project="${COMPOSE_PROJECT_NAME:-editagent}"
name="${project}_storage_internal"

if ! docker network inspect "$name" >/dev/null 2>&1; then
  exit 0
fi

subnet="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$name")"
if [ "$subnet" = "$SEAWEED_SUBNET" ]; then
  exit 0
fi

count="$(docker network inspect -f '{{len .Containers}}' "$name")"
if [ "$count" != "0" ]; then
  echo "storage network $name uses $subnet and still has containers. Stop them before switching to $SEAWEED_SUBNET." >&2
  exit 1
fi

docker network rm "$name" >/dev/null
echo "removed empty storage network $name ($subnet)"
