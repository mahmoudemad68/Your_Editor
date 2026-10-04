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

./infra/seaweedfs/prepare-secrets.sh
./infra/seaweedfs/ensure-storage-network.sh

# Stop first so a running volume cannot serve /status while rules change.
docker compose stop seaweed-s3 seaweed-filer seaweed-volume seaweed-master >/dev/null 2>&1 || true
docker compose create seaweed-master seaweed-volume seaweed-filer seaweed-s3 >/dev/null

./infra/seaweedfs/apply-host-isolation.sh
./infra/seaweedfs/apply-host-isolation.sh --check

docker compose up -d --wait --wait-timeout 180 \
  seaweed-master seaweed-volume seaweed-filer seaweed-s3

if [ "$from_boot" -eq 1 ]; then
  exit 0
fi

set +e
./infra/seaweedfs/apply-host-isolation.sh --install
install_status=$?
set -e
if [ "$install_status" -eq 3 ]; then
  echo "REBOOT_PERSISTENCE=open"
  exit 0
fi
if [ "$install_status" -ne 0 ]; then
  exit "$install_status"
fi
echo "REBOOT_PERSISTENCE=hook-installed"
