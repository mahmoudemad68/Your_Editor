#!/bin/sh
# Start storage containers that are waiting for a firewall acknowledgement.
# docker compose start waits for health and deadlocks on that wait.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$root"

docker start \
  "$(docker compose ps -aq seaweed-master)" \
  "$(docker compose ps -aq seaweed-volume)" \
  "$(docker compose ps -aq seaweed-filer)" \
  "$(docker compose ps -aq seaweed-s3)"
./infra/seaweedfs/apply-container-firewall.sh
docker compose up -d --wait --wait-timeout 180 \
  seaweed-master seaweed-volume seaweed-filer seaweed-s3
echo "storage rearmed"
