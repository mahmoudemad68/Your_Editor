#!/bin/sh
# Create SeaweedFS secret files for the non-root image user.
# The directory is 0700. The files are 0600 and owned by the uid from `id seaweed`.
# Existing security.toml is kept so a redeploy does not rotate JWT keys.
# s3.json is rewritten from the environment so the S3 keys match the application.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
IMAGE="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
dir=${SEAWEED_SECRET_DIR:-"$ROOT/.local/seaweedfs"}

if [ "${SEAWEED_REQUIRE_S3_ENV:-}" = "1" ]; then
  : "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
  : "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
else
  : "${S3_ACCESS_KEY_ID:=editagent}"
  : "${S3_SECRET_ACCESS_KEY:=editagent-dev-secret}"
fi

mkdir -p "$dir"
chmod 700 "$dir"

identity=$(docker run --rm --entrypoint id "$IMAGE" seaweed)
uid=$(printf '%s\n' "$identity" | sed -n 's/.*uid=\([0-9][0-9]*\).*/\1/p')
gid=$(printf '%s\n' "$identity" | sed -n 's/.*gid=\([0-9][0-9]*\).*/\1/p')
if [ -z "$uid" ] || [ -z "$gid" ] || [ "$uid" = "0" ] || [ "$gid" = "0" ]; then
  echo "cannot determine the non-root SeaweedFS uid/gid" >&2
  exit 1
fi

DIR="$dir" S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" python3 - <<'PY'
import json
import os
import secrets
from pathlib import Path

directory = Path(os.environ["DIR"])
security = directory / "security.toml"
if not security.exists():
    def key():
        return secrets.token_urlsafe(32)
    security.write_text(
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
identity = {
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
(directory / "s3.json").write_text(json.dumps(identity))
PY

own() {
  if [ "$(id -u)" -eq 0 ]; then
    chown "$uid:$gid" "$@"
    chmod 600 "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo chown "$uid:$gid" "$@"
    sudo chmod 600 "$@"
  else
    echo "cannot chown SeaweedFS secrets to ${uid}:${gid}; root or sudo is required" >&2
    exit 1
  fi
}

own "$dir/security.toml" "$dir/s3.json"

for file in "$dir/security.toml" "$dir/s3.json"; do
  mode=$(stat -c '%a' "$file")
  owner=$(stat -c '%u' "$file")
  group=$(stat -c '%g' "$file")
  if [ "$mode" != "600" ] || [ "$owner" != "$uid" ] || [ "$group" != "$gid" ]; then
    echo "secret $file is not mode 600 owned by ${uid}:${gid}" >&2
    exit 1
  fi
  if ! docker run --rm --user "${uid}:${gid}" --entrypoint sh \
    -v "$file:/check:ro" "$IMAGE" -c 'test -r /check'; then
    echo "runtime user ${uid}:${gid} cannot read $file" >&2
    exit 1
  fi
  if docker run --rm --user 65534:65534 --entrypoint sh \
    -v "$file:/check:ro" "$IMAGE" -c 'test -r /check'; then
    echo "unrelated uid can read $file" >&2
    exit 1
  fi
done

echo "seaweedfs secrets ready uid=${uid} gid=${gid} dir=${dir}"
