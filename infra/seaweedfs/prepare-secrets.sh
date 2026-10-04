#!/bin/sh
# Write SeaweedFS secret files for the image user.
# The directory is 0700. Secret files are 0600 and owned by uid/gid of `seaweed`.
# An existing security.toml keeps its JWT keys. TLS material is added when missing.
# s3.json is rewritten from the environment so the S3 identity matches the app.
# ca.key stays in this directory and is not mounted into the running services.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$root/infra/seaweedfs/storage-network.env"
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

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to mint the SeaweedFS storage certificates" >&2
  exit 1
fi

mkdir -p "$dir"
chmod 700 "$dir"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

read_file() {
  if [ -r "$1" ]; then
    cat "$1"
  else
    sudo cat "$1"
  fi
}

san_ready=0
if [ -f "$dir/ca.crt" ] && [ -f "$dir/ca.key" ] && [ -f "$dir/seaweed.crt" ] && [ -f "$dir/seaweed.key" ]; then
  san="$(read_file "$dir/seaweed.crt" | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)"
  san_ready=1
  for name in seaweed-master seaweed-volume seaweed-filer seaweed-s3 \
    "$SEAWEED_MASTER_IP" "$SEAWEED_VOLUME_IP" "$SEAWEED_FILER_IP" "$SEAWEED_S3_IP" 127.0.0.1; do
    case "$san" in
      *"$name"*) ;;
      *) san_ready=0 ;;
    esac
  done
fi

if [ "$san_ready" -ne 1 ]; then
  if [ -f "$dir/ca.crt" ] && [ -f "$dir/ca.key" ]; then
    read_file "$dir/ca.crt" >"$stage/ca.crt"
    read_file "$dir/ca.key" >"$stage/ca.key"
    chmod 600 "$stage/ca.key" "$stage/ca.crt"
  else
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "$stage/ca.key" -out "$stage/ca.crt" \
      -subj "/CN=editagent-seaweed-ca" >/dev/null 2>&1
  fi
  cat >"$stage/san.cnf" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:seaweed-master,DNS:seaweed-volume,DNS:seaweed-filer,DNS:seaweed-s3,DNS:localhost,IP:127.0.0.1,IP:${SEAWEED_MASTER_IP},IP:${SEAWEED_VOLUME_IP},IP:${SEAWEED_FILER_IP},IP:${SEAWEED_S3_IP}
EOF
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$stage/seaweed.key" -out "$stage/seaweed.csr" \
    -subj "/CN=editagent-seaweed" >/dev/null 2>&1
  openssl x509 -req -in "$stage/seaweed.csr" -sha256 -days 825 \
    -CA "$stage/ca.crt" -CAkey "$stage/ca.key" -CAserial "$stage/ca.srl" -CAcreateserial \
    -out "$stage/seaweed.crt" -extfile "$stage/san.cnf" >/dev/null 2>&1
  rm -f "$stage/seaweed.csr"
  chmod 600 "$stage/ca.key" "$stage/ca.crt" "$stage/seaweed.key" "$stage/seaweed.crt"
fi

if [ -f "$dir/security.toml" ]; then
  read_file "$dir/security.toml" >"$stage/existing.toml"
  chmod 600 "$stage/existing.toml"
fi

STAGE="$stage" DIR="$dir" S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" python3 - <<'PY'
import json
import os
import secrets
from pathlib import Path

destination = Path(os.environ["DIR"])
stage = Path(os.environ["STAGE"])

def key():
    return secrets.token_urlsafe(32)

managed = {
    "grpc",
    "grpc.master",
    "grpc.volume",
    "grpc.filer",
    "grpc.s3",
    "grpc.client",
    "https.master",
}

tls = "\n".join(
    [
        "[grpc]",
        'ca = "/etc/seaweedfs/ca.crt"',
        "",
        "[grpc.master]",
        'cert = "/etc/seaweedfs/seaweed.crt"',
        'key = "/etc/seaweedfs/seaweed.key"',
        'allowed_commonNames = "editagent-seaweed"',
        "",
        "[grpc.volume]",
        'cert = "/etc/seaweedfs/seaweed.crt"',
        'key = "/etc/seaweedfs/seaweed.key"',
        'allowed_commonNames = "editagent-seaweed"',
        "",
        "[grpc.filer]",
        'cert = "/etc/seaweedfs/seaweed.crt"',
        'key = "/etc/seaweedfs/seaweed.key"',
        'allowed_commonNames = "editagent-seaweed"',
        "",
        "[grpc.s3]",
        'cert = "/etc/seaweedfs/seaweed.crt"',
        'key = "/etc/seaweedfs/seaweed.key"',
        'allowed_commonNames = "editagent-seaweed"',
        "",
        "[grpc.client]",
        'cert = "/etc/seaweedfs/seaweed.crt"',
        'key = "/etc/seaweedfs/seaweed.key"',
        "",
        "[https.master]",
        'cert = "/etc/seaweedfs/seaweed.crt"',
        'key = "/etc/seaweedfs/seaweed.key"',
        'ca = "/etc/seaweedfs/ca.crt"',
        "",
    ]
)

existing = stage / "existing.toml"
if existing.exists():
    kept = []
    skipping = False
    for line in existing.read_text().splitlines():
        if line.startswith("[") and line.endswith("]"):
            skipping = line[1:-1].strip() in managed
        if not skipping:
            kept.append(line)
    body = "\n".join(kept).rstrip() + "\n\n" + tls
else:
    body = "\n".join(
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
            tls,
        ]
    )
(stage / "security.toml").write_text(body)
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
    cp /stage/security.toml /secrets/security.toml
    cp /stage/s3.json /secrets/s3.json
    if [ -f /stage/ca.crt ]; then cp /stage/ca.crt /secrets/ca.crt; fi
    if [ -f /stage/ca.key ]; then cp /stage/ca.key /secrets/ca.key; fi
    if [ -f /stage/seaweed.crt ]; then cp /stage/seaweed.crt /secrets/seaweed.crt; fi
    if [ -f /stage/seaweed.key ]; then cp /stage/seaweed.key /secrets/seaweed.key; fi
    if [ -f /stage/ca.srl ]; then cp /stage/ca.srl /secrets/ca.srl; fi
    chown seaweed:seaweed \
      /secrets/security.toml /secrets/s3.json \
      /secrets/ca.crt /secrets/ca.key /secrets/seaweed.crt /secrets/seaweed.key
    if [ -f /secrets/ca.srl ]; then chown seaweed:seaweed /secrets/ca.srl; chmod 600 /secrets/ca.srl; fi
    chmod 600 /secrets/security.toml /secrets/s3.json \
      /secrets/ca.crt /secrets/ca.key /secrets/seaweed.crt /secrets/seaweed.key
    chmod 700 /secrets'

uid="$(docker run --rm --entrypoint id "$image" seaweed | sed -n 's/.*uid=\([0-9][0-9]*\).*/\1/p')"
for file in "$dir/security.toml" "$dir/s3.json" "$dir/ca.crt" "$dir/ca.key" "$dir/seaweed.crt" "$dir/seaweed.key"; do
  mode="$(stat -c '%a' "$file")"
  owner="$(stat -c '%u' "$file")"
  if [ "$mode" != "600" ] || [ "$owner" != "$uid" ]; then
    echo "secret $file is not mode 600 owned by uid $uid" >&2
    exit 1
  fi
done
for file in s3.json ca.key seaweed.key; do
  if docker run --rm --user 65534:65534 --entrypoint sh \
    -v "$dir/$file:/check:ro" "$image" -c 'test -r /check'; then
    echo "unrelated uid can read $file" >&2
    exit 1
  fi
done
echo "seaweedfs secrets ready uid=${uid} dir=${dir}"
