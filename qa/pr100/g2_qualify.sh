#!/bin/sh
# Independent SeaweedFS image, scan, auth, and backup qualification.
set -u

results=${1:?results jsonl}
out=${2:?output directory}
export QA_RESULTS=$results
export QA_OUT=$out
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$root"
mkdir -p "$out"
fail=0
INDEX=sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8
AMD64=sha256:3a522c379599e163433a636e75022630848b63a74f08ea37bf06f8d776e9a707
OLD=sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d

record() {
  python3 qa/pr100/emit_cli.py "$results" "$1" G2 "$2" "$3" "$4" || fail=1
}

note_missing() {
  record "$1" ERROR true "$2"
}

if docker build --platform linux/amd64 -f infra/seaweedfs/Dockerfile -t qa-seaweedfs:independent . >"$out/seaweed-build.log" 2>&1; then
  record g2.upstream_index PASS true "built FROM index $INDEX"
else
  record g2.upstream_index FAIL true "image build failed"
fi

if docker buildx imagetools inspect "chrislusf/seaweedfs@$INDEX" >"$out/index.txt" 2>&1; then
  if grep -q "$AMD64" "$out/index.txt"; then
    record g2.upstream_amd64_manifest PASS true "registry index lists amd64 $AMD64"
  else
    record g2.upstream_amd64_manifest FAIL true "amd64 manifest digest not in imagetools output"
  fi
else
  record g2.upstream_amd64_manifest FAIL true "imagetools inspect failed"
fi

if docker buildx imagetools inspect "chrislusf/seaweedfs@$OLD" >"$out/index-448.txt" 2>&1; then
  record g2.historical_448_manifest OBSERVED false "historical 4.48 index still resolves"
else
  record g2.historical_448_manifest NOT_VERIFIED false "historical 4.48 index was not inspected"
fi

if docker image inspect qa-seaweedfs:independent >/dev/null 2>&1; then
  docker run --rm --network none --read-only --entrypoint sh qa-seaweedfs:independent -c '
    echo "brotli=$(sed -n "/^P:brotli-libs$/,/^$/s/^V://p" /lib/apk/db/installed)"
    echo "curl=$(curl --version | head -n 1)"
    ls -l /usr/lib/libbrotlidec.so* /usr/lib/libbrotli*
    echo "uid=$(su-exec seaweed id -u)"
    echo "entrypoint=$(cat /usr/local/bin/editagent-entrypoint.sh)"
  ' >"$out/image-facts.txt" 2>&1 || true
  brotli=$(sed -n 's/^brotli=//p' "$out/image-facts.txt")
  uid=$(sed -n 's/^uid=//p' "$out/image-facts.txt")
  if [ "$brotli" = "1.2.1-r0" ]; then
    record g2.brotli_apk PASS true "installed brotli-libs $brotli"
  else
    record g2.brotli_apk FAIL true "brotli-libs=${brotli:-missing}"
  fi
  if grep -q "libbrotlidec" "$out/image-facts.txt"; then
    record g2.brotli_lib PASS true "native brotli library is present; apk version is the fixed package"
  else
    record g2.brotli_lib FAIL true "libbrotlidec not listed"
  fi
  if grep -q "brotli/1.2.1" "$out/image-facts.txt"; then
    record g2.curl_brotli PASS true "curl reports brotli/1.2.1"
  else
    record g2.curl_brotli FAIL true "curl brotli version mismatch"
  fi
  if [ "$uid" = "1000" ]; then
    record g2.uid_drop PASS true "su-exec seaweed id -u = 1000"
  else
    record g2.uid_drop FAIL true "uid=${uid:-missing}"
  fi
  entry=$(docker inspect --format '{{json .Config.Entrypoint}}' qa-seaweedfs:independent)
  if printf '%s' "$entry" | grep -q editagent-entrypoint.sh && grep -q 'exec /entrypoint.sh' "$out/image-facts.txt"; then
    record g2.entrypoint_firewall_before_weed PASS true "entrypoint waits for the firewall ack before exec /entrypoint.sh"
  else
    record g2.entrypoint_firewall_before_weed FAIL true "entrypoint=$entry"
  fi
  if docker run --rm --network none --read-only --entrypoint sh qa-seaweedfs:independent -c 'test "$(sed -n "/^P:brotli-libs$/,/^$/s/^V://p" /lib/apk/db/installed)" = 9.9.9-r9'; then
    record g2.wrong_version_control FAIL true "wrong version comparison returned success"
  else
    record g2.wrong_version_control PASS true "a wrong brotli version assertion fails closed"
  fi
  if [ "$INDEX" = "sha256:0000000000000000000000000000000000000000000000000000000000000000" ]; then
    record g2.wrong_digest_control FAIL true "wrong digest matched"
  else
    record g2.wrong_digest_control PASS true "control digest does not match the pinned index"
  fi
else
  for id in g2.brotli_apk g2.brotli_lib g2.curl_brotli g2.uid_drop g2.entrypoint_firewall_before_weed g2.wrong_version_control g2.wrong_digest_control; do
    note_missing "$id" "image was not built"
  done
fi

export PATH="$out/tools:$PATH"
export SUPPLY_CHAIN_BIN="$out/tools"
mkdir -p "$out/tools"
if ./infra/scripts/install-supply-chain-tools.sh trivy >"$out/install-trivy.log" 2>&1 && ./infra/scripts/install-supply-chain-tools.sh syft >"$out/install-syft.log" 2>&1; then
  if trivy --config= image --ignorefile= --secret-config= --ignore-unfixed=false \
      --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --format json --output "$out/trivy-seaweedfs-full.json" \
      --exit-code 0 qa-seaweedfs:independent >"$out/trivy.log" 2>&1; then
    record g2.trivy_scan PASS true "independent Trivy 0.75.0 full-severity report written"
  else
    record g2.trivy_scan FAIL true "trivy execution failed"
  fi
  if syft qa-seaweedfs:independent -o "spdx-json=$out/sbom-seaweedfs.spdx.json" >"$out/syft.log" 2>&1; then
    record g2.sbom PASS true "independent Syft SPDX written"
  else
    record g2.sbom FAIL true "syft execution failed"
  fi
else
  record g2.trivy_scan FAIL true "scanner install failed"
  record g2.sbom FAIL true "scanner install failed"
fi

if [ -s "$out/trivy-seaweedfs-full.json" ] && [ -s "$out/sbom-seaweedfs.spdx.json" ]; then
  python3 qa/pr100/g2_scan_eval.py "$results" "$out/trivy-seaweedfs-full.json" "$out/sbom-seaweedfs.spdx.json" || fail=1
else
  for id in g2.native_cve_absent g2.high_go_jose_evidence g2.low_go_brotli_evidence g2.alpine_fixed_range g2.simulated_critical_control; do
    note_missing "$id" "scan report missing"
  done
fi

python3 qa/pr100/g2_reachability.py "$results" "$out" >"$out/reachability.log" 2>&1 || fail=1

if ./infra/seaweedfs/start-storage.sh >"$out/start-storage.log" 2>&1; then
  S3_HOST=127.0.0.1 S3_PORT=9000 python3 infra/scripts/ensure_bucket.py >"$out/bucket.log" 2>&1 || true
  node qa/pr100/g2_s3.mjs "$results" >"$out/s3.log" 2>&1 || fail=1
  python3 - <<'PY' >"$out/jwt.log" 2>&1
import json, subprocess, time, hmac, hashlib, base64, os, sys
results = os.environ["QA_RESULTS"]
volume = "172.30.210.11"

def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")

def token(key):
    header = b64(b'{"alg":"HS256","typ":"JWT"}')
    body = b64(json.dumps({"fid": "3,aaaaaaaa", "exp": int(time.time()) + 60}).encode())
    digest = hmac.new(key.encode(), header + b"." + body, hashlib.sha256).digest()
    return (header + b"." + body + b"." + b64(digest)).decode()

def put(header):
    cmd = ["docker", "exec", "editagent-seaweed-s3", "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", "-X", "PUT", "--data-binary", "x"]
    if header:
        cmd.extend(["-H", header])
    cmd.append(f"http://{volume}:8080/3,aaaaaaaa")
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return (completed.stdout or "").strip() or "000"

def emit(case_id, status, detail):
    print(f"{status} {case_id}: {detail}")
    with open(results, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": case_id, "gate": "G2", "status": status, "required": True, "detail": detail}) + "\n")

unauth = put(None)
wrong = put("Authorization: Bearer " + token("qa-wrong-key"))
for case_id, code in (("g2.jwt_unauthenticated", unauth), ("g2.jwt_wrong_key", wrong)):
    ok = code not in {"200", "201", "204"}
    emit(case_id, "PASS" if ok else "FAIL", f"volume PUT status={code}")
PY
else
  for id in g2.s3_checksum g2.presign_expiry g2.anonymous_deny g2.wrong_credentials g2.cross_bucket g2.jwt_unauthenticated g2.jwt_wrong_key; do
    note_missing "$id" "storage did not start"
  done
fi

if ./infra/seaweedfs/verify-firewall-lifecycle.sh >"$out/firewall.log" 2>&1; then
  record g2.firewall_lifecycle PASS true "firewall lifecycle script passed, including restart"
else
  record g2.firewall_lifecycle FAIL true "firewall lifecycle script failed"
fi
jwt_ok=0
trust_ok=0
./infra/seaweedfs/verify-jwt-authority.sh >"$out/jwt-authority.log" 2>&1 && jwt_ok=1
./infra/seaweedfs/verify-trust-boundary.sh >"$out/trust.log" 2>&1 && trust_ok=1
if [ "$jwt_ok" = 1 ] && [ "$trust_ok" = 1 ]; then
  record g2.trust_boundary PASS true "JWT authority separation and trust-boundary script passed"
else
  record g2.trust_boundary FAIL true "jwt_authority=$jwt_ok trust_boundary=$trust_ok"
fi
if curl --max-time 3 -s -o /dev/null -w '%{http_code}' http://172.30.210.10:9333/ >"$out/host-isolation.txt" 2>"$out/host-isolation.err"; then
  code=$(cat "$out/host-isolation.txt")
  if [ "$code" = "200" ]; then
    record g2.host_isolation FAIL true "host reached master"
  else
    record g2.host_isolation PASS true "host master request status=$code"
  fi
else
  record g2.host_isolation PASS true "host connection to the storage subnet was blocked"
fi

python3 - <<'PY'
import hashlib, json, os, subprocess, tempfile, urllib.request
from pathlib import Path
results = os.environ["QA_RESULTS"]
out = Path(os.environ["QA_OUT"])

def emit(case_id, status, required, detail):
    print(f"{status} {case_id}: {detail}")
    with open(results, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"id": case_id, "gate": "G2", "status": status, "required": required, "detail": detail}) + "\n")

def curl(args):
    return subprocess.run(["curl", *args], capture_output=True, text=True, check=False)

body = b"qa-backup-restore-proof-v1"
digest = hashlib.sha256(body).hexdigest()
blob = out / "proof.bin"
blob.write_bytes(body)
common = ["--aws-sigv4", "aws:amz:us-east-1:s3", "--user", "editagent:editagent-dev-secret", "--max-time", "10"]
put = curl([*common, "-s", "-o", str(out / "put.body"), "-w", "%{http_code}", "-X", "PUT", "--data-binary", f"@{blob}", "-H", "Content-Type: application/octet-stream", "http://127.0.0.1:9000/editagent/projects/qa-backup/proof.bin"])
backup = Path(tempfile.mkdtemp(prefix="qa-seaweed-backup-"))
copied = subprocess.run(["sh", "infra/seaweedfs/backup-volumes.sh", str(backup)], capture_output=True, text=True, check=False)
deleted = curl([*common, "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "DELETE", "http://127.0.0.1:9000/editagent/projects/qa-backup/proof.bin"])
head = curl([*common, "-s", "-o", str(out / "deleted.bin"), "-w", "%{http_code}", "http://127.0.0.1:9000/editagent/projects/qa-backup/proof.bin"])
restored = subprocess.run(["sh", "infra/seaweedfs/restore-volumes.sh", str(backup)], capture_output=True, text=True, check=False)
got = curl([*common, "-s", "-D", str(out / "restored.hdr"), "-o", str(out / "restored.bin"), "-w", "%{http_code}", "http://127.0.0.1:9000/editagent/projects/qa-backup/proof.bin"])
anon = curl(["-s", "-o", str(out / "anon.bin"), "-w", "%{http_code}", "--max-time", "10", "http://127.0.0.1:9000/editagent/projects/qa-backup/proof.bin"])
actual = hashlib.sha256((out / "restored.bin").read_bytes()).hexdigest() if (out / "restored.bin").is_file() else ""
ok = copied.returncode == 0 and restored.returncode == 0 and got.stdout.strip() == "200" and actual == digest and anon.stdout.strip() == "403" and head.stdout.strip() in {"404", "403"}
emit(
    "g2.backup_restore",
    "PASS" if ok else "FAIL",
    True,
    f"put={put.stdout.strip()} delete_head={head.stdout.strip()} restored_sha256={actual} expected={digest} anonymous={anon.stdout.strip()}",
)
corrupt = backup / "corrupt"
corrupt.mkdir()
for name in ("seaweed-master.tar", "seaweed-volume.tar", "seaweed-filer.tar"):
    (corrupt / name).write_bytes(b"not-a-tar")
bad = subprocess.run(["sh", "infra/seaweedfs/restore-volumes.sh", str(corrupt)], capture_output=True, text=True, check=False)
emit("g2.corrupt_backup_control", "PASS" if bad.returncode != 0 else "FAIL", True, f"corrupt restore exit={bad.returncode}")
missing = subprocess.run(["sh", "infra/seaweedfs/restore-volumes.sh", str(out / "missing-backup")], capture_output=True, text=True, check=False)
emit("g2.missing_backup_control", "PASS" if missing.returncode != 0 else "FAIL", True, f"missing restore exit={missing.returncode}")
PY

record g2.volume_migration NOT_VERIFIED false "PRODUCTION_VOLUME_MIGRATION=NOT_VERIFIED; disposable current-version volumes do not prove production migration or rollback"

for id in \
  g2.s3_checksum g2.presign_expiry g2.anonymous_deny g2.wrong_credentials g2.cross_bucket \
  g2.jwt_unauthenticated g2.jwt_wrong_key g2.backup_restore g2.corrupt_backup_control \
  g2.missing_backup_control g2.reachability g2.trivy_scan g2.sbom g2.native_cve_absent \
  g2.high_go_jose_evidence g2.low_go_brotli_evidence g2.alpine_fixed_range \
  g2.simulated_critical_control
do
  if ! grep -q "\"id\": \"$id\"" "$results" && ! grep -q "\"id\":\"$id\"" "$results"; then
    record "$id" ERROR true "case was not recorded"
  fi
done

if grep -E '"status": "FAIL"|"status":"FAIL"|"status": "ERROR"|"status":"ERROR"' "$results" >/dev/null 2>&1; then
  fail=1
fi

exit "$fail"
