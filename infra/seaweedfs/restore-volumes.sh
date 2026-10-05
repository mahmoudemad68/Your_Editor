#!/bin/sh
# Replace each SeaweedFS data directory from a stopped backup.
# A restore merges nothing: the directory is cleared, then the archive is extracted.
# The historical MinIO volume is not mounted and not deleted.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$root"
image="$(sed -n 's/^FROM //p' "$root/infra/seaweedfs/Dockerfile")"
source_dir="${1:?backup directory is required}"
project="${COMPOSE_PROJECT_NAME:-editagent}"

docker compose stop seaweed-master seaweed-volume seaweed-filer seaweed-s3
for volume in seaweed-master seaweed-volume seaweed-filer; do
  archive="$source_dir/${volume}.tar"
  test -s "$archive"
  name="${project}_${volume}"
  docker run --rm --entrypoint sh -v "${name}:/data" -v "$archive:/backup.tar:ro" \
    "$image" \
    -c 'set -eu; find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -C /data -xf /backup.tar'
done
./infra/seaweedfs/rearm-storage.sh
echo "seaweedfs volumes restored from $source_dir"
