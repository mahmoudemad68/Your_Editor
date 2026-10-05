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

load_ca() {
  if [ -f "$dir/ca.crt" ] && [ -f "$dir/ca.key" ]; then
    read_file "$dir/ca.crt" >"$stage/ca.crt"
    read_file "$dir/ca.key" >"$stage/ca.key"
    chmod 600 "$stage/ca.key" "$stage/ca.crt"
    return
  fi
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$stage/ca.key" -out "$stage/ca.crt" \
    -subj "/CN=editagent-seaweed-ca" >/dev/null 2>&1
  chmod 600 "$stage/ca.key" "$stage/ca.crt"
}

issue_role() {
  role="$1"
  cn="$2"
  dns_name="$3"
  ip="$4"
  extra_san="$5"
  cat >"$stage/${role}.cnf" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:${dns_name},IP:${ip}${extra_san}
EOF
  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$stage/${role}.key" -out "$stage/${role}.csr" \
    -subj "/CN=${cn}" >/dev/null 2>&1
  openssl x509 -req -in "$stage/${role}.csr" -sha256 -days 825 \
    -CA "$stage/ca.crt" -CAkey "$stage/ca.key" -CAserial "$stage/ca.srl" -CAcreateserial \
    -out "$stage/${role}.crt" -extfile "$stage/${role}.cnf" >/dev/null 2>&1
  rm -f "$stage/${role}.csr" "$stage/${role}.cnf"
  chmod 600 "$stage/${role}.key" "$stage/${role}.crt"
}

role_ok() {
  role="$1"
  cn="$2"
  dns_name="$3"
  ip="$4"
  if [ ! -f "$dir/${role}.crt" ] || [ ! -f "$dir/${role}.key" ]; then
    return 1
  fi
  meta="$(read_file "$dir/${role}.crt" | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null || true)"
  case "$meta" in
    *"CN=${cn}"*|*"CN = ${cn}"*) ;;
    *) return 1 ;;
  esac
  case "$meta" in
    *"$dns_name"*) ;;
    *) return 1 ;;
  esac
  case "$meta" in
    *"$ip"*) ;;
    *) return 1 ;;
  esac
  return 0
}

load_ca
# Master also answers the in-container health check on 127.0.0.1.
if role_ok master editagent-master seaweed-master "$SEAWEED_MASTER_IP" && \
  read_file "$dir/master.crt" | openssl x509 -noout -ext subjectAltName 2>/dev/null | grep -q "127.0.0.1"; then
  read_file "$dir/master.crt" >"$stage/master.crt"
  read_file "$dir/master.key" >"$stage/master.key"
  chmod 600 "$stage/master.crt" "$stage/master.key"
else
  issue_role master editagent-master seaweed-master "$SEAWEED_MASTER_IP" ",IP:127.0.0.1"
fi
if role_ok volume editagent-volume seaweed-volume "$SEAWEED_VOLUME_IP"; then
  read_file "$dir/volume.crt" >"$stage/volume.crt"
  read_file "$dir/volume.key" >"$stage/volume.key"
  chmod 600 "$stage/volume.crt" "$stage/volume.key"
else
  issue_role volume editagent-volume seaweed-volume "$SEAWEED_VOLUME_IP" ""
fi
if role_ok filer editagent-filer seaweed-filer "$SEAWEED_FILER_IP"; then
  read_file "$dir/filer.crt" >"$stage/filer.crt"
  read_file "$dir/filer.key" >"$stage/filer.key"
  chmod 600 "$stage/filer.crt" "$stage/filer.key"
else
  issue_role filer editagent-filer seaweed-filer "$SEAWEED_FILER_IP" ""
fi
if role_ok s3 editagent-s3 seaweed-s3 "$SEAWEED_S3_IP"; then
  read_file "$dir/s3.crt" >"$stage/s3.crt"
  read_file "$dir/s3.key" >"$stage/s3.key"
  chmod 600 "$stage/s3.crt" "$stage/s3.key"
else
  issue_role s3 editagent-s3 seaweed-s3 "$SEAWEED_S3_IP" ""
fi

for candidate in security.toml security.master.toml security.volume.toml security.filer.toml security.s3.toml; do
  if [ -f "$dir/$candidate" ]; then
    read_file "$dir/$candidate" >"$stage/$candidate"
    chmod 600 "$stage/$candidate"
  fi
done

STAGE="$stage" DIR="$dir" S3_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID" S3_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY" python3 - <<'PY'
import json
import os
import secrets
from pathlib import Path

destination = Path(os.environ["DIR"])
stage = Path(os.environ["STAGE"])

def key():
    return secrets.token_urlsafe(32)

def parse_keys(text):
    current = None
    found = {}
    for line in text.splitlines():
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1].strip()
        elif current and line.startswith('key = "'):
            found[current] = line.split('"', 2)[1]
    return found

parsed = []
for name in (
    "security.filer.toml",
    "security.toml",
    "security.master.toml",
    "security.s3.toml",
    "security.volume.toml",
):
    path = stage / name
    if path.exists():
        parsed.append(parse_keys(path.read_text()))

def pick(section):
    for found in parsed:
        value = found.get(section)
        if value:
            return value
    return key()

signing = pick("jwt.signing")
signing_read = pick("jwt.signing.read")
filer_signing = pick("jwt.filer_signing")
filer_read = pick("jwt.filer_signing.read")

def jwt_block(section, value):
    return f'[{section}]\nkey = "{value}"\nexpires_after_seconds = 60\n'

access = "\n".join(
    [
        "[access]",
        "ui = false",
        "",
        "[filer.expose_directory_metadata]",
        "enabled = false",
        "",
    ]
)
volume_jwt = jwt_block("jwt.signing", signing) + "\n" + jwt_block("jwt.signing.read", signing_read)
filer_jwt = (
    jwt_block("jwt.filer_signing", filer_signing)
    + "\n"
    + jwt_block("jwt.filer_signing.read", filer_read)
)

def grpc_role(role, names):
    return "\n".join(
        [
            f"[grpc.{role}]",
            f'cert = "/etc/seaweedfs/{role}.crt"',
            f'key = "/etc/seaweedfs/{role}.key"',
            f'allowed_commonNames = "{names}"',
            "",
        ]
    )

common_grpc = '[grpc]\nca = "/etc/seaweedfs/ca.crt"\n\n'
https_master = "\n".join(
    [
        "[https.master]",
        'cert = "/etc/seaweedfs/master.crt"',
        'key = "/etc/seaweedfs/master.key"',
        'ca = "/etc/seaweedfs/ca.crt"',
        "",
    ]
)
s3_client = "\n".join(
    [
        "[grpc.client]",
        'cert = "/etc/seaweedfs/s3.crt"',
        'key = "/etc/seaweedfs/s3.key"',
        "",
    ]
)
(stage / "security.master.toml").write_text(
    volume_jwt + "\n" + access + common_grpc + grpc_role("master", "editagent-volume,editagent-filer,editagent-s3") + https_master
)
(stage / "security.volume.toml").write_text(
    volume_jwt + "\n" + common_grpc + grpc_role("volume", "editagent-master,editagent-filer")
)
(stage / "security.filer.toml").write_text(
    volume_jwt + "\n" + filer_jwt + "\n" + access + common_grpc + grpc_role("filer", "editagent-s3,editagent-filer")
)
# S3 issues filer tokens and volume read tokens. SeaweedFS 4.48 mints the
# volume read JWT inside the S3 process. The volume write key stays off this file.
(stage / "security.s3.toml").write_text(
    filer_jwt
    + "\n"
    + jwt_block("jwt.signing.read", signing_read)
    + "\n"
    + common_grpc
    + grpc_role("s3", "editagent-s3")
    + s3_client
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
    for role in master volume filer s3; do
      cp "/stage/security.${role}.toml" "/secrets/security.${role}.toml"
    done
    rm -f /secrets/security.toml
    cp /stage/s3.json /secrets/s3.json
    if [ -f /stage/ca.crt ]; then cp /stage/ca.crt /secrets/ca.crt; fi
    if [ -f /stage/ca.key ]; then cp /stage/ca.key /secrets/ca.key; fi
    if [ -f /stage/ca.srl ]; then cp /stage/ca.srl /secrets/ca.srl; fi
    for role in master volume filer s3; do
      cp "/stage/${role}.crt" "/secrets/${role}.crt"
      cp "/stage/${role}.key" "/secrets/${role}.key"
    done
    # The old shared identity could impersonate every role. Remove it.
    rm -f /secrets/seaweed.crt /secrets/seaweed.key
    chown seaweed:seaweed \
      /secrets/security.master.toml /secrets/security.volume.toml \
      /secrets/security.filer.toml /secrets/security.s3.toml \
      /secrets/s3.json \
      /secrets/ca.crt /secrets/ca.key \
      /secrets/master.crt /secrets/master.key \
      /secrets/volume.crt /secrets/volume.key \
      /secrets/filer.crt /secrets/filer.key \
      /secrets/s3.crt /secrets/s3.key
    if [ -f /secrets/ca.srl ]; then chown seaweed:seaweed /secrets/ca.srl; chmod 600 /secrets/ca.srl; fi
    chmod 600 /secrets/security.master.toml /secrets/security.volume.toml \
      /secrets/security.filer.toml /secrets/security.s3.toml \
      /secrets/s3.json \
      /secrets/ca.crt /secrets/ca.key \
      /secrets/master.crt /secrets/master.key \
      /secrets/volume.crt /secrets/volume.key \
      /secrets/filer.crt /secrets/filer.key \
      /secrets/s3.crt /secrets/s3.key
    chmod 700 /secrets'

uid="$(docker run --rm --entrypoint id "$image" seaweed | sed -n 's/.*uid=\([0-9][0-9]*\).*/\1/p')"
for file in "$dir/security.master.toml" "$dir/security.volume.toml" \
  "$dir/security.filer.toml" "$dir/security.s3.toml" "$dir/s3.json" \
  "$dir/ca.crt" "$dir/ca.key" \
  "$dir/master.crt" "$dir/master.key" "$dir/volume.crt" "$dir/volume.key" \
  "$dir/filer.crt" "$dir/filer.key" "$dir/s3.crt" "$dir/s3.key"; do
  mode="$(stat -c '%a' "$file")"
  owner="$(stat -c '%u' "$file")"
  if [ "$mode" != "600" ] || [ "$owner" != "$uid" ]; then
    echo "secret $file is not mode 600 owned by uid $uid" >&2
    exit 1
  fi
done
for file in s3.json ca.key master.key volume.key filer.key s3.key; do
  if docker run --rm --user 65534:65534 --entrypoint sh \
    -v "$dir/$file:/check:ro" "$image" -c 'test -r /check'; then
    echo "unrelated uid can read $file" >&2
    exit 1
  fi
done
echo "seaweedfs secrets ready uid=${uid} dir=${dir}"
