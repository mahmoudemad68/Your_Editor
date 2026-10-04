#!/bin/sh
# Read the running Compose networks and install host isolation.
# Run after `docker compose up -d` and again after a host reboot.
# Usage: apply-compose-isolation.sh <compose-file> [compose-args...]
#        apply-compose-isolation.sh remove <compose-file> [compose-args...]
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
action=apply
if [ "${1:-}" = "remove" ]; then
  action=remove
  shift
fi
file=${1:?compose file}
shift

compose() {
  docker compose -f "$file" "$@"
}

internal=$(compose "$@" config --format json | python3 -c '
import json, sys
doc = json.load(sys.stdin)
for name, network in doc.get("networks", {}).items():
    if name == "storage_internal" or network.get("name", "").endswith("storage-internal"):
        print(network.get("name") or name)
        raise SystemExit
sys.exit("storage_internal network is not defined")
')

enabled=$(docker network inspect "$internal" --format '{{.EnableIPv6}}')
if [ "$enabled" = "true" ]; then
  echo "unsupported network: IPv6 is enabled on $internal" >&2
  exit 1
fi

subnet=$(docker network inspect "$internal" --format '{{(index .IPAM.Config 0).Subnet}}')
id=$(docker network inspect "$internal" --format '{{.Id}}')
bridge=br-$(printf '%s' "$id" | cut -c 1-12)
s3_id=$(compose "$@" ps -q s3)
if [ -z "$s3_id" ]; then
  echo "s3 service is not running; start it before installing isolation" >&2
  exit 1
fi
s3_ip=$(docker inspect "$s3_id" --format '{{range $name, $net := .NetworkSettings.Networks}}{{if ne $name "'"$internal"'"}}{{$net.IPAddress}}{{end}}{{end}}')
if [ -z "$s3_ip" ]; then
  echo "s3 has no application-network address" >&2
  exit 1
fi
app_net=$(docker inspect "$s3_id" --format '{{range $name, $net := .NetworkSettings.Networks}}{{if ne $name "'"$internal"'"}}{{$name}}{{end}}{{end}}')
app_id=$(docker network inspect "$app_net" --format '{{.Id}}')
app_bridge=br-$(printf '%s' "$app_id" | cut -c 1-12)

"$ROOT/infra/seaweedfs/install-host-isolation.sh" "$action" "$subnet" "$bridge" "$s3_ip" "$app_bridge"
if [ "$action" = "apply" ]; then
  "$ROOT/infra/seaweedfs/install-host-isolation.sh" verify "$subnet" "$bridge" "$s3_ip" "$app_bridge"
fi
