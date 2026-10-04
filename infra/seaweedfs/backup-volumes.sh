#!/bin/sh
# Stopped copy of the SeaweedFS master, volume, and filer volumes.
# This does not delete volumes and it does not touch the historical MinIO volume.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$root"
image="$(sed -n 's/^FROM //p' "$root/infra/seaweedfs/Dockerfile")"
destination="${1:?backup directory is required}"
project="${COMPOSE_PROJECT_NAME:-editagent}"
mkdir -p "$destination"
chmod 700 "$destination"

docker compose stop seaweed-master seaweed-volume seaweed-filer seaweed-s3
for volume in seaweed-master seaweed-volume seaweed-filer; do
  name="${project}_${volume}"
  docker run --rm --entrypoint tar -v "${name}:/data:ro" -v "$destination:/backup" \
    "$image" \
    -C /data -cf "/backup/${volume}.tar" .
  test -s "$destination/${volume}.tar"
done
docker compose start seaweed-master seaweed-volume seaweed-filer seaweed-s3
echo "seaweedfs backup written to $destination"
