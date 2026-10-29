#!/bin/sh
# Image names are selectors, never authorization. Every path inspects bytes.
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$root"
case "${1:-}" in
built)
  image="$(docker image inspect editagent-seaweedfs:local --format '{{.Id}}')"
  ;;
live)
  image=
  for role in seaweed-master seaweed-volume seaweed-filer seaweed-s3; do
    container="$(docker compose ps -aq "$role")"
    test -n "$container"
    actual="$(docker inspect --format '{{.Image}}' "$container")"
    if [ -n "$image" ] && [ "$image" != "$actual" ]; then
      echo 'storage roles do not share an immutable image' >&2; exit 1
    fi
    image="$actual"
  done
  ;;
*) echo 'usage: image-reference.sh built|live' >&2; exit 2 ;;
esac
case "$image" in sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1 ;; esac
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  : "${SEAWEED_QUALIFIED_RECEIPT:?CI requires qualified producer evidence}"
  node tools/test/load-qualified-storage.mjs verify-local "$SEAWEED_QUALIFIED_RECEIPT" "$image" >&2
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  sh infra/seaweedfs/verify-image.sh "$image" "$work" >&2
fi
printf '%s\n' "$image"
