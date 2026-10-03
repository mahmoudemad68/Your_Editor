#!/bin/sh
# Push scanned images only after the security gate passes.
# The gate runs first, so a failed scan never reaches docker push.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
"$root/infra/scripts/supply-chain-security-gate.sh"

image_dir=${IMAGE_DIR:?IMAGE_DIR is required}
registry=${IMAGE_REGISTRY:?IMAGE_REGISTRY is required}
sha=${IMAGE_SHA:?IMAGE_SHA is required}

for service in $("$root/infra/scripts/supply-chain-services.sh"); do
  archive="$image_dir/$service.tar.gz"
  if [ ! -f "$archive" ]; then
    echo "scanned image archive missing: $service" >&2
    exit 1
  fi
  docker load -i "$archive"
  local_image="editagent-${service}:${sha}"
  remote_name="${registry}/editagent-${service}"
  remote_image="${remote_name}:${sha}"
  docker tag "$local_image" "$remote_image"
  docker push "$remote_image"
  digest=$(docker buildx imagetools inspect "$remote_image" --format '{{.Manifest.Digest}}')
  printf '%s@%s\n' "$remote_name" "$digest" > "$image_dir/digest-$service.txt"
done

echo "published scanned images for $sha"
