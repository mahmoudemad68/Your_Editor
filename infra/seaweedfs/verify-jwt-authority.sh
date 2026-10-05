#!/bin/sh
# Compare JWT material actually mounted into each storage role.
# Key values and forged tokens are not printed.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$root/infra/seaweedfs/storage-network.env"
cd "$root"
export SEAWEED_VOLUME_IP

python3 - <<'PY'
import base64
import hashlib
import hmac
import json
import os
import subprocess
import time

def sections(container):
    text = subprocess.check_output(
        ["docker", "exec", container, "cat", "/etc/seaweedfs/security.toml"],
        text=True,
    )
    current = None
    found = {}
    names = []
    for line in text.splitlines():
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1].strip()
            names.append(current)
            continue
        if current and line.startswith('key = "'):
            found[current] = line.split('"', 2)[1]
    return names, found

def has(names, section):
    return section in names

def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")

def sign(key, payload):
    header = b64(b'{"alg":"HS256","typ":"JWT"}')
    body = b64(json.dumps(payload).encode())
    digest = hmac.new(key.encode(), header + b"." + body, hashlib.sha256).digest()
    return (header + b"." + body + b"." + b64(digest)).decode()

s3_names, s3_keys = sections("editagent-seaweed-s3")
volume_names, _volume_keys = sections("editagent-seaweed-volume")
master_names, _master_keys = sections("editagent-seaweed-master")
filer_names, filer_keys = sections("editagent-seaweed-filer")

if has(s3_names, "jwt.signing"):
    raise SystemExit("s3 mount contains the volume write key")
if not has(s3_names, "jwt.filer_signing") or not has(s3_names, "jwt.filer_signing.read"):
    raise SystemExit("s3 mount is missing the filer keys it uses")
if has(volume_names, "jwt.filer_signing") or has(volume_names, "jwt.filer_signing.read"):
    raise SystemExit("volume mount contains filer signing keys")
if has(master_names, "jwt.filer_signing") or has(master_names, "jwt.filer_signing.read"):
    raise SystemExit("master mount contains filer signing keys")
if "jwt.signing" not in filer_names or "jwt.signing.read" not in filer_names:
    raise SystemExit("filer mount is missing the volume keys it uses to issue tokens")

read_key = s3_keys.get("jwt.signing.read", "")
if not read_key:
    raise SystemExit("s3 mount is missing the volume read key SeaweedFS 4.48 requires")
token = sign(read_key, {"fid": "3,aaaaaaaa", "exp": int(time.time()) + 60})
volume_ip = os.environ["SEAWEED_VOLUME_IP"]
subprocess.run(
    ["docker", "exec", "-i", "editagent-seaweed-s3", "sh", "-c", "cat >/tmp/jwt-probe && chmod 600 /tmp/jwt-probe"],
    input=token.encode(),
    check=True,
)
code = subprocess.check_output(
    [
        "docker",
        "exec",
        "editagent-seaweed-s3",
        "sh",
        "-c",
        "curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X PUT "
        '-H "Authorization: Bearer $(cat /tmp/jwt-probe)" --data-binary x '
        f"http://{volume_ip}:8080/3,aaaaaaaa; rm -f /tmp/jwt-probe",
    ],
    text=True,
).strip()
print(f"s3_volume_write_key=absent")
print(f"s3_volume_read_key=present")
print(f"s3_filer_admin_key=present")
print(f"s3_read_key_volume_put={code}")
if code in {"200", "201", "204"}:
    raise SystemExit("s3 read key authorized a volume write")
PY

echo "jwt authority separation holds"
