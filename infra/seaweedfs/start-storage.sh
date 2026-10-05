#!/bin/sh
# Start SeaweedFS only after the host firewall rules are present.
# Containers use restart: "no", so a Docker restart does not publish them
# before this script runs. --from-boot skips the systemd install step so the
# boot unit does not recurse through systemctl.
set -eu

from_boot=0
for arg in "$@"; do
  case "$arg" in
    --from-boot) from_boot=1 ;;
    *)
      echo "usage: $0 [--from-boot]" >&2
      exit 2
      ;;
  esac
done

script_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
if [ "$script_dir" = /usr/local/lib/editagent ]; then
  root="$(cat /usr/local/lib/editagent/repo-root)"
else
  root="$(CDPATH= cd -- "$script_dir/../.." && pwd)"
fi
cd "$root"
lock_dir="${TMPDIR:-/tmp}"
mkdir -p "$lock_dir"
exec 9>"$lock_dir/editagent-storage.lock"
flock -w 180 9

./infra/seaweedfs/prepare-secrets.sh
./infra/seaweedfs/ensure-storage-network.sh
docker compose build seaweed-master

# Stop first so a running volume cannot serve /status while rules change.
docker compose stop seaweed-s3 seaweed-filer seaweed-volume seaweed-master >/dev/null 2>&1 || true
docker compose create --force-recreate \
  seaweed-master seaweed-volume seaweed-filer seaweed-s3 >/dev/null

./infra/seaweedfs/apply-host-isolation.sh
./infra/seaweedfs/apply-host-isolation.sh --check

# `docker start` returns while the entrypoint is waiting. `compose start`
# waits for health and would deadlock on that wait.
docker start \
  "$(docker compose ps -aq seaweed-master)" \
  "$(docker compose ps -aq seaweed-volume)" \
  "$(docker compose ps -aq seaweed-filer)" \
  "$(docker compose ps -aq seaweed-s3)"
./infra/seaweedfs/apply-container-firewall.sh
docker compose up -d --wait --wait-timeout 180 \
  seaweed-master seaweed-volume seaweed-filer seaweed-s3

if [ "$from_boot" -eq 1 ]; then
  exit 0
fi

set +e
./infra/seaweedfs/apply-host-isolation.sh --install
install_status=$?
set -e
if [ "$install_status" -ne 0 ] && [ "$install_status" -ne 3 ]; then
  exit "$install_status"
fi
# A unit file is not a reboot. This host was not rebooted.
echo "REBOOT_PERSISTENCE=UNVERIFIED"
