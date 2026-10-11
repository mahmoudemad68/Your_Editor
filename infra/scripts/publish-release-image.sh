#!/bin/sh
# Push the exact scanned tar-loaded image. Never rebuild at publication time.
set -eu
service=${1:?service required}
sha=${GITHUB_SHA:?SHA required}
repository=${GITHUB_REPOSITORY:?repository required}
owner=$(printf '%s' "${repository%/*}" | tr '[:upper:]' '[:lower:]')
repo=$(printf '%s' "${repository#*/}" | tr '[:upper:]' '[:lower:]')
case "$service" in api|web|media-worker|render-worker|render-executor|agent-worker|ai-worker|seaweedfs|postgres|redis) ;; *) exit 2 ;; esac
printf '%s' "$sha" | python3 -c 'import re,sys; assert re.fullmatch("[0-9a-f]{40}", sys.stdin.read())'
local_image="editagent-$service:$sha"
image="ghcr.io/$owner/$repo-$service"
tag="$image:sha-$sha"
image_id=$(docker image inspect --format '{{.Id}}' "$local_image")
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$local_image")
test "$revision" = "$sha"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict) and str(d.get("spdxVersion", "")).startswith("SPDX-"), "Invalid scanned SBOM"' "sbom-$service.spdx.json"
# Existing SHA tags cannot be reassigned to different image bytes.
if docker manifest inspect "$tag" > remote-manifest.json 2> manifest-error.txt; then
  python3 -c 'import json,sys; assert json.load(open("remote-manifest.json"))["config"]["digest"] == sys.argv[1], "SHA tag already identifies different image bytes"' "$image_id"
else
  if ! grep -Eqi 'no such manifest|manifest unknown|not found' manifest-error.txt; then
    echo 'Registry identity check unavailable; refusing publication' >&2
    exit 1
  fi
fi
docker tag "$local_image" "$tag"
docker push "$tag"
digest=$(docker image inspect --format '{{json .RepoDigests}}' "$tag" | python3 -c 'import json,sys; image=sys.argv[1]; matches=[x.split("@",1)[1] for x in json.load(sys.stdin) if x.startswith(image+"@")]; assert len(matches)==1; print(matches[0])' "$image")
docker tag "$local_image" "$image:main"
docker push "$image:main"
mkdir -p release
cp "sbom-$service.spdx.json" release/
python3 infra/scripts/release_manifest.py record --service "$service" --sha "$sha" --image "$image" --digest "$digest" --image-id "$image_id" --directory release
rm -f remote-manifest.json manifest-error.txt
