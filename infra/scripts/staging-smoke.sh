#!/bin/sh
# Staging smoke test. It does not default to localhost and does not claim
# success when sign-in or the staging host is unavailable.
# Exit 0: the upload path, outbox, worker, and restart recovery passed.
# Exit 2: web and API liveness passed, and a later product gate blocked the rest.
set -eu

if [ -z "${STAGING_API_URL:-}" ] || [ -z "${STAGING_WEB_URL:-}" ]; then
  echo "STAGING_SMOKE_BLOCKED: set STAGING_API_URL and STAGING_WEB_URL." >&2
  exit 2
fi

api="${STAGING_API_URL%/}"
web="${STAGING_WEB_URL%/}"
correlation="staging-$(date +%s)"

expect_json() {
  url="$1"
  expected="$2"
  body="$(mktemp)"
  code="$(curl -sS -o "$body" -w '%{http_code}' "$url")"
  if [ "$code" != "$expected" ]; then
    echo "unexpected status $code from $url" >&2
    cat "$body" >&2
    rm -f "$body"
    exit 1
  fi
  rm -f "$body"
}

expect_json "$web/health" 200
expect_json "$web/" 200
expect_json "$api/health" 200
expect_json "$api/ready" 200

project_body="$(mktemp)"
project_code="$(curl -sS -o "$project_body" -w '%{http_code}' \
  -H 'content-type: application/json' \
  -H "x-request-id: $correlation" \
  -d '{"name":"staging-smoke"}' \
  "$api/projects")"
if [ "$project_code" = "401" ]; then
  echo "STAGING_SMOKE_BLOCKED: sign-in is required (US-118)." >&2
  echo "Web and API /health and /ready passed. Upload, outbox, BullMQ, correlation, and restart recovery were not executed." >&2
  rm -f "$project_body"
  exit 2
fi
if [ "$project_code" != "201" ]; then
  echo "project create returned $project_code" >&2
  cat "$project_body" >&2
  rm -f "$project_body"
  exit 1
fi
project_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$project_body")"
rm -f "$project_body"

if [ -z "${COMPOSE_FILE:-}" ]; then
  echo "STAGING_SMOKE_BLOCKED: COMPOSE_FILE is required to read Postgres, Redis, and worker logs." >&2
  exit 2
fi

payload="$(mktemp)"
printf 'editagent-staging-smoke' >"$payload"
hash="$(sha256sum "$payload" | awk '{print $1}')"
bytes="$(wc -c <"$payload" | tr -d ' ')"
declaration="$(python3 -c 'import json,sys; print(json.dumps({"filename":"smoke.mp4","mimeType":"video/mp4","byteSize":int(sys.argv[1]),"sha256":sys.argv[2]}))' "$bytes" "$hash")"

upload_body="$(mktemp)"
upload_code="$(curl -sS -o "$upload_body" -w '%{http_code}' \
  -H 'content-type: application/json' \
  -H "x-request-id: $correlation" \
  -d "$declaration" \
  "$api/projects/$project_id/uploads")"
if [ "$upload_code" != "201" ]; then
  echo "upload begin returned $upload_code" >&2
  cat "$upload_body" >&2
  exit 1
fi
python3 - "$upload_body" "$payload" <<'PY'
import json, subprocess, sys
upload = json.load(open(sys.argv[1], encoding="utf-8"))
headers = [item for pair in upload["requiredHeaders"].items() for item in ("-H", f"{pair[0]}: {pair[1]}")]
result = subprocess.run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", *headers, "--data-binary", f"@{sys.argv[2]}", upload["uploadUrl"]], check=True, text=True, capture_output=True)
if result.stdout.strip() != "200":
    raise SystemExit(f"object upload returned {result.stdout.strip()}")
PY

complete_body="$(mktemp)"
complete_code="$(curl -sS -o "$complete_body" -w '%{http_code}' \
  -H 'content-type: application/json' \
  -H "x-request-id: $correlation" \
  -d "$declaration" \
  "$api/projects/$project_id/uploads/complete")"
if [ "$complete_code" != "201" ]; then
  echo "upload complete returned $complete_code" >&2
  cat "$complete_body" >&2
  exit 1
fi
asset_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$complete_body")"
rm -f "$complete_body" "$upload_body" "$payload"

psql_query() {
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"
}

deadline=$(( $(date +%s) + 60 ))
job_id=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  row="$(psql_query "SELECT job_id::text || ' ' || status FROM inspect_publication_outbox WHERE media_asset_id = '$asset_id'")"
  status="${row#* }"
  job_id="${row%% *}"
  if [ "$status" = "Delivered" ]; then
    break
  fi
  sleep 1
done
if [ "$status" != "Delivered" ]; then
  echo "outbox did not reach Delivered: ${row:-missing}" >&2
  exit 1
fi

job_status="$(psql_query "SELECT status FROM jobs WHERE id = '$job_id'")"
attempt_status="$(psql_query "SELECT status FROM job_attempts WHERE job_id = '$job_id' AND status = 'Completed'")"
if [ "$job_status" != "Completed" ] || [ "$attempt_status" != "Completed" ]; then
  echo "job ledger is $job_status / ${attempt_status:-missing}" >&2
  exit 1
fi

queue_name="$(psql_query "SELECT queue_name FROM inspect_publication_outbox WHERE job_id = '$job_id'")"
bull="$(docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli HGET "bull:${queue_name}:${job_id}" data || true)"
printf '%s\n' "$bull" | grep -q "$correlation"

docker compose -f "$COMPOSE_FILE" logs --no-color --since 10m api | grep -q "$correlation"
docker compose -f "$COMPOSE_FILE" logs --no-color --since 10m media-worker | grep -q "$correlation"

# Recovery uses a second object so the first delivered job is not reused.
recover_payload="$(mktemp)"
printf 'editagent-staging-smoke-recover' >"$recover_payload"
recover_hash="$(sha256sum "$recover_payload" | awk '{print $1}')"
recover_bytes="$(wc -c <"$recover_payload" | tr -d ' ')"
recover_declaration="$(python3 -c 'import json,sys; print(json.dumps({"filename":"recover.mp4","mimeType":"video/mp4","byteSize":int(sys.argv[1]),"sha256":sys.argv[2]}))' "$recover_bytes" "$recover_hash")"
recover_correlation="${correlation}-recover"

docker compose -f "$COMPOSE_FILE" stop redis
recover_upload="$(mktemp)"
recover_begin="$(curl -sS -o "$recover_upload" -w '%{http_code}' \
  -H 'content-type: application/json' \
  -H "x-request-id: $recover_correlation" \
  -d "$recover_declaration" \
  "$api/projects/$project_id/uploads")"
if [ "$recover_begin" != "201" ]; then
  docker compose -f "$COMPOSE_FILE" start redis
  echo "recovery upload begin returned $recover_begin" >&2
  exit 1
fi
python3 - "$recover_upload" "$recover_payload" <<'PY'
import json, subprocess, sys
upload = json.load(open(sys.argv[1], encoding="utf-8"))
headers = [item for pair in upload["requiredHeaders"].items() for item in ("-H", f"{pair[0]}: {pair[1]}")]
result = subprocess.run(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PUT", *headers, "--data-binary", f"@{sys.argv[2]}", upload["uploadUrl"]], check=True, text=True, capture_output=True)
if result.stdout.strip() != "200":
    raise SystemExit(f"recovery object upload returned {result.stdout.strip()}")
PY
recover_body="$(mktemp)"
recover_code="$(curl -sS -o "$recover_body" -w '%{http_code}' \
  -H 'content-type: application/json' \
  -H "x-request-id: $recover_correlation" \
  -d "$recover_declaration" \
  "$api/projects/$project_id/uploads/complete")"
recover_asset="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$recover_body" || true)"
if [ "$recover_code" != "201" ]; then
  docker compose -f "$COMPOSE_FILE" start redis
  echo "recovery completion returned $recover_code" >&2
  cat "$recover_body" >&2
  exit 1
fi
pending="$(psql_query "SELECT status FROM inspect_publication_outbox WHERE media_asset_id = '$recover_asset'")"
if [ "$pending" != "Pending" ]; then
  docker compose -f "$COMPOSE_FILE" start redis
  echo "recovery outbox was ${pending:-missing} while Redis was stopped" >&2
  exit 1
fi
docker compose -f "$COMPOSE_FILE" start redis
docker compose -f "$COMPOSE_FILE" restart api
deadline=$(( $(date +%s) + 90 ))
recovered=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  recovered="$(psql_query "SELECT status FROM inspect_publication_outbox WHERE media_asset_id = '$recover_asset'")"
  if [ "$recovered" = "Delivered" ]; then
    break
  fi
  sleep 2
done
if [ "$recovered" != "Delivered" ]; then
  echo "outbox stayed ${recovered:-missing} after API restart" >&2
  exit 1
fi
recover_job="$(psql_query "SELECT job_id::text FROM inspect_publication_outbox WHERE media_asset_id = '$recover_asset'")"
count="$(psql_query "SELECT count(*) FROM jobs WHERE id = '$recover_job'")"
if [ "$count" != "1" ]; then
  echo "expected one logical recovery job, found $count" >&2
  exit 1
fi
rm -f "$recover_payload" "$recover_upload" "$recover_body"

echo "staging smoke passed for correlation $correlation"
