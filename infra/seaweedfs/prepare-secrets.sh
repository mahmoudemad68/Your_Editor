#!/bin/sh
# Write SeaweedFS secret files for the image user.
# The directory is 0700. The files are 0600 and owned by uid/gid of `seaweed`.
# An existing security.toml is kept so a restart does not rotate JWT keys.
# s3.json is rewritten from the environment so the S3 identity matches the app.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
dockerfile="$root/infra/seaweedfs/Dockerfile"
image="$(sed -n 's/^FROM //p' "$dockerfile")"
dir="${SEAWEED_SECRET_DIR:-$root/.local/seaweedfs}"

if [ "${SEAWEED_REQUIRE_S3_ENV:-}" = "1" ]; then
  : "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
  : "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
  if [ "$S3_SECRET_ACCESS_KEY" = "editagent-dev-secret" ]; then
    echo "staging refuses the development S3 secret" >&2
    exit 1
  fi
else
  if [ -z "${S3_ACCESS_KEY_ID:-}" ]; then
    S3_ACCESS_KEY_ID="${MINIO_ROOT_USER:-editagent}"
  fi
  if [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then
    S3_SECRET_ACCESS_KEY="${MINIO_ROOT_PASSWORD:-editagent-dev-secret}"
  fi
fi

mkdir -p "$dir"
chmod 700 "$dir"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

STAGE="$stage" DIR="$dir" S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" python3 - <<'PY'
import json
import os
import secrets
from pathlib import Path

destination = Path(os.environ["DIR"])
stage = Path(os.environ["STAGE"])

def key():
    return secrets.token_urlsafe(32)

if not (destination / "security.toml").exists():
    (stage / "security.toml").write_text(
        "\n".join(
            [
                "[jwt.signing]",
                f'key = "{key()}"',
                "expires_after_seconds = 60",
                "",
                "[jwt.signing.read]",
                f'key = "{key()}"',
                "expires_after_seconds = 60",
                "",
                "[jwt.filer_signing]",
                f'key = "{key()}"',
                "expires_after_seconds = 60",
                "",
                "[jwt.filer_signing.read]",
                f'key = "{key()}"',
                "expires_after_seconds = 60",
                "",
                "[access]",
                "ui = false",
                "",
                "[filer.expose_directory_metadata]",
                "enabled = false",
                "",
            ]
        )
    )
(stage / "s3.json").write_text(
    json.dumps(
        {
            "identities": [
                {
                    "name": "editagent",
                    "credentials": [
                        {
                            "accessKey": os.environ["S3_ACCESS_KEY_ID"],
                            "secretKey": os.environ["S3_SECRET_ACCESS_KEY"],
                        }
                    ],
                    "actions": ["Admin", "Read", "Write", "List", "Tagging"],
                }
            ]
        }
    )
)
PY

docker run --rm --user root --entrypoint sh \
  -v "$dir:/secrets" \
  -v "$stage:/stage:ro" \
  "$image" \
  -c 'set -eu
    if [ -f /stage/security.toml ]; then cp /stage/security.toml /secrets/security.toml; fi
    cp /stage/s3.json /secrets/s3.json
    chown seaweed:seaweed /secrets/security.toml /secrets/s3.json
    chmod 600 /secrets/security.toml /secrets/s3.json
    chmod 700 /secrets'

uid="$(docker run --rm --entrypoint id "$image" seaweed | sed -n 's/.*uid=\([0-9][0-9]*\).*/\1/p')"
for file in "$dir/security.toml" "$dir/s3.json"; do
  mode="$(stat -c '%a' "$file")"
  owner="$(stat -c '%u' "$file")"
  if [ "$mode" != "600" ] || [ "$owner" != "$uid" ]; then
    echo "secret $file is not mode 600 owned by uid $uid" >&2
    exit 1
  fi
done
if docker run --rm --user 65534:65534 --entrypoint sh \
  -v "$dir/s3.json:/check:ro" "$image" -c 'test -r /check'; then
  echo "unrelated uid can read s3.json" >&2
  exit 1
fi
echo "seaweedfs secrets ready uid=${uid} dir=${dir}"
