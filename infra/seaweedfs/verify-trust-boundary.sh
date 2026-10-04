#!/bin/sh
# Adversarial checks for the SeaweedFS storage boundary.
# Fails if an unauthorized client can obtain a volume write token, write to
# Volume, read or delete a private object, or reach Master, Volume, or Filer
# from the Docker host or from an unrelated network.
# Response bodies, JWTs, signing keys, and S3 credentials are not printed.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$root/infra/seaweedfs/storage-network.env"
cd "$root"

"$root/infra/seaweedfs/apply-host-isolation.sh" --check >/dev/null

project="${COMPOSE_PROJECT_NAME:-editagent}"
network="${project}_storage_internal"
image="${SEAWEED_IMAGE:-editagent-seaweedfs:local}"
bucket="${S3_BUCKET:-editagent}"
region="${S3_REGION:-us-east-1}"
access="${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:-editagent}}"
secret="${S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD:-editagent-dev-secret}}"
published="$(docker compose port seaweed-s3 8333)"
port="${published##*:}"
endpoint="http://127.0.0.1:${port}"
key_path="projects/trust-boundary/probe.bin"
probe="trust-boundary-private-object"

tmpdir="$(mktemp -d)"
other_network="editagent-trust-unrelated"
attacker=""
trap 'rm -rf "$tmpdir"; docker rm -f "$attacker" >/dev/null 2>&1 || true; docker network rm "$other_network" >/dev/null 2>&1 || true' EXIT

fail() {
  echo "trust boundary failed: $1" >&2
  exit 1
}

curl_code() {
  # $1 output body, $2 headers, remaining curl args
  body="$1"
  headers="$2"
  shift 2
  curl -sS -o "$body" -D "$headers" -w '%{http_code}' --max-time 3 "$@" || true
}

token_or_fid() {
  headers="$1"
  body="$2"
  if grep -qi '^authorization:' "$headers"; then
    fail "master issued a write token"
  fi
  if grep -q '"fid"' "$body"; then
    fail "master assigned a file id"
  fi
}

# A private object must exist before the negative reads. Signing uses curl's
# SigV4 helper. The credential is not written to the report.
printf '%s' "$probe" >"$tmpdir/probe"
create_code="$(curl_code "$tmpdir/create.body" "$tmpdir/create.hdr" \
  --aws-sigv4 "aws:amz:${region}:s3" --user "${access}:${secret}" \
  -X PUT "$endpoint/$bucket")"
case "$create_code" in
  200|409) ;;
  *) fail "could not prepare the private bucket (http $create_code)" ;;
esac
put_code="$(curl_code "$tmpdir/put.body" "$tmpdir/put.hdr" \
  --aws-sigv4 "aws:amz:${region}:s3" --user "${access}:${secret}" \
  -H 'Content-Type: application/octet-stream' \
  -X PUT --data-binary @"$tmpdir/probe" \
  "$endpoint/$bucket/$key_path")"
if [ "$put_code" != "200" ]; then
  fail "could not store the private object (http $put_code)"
fi
curl_code "$tmpdir/got.body" "$tmpdir/got.hdr" \
  --aws-sigv4 "aws:amz:${region}:s3" --user "${access}:${secret}" \
  "$endpoint/$bucket/$key_path" >/dev/null
if ! cmp -s "$tmpdir/probe" "$tmpdir/got.body"; then
  fail "signed GET did not return the private object"
fi

attacker="$(docker run -d --network "$network" --entrypoint sleep "$image" 120)"
attacker_ip="$(docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{$net.IPAddress}}{{end}}' "$attacker")"
case "$attacker_ip" in
  "$SEAWEED_MASTER_IP"|"$SEAWEED_VOLUME_IP"|"$SEAWEED_FILER_IP"|"$SEAWEED_S3_IP"|"")
    fail "unauthorized client received a storage address"
    ;;
esac

# The probe runs inside the unauthorized container. It prints only codes.
docker exec \
  -e MASTER="$SEAWEED_MASTER_IP" \
  -e VOLUME="$SEAWEED_VOLUME_IP" \
  -e FILER="$SEAWEED_FILER_IP" \
  -e S3IP="$SEAWEED_S3_IP" \
  -e BUCKET="$bucket" \
  -e KEY_PATH="$key_path" \
  -e PROBE="$probe" \
  "$attacker" sh -c '
set +e
auth=0
fid=0
assign=$(curl -sS -D /tmp/ah -o /tmp/ab -w "%{http_code}" --max-time 3 "http://$MASTER:9333/dir/assign" || true)
if grep -qi "^authorization:" /tmp/ah; then auth=1; fi
if grep -q "\"fid\"" /tmp/ab; then fid=1; fi
https_assign=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 "https://$MASTER:9333/dir/assign" || true)
cluster=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 "https://$MASTER:9333/cluster/status" || true)
ui=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 "https://$MASTER:9333/" || true)
grpc=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 "https://$MASTER:19333/" || true)
vol_put=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 -X PUT --data-binary x "http://$VOLUME:8080/3,aaaaaaaa" || true)
vol_get=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://$VOLUME:8080/" || true)
vol_grpc=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 "https://$VOLUME:18080/" || true)
filer_get=$(curl -sS -o /tmp/fb -w "%{http_code}" --max-time 3 "http://$FILER:8888/buckets/$BUCKET/$KEY_PATH" || true)
filer_del=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 -X DELETE "http://$FILER:8888/buckets/$BUCKET/$KEY_PATH" || true)
filer_grpc=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 3 "https://$FILER:18888/" || true)
s3_get=$(curl -sS -o /tmp/sb -w "%{http_code}" --max-time 3 "http://$S3IP:8333/$BUCKET/$KEY_PATH" || true)
s3_status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://$S3IP:8333/status" || true)
match=0
if [ -f /tmp/sb ] && grep -F -x -q "$PROBE" /tmp/sb; then match=1; fi
filer_match=0
if [ -f /tmp/fb ] && grep -F -x -q "$PROBE" /tmp/fb; then filer_match=1; fi
echo "assign=$assign auth=$auth fid=$fid https_assign=$https_assign cluster=$cluster ui=$ui grpc=$grpc vol_put=$vol_put vol_get=$vol_get vol_grpc=$vol_grpc filer_get=$filer_get filer_del=$filer_del filer_grpc=$filer_grpc s3_get=$s3_get s3_match=$match filer_match=$filer_match s3_status=$s3_status"
' >"$tmpdir/attacker.out"

report="$(cat "$tmpdir/attacker.out")"
echo "$report" | grep -q 'auth=0' || fail "unauthorized client received a write token"
echo "$report" | grep -q 'fid=0' || fail "unauthorized client received a file id"
echo "$report" | grep -q 's3_match=0' || fail "unauthorized client read the private object through S3"
echo "$report" | grep -q 'filer_match=0' || fail "unauthorized client read the private object through Filer"
echo "$report" | grep -q 's3_status=200' || fail "unauthorized client could not reach the S3 gateway, so the negative results are inconclusive"

value() {
  echo "$report" | sed -n "s/.*\\b$1=\\([^ ]*\\).*/\\1/p"
}

for name in https_assign cluster ui grpc vol_grpc filer_grpc; do
  code="$(value "$name")"
  case "$code" in
    000|400) ;;
    *) fail "unauthorized client completed $name (http $code)" ;;
  esac
done

for name in vol_put vol_get filer_get; do
  code="$(value "$name")"
  case "$code" in
    200|201|204) fail "unauthorized client succeeded at $name" ;;
  esac
done
filer_del="$(value filer_del)"
case "$filer_del" in
  200|202|204) fail "unauthorized client deleted the private object" ;;
esac
assign_code="$(value assign)"
case "$assign_code" in
  200) fail "unauthorized client called master assign" ;;
esac

# The signed object must still exist after the unauthorized delete attempt.
curl_code "$tmpdir/still.body" "$tmpdir/still.hdr" \
  --aws-sigv4 "aws:amz:${region}:s3" --user "${access}:${secret}" \
  "$endpoint/$bucket/$key_path" >/dev/null
if ! cmp -s "$tmpdir/probe" "$tmpdir/still.body"; then
  fail "private object was no longer readable after the unauthorized attempts"
fi

host_blocked() {
  label="$1"
  shift
  code="$(curl_code "$tmpdir/host.body" "$tmpdir/host.hdr" "$@")"
  token_or_fid "$tmpdir/host.hdr" "$tmpdir/host.body"
  if [ "$code" != "000" ]; then
    fail "host reached $label"
  fi
}

host_blocked "master assign" "http://$SEAWEED_MASTER_IP:9333/dir/assign"
host_blocked "master https" -k "https://$SEAWEED_MASTER_IP:9333/cluster/status"
host_blocked "master ui" -k "https://$SEAWEED_MASTER_IP:9333/"
host_blocked "master grpc" -k "https://$SEAWEED_MASTER_IP:19333/"
host_blocked "volume" "http://$SEAWEED_VOLUME_IP:8080/"
host_blocked "filer" "http://$SEAWEED_FILER_IP:8888/buckets/$bucket/$key_path"
s3_code="$(curl_code "$tmpdir/s3.body" "$tmpdir/s3.hdr" "$endpoint/status")"
if [ "$s3_code" != "200" ]; then
  fail "published S3 gateway is not reachable from the host"
fi

docker network rm "$other_network" >/dev/null 2>&1 || true
docker network create --subnet 172.31.250.0/24 "$other_network" >/dev/null
other="$(docker run -d --network "$other_network" --entrypoint sleep "$image" 60)"
other_report="$(docker exec \
  -e MASTER="$SEAWEED_MASTER_IP" \
  -e VOLUME="$SEAWEED_VOLUME_IP" \
  -e FILER="$SEAWEED_FILER_IP" \
  -e S3IP="$SEAWEED_S3_IP" \
  -e BUCKET="$bucket" \
  -e KEY_PATH="$key_path" \
  -e PROBE="$probe" \
  "$other" sh -c '
assign=$(curl -sS -D /tmp/h -o /tmp/b -w "%{http_code}" --max-time 2 "http://$MASTER:9333/dir/assign" || true)
auth=0; fid=0
if grep -qi "^authorization:" /tmp/h; then auth=1; fi
if grep -q "\"fid\"" /tmp/b; then fid=1; fi
vol=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 2 -X PUT --data-binary x "http://$VOLUME:8080/3,aaaaaaaa" || true)
filer=$(curl -sS -o /tmp/fb -w "%{http_code}" --max-time 2 "http://$FILER:8888/buckets/$BUCKET/$KEY_PATH" || true)
s3=$(curl -sS -o /tmp/sb -w "%{http_code}" --max-time 2 "http://$S3IP:8333/$BUCKET/$KEY_PATH" || true)
match=0
if grep -F -x -q "$PROBE" /tmp/sb 2>/dev/null; then match=1; fi
fmatch=0
if grep -F -x -q "$PROBE" /tmp/fb 2>/dev/null; then fmatch=1; fi
echo "assign=$assign auth=$auth fid=$fid vol=$vol filer=$filer s3=$s3 s3_match=$match filer_match=$fmatch"
')"
docker rm -f "$other" >/dev/null
echo "$other_report" | grep -q 'auth=0' || fail "unrelated network received a write token"
echo "$other_report" | grep -q 'fid=0' || fail "unrelated network received a file id"
echo "$other_report" | grep -q 's3_match=0' || fail "unrelated network read the private object"
echo "$other_report" | grep -q 'filer_match=0' || fail "unrelated network read the private object through Filer"
for name in assign vol filer; do
  code="$(echo "$other_report" | sed -n "s/.*\\b$name=\\([^ ]*\\).*/\\1/p")"
  if [ "$code" != "000" ]; then
    fail "unrelated network reached $name"
  fi
done

echo "trust boundary holds attacker=${attacker_ip}"
