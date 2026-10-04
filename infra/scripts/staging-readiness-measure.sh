#!/bin/sh
# Measure Postgres and Redis connections around repeated /ready polls.
# A missing staging URL is a blocked measurement, not a passing one.
set -eu

if [ -z "${STAGING_API_URL:-}" ] || [ -z "${COMPOSE_FILE:-}" ]; then
  echo "STAGING_READINESS_BLOCKED: set STAGING_API_URL and COMPOSE_FILE." >&2
  exit 2
fi
if [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_DB:-}" ]; then
  echo "STAGING_READINESS_BLOCKED: set POSTGRES_USER and POSTGRES_DB." >&2
  exit 2
fi

api="${STAGING_API_URL%/}"

pg_clients() {
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
}

redis_clients() {
  docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli INFO clients \
    | awk -F: '/^connected_clients:/ {gsub("\r","",$2); print $2}'
}

sample() {
  label="$1"
  pg="$(pg_clients | tr -d '[:space:]')"
  redis="$(redis_clients | tr -d '[:space:]')"
  echo "$label postgres=$pg redis=$redis" >&2
  printf '%s %s\n' "$pg" "$redis"
}

before="$(sample before)"
before_pg="${before%% *}"
before_redis="${before##* }"

i=0
while [ "$i" -lt 20 ]; do
  curl -sS --connect-timeout 2 --max-time 5 -o /dev/null "$api/ready" || true
  i=$((i + 1))
done
during="$(sample during)"
during_pg="${during%% *}"
during_redis="${during##* }"

sleep 5
after="$(sample after)"
after_pg="${after%% *}"
after_redis="${after##* }"

if [ "$during_pg" -gt $((before_pg + 2)) ] || [ "$during_redis" -gt $((before_redis + 2)) ]; then
  echo "connection counts grew during /ready polling" >&2
  exit 1
fi
if [ "$after_pg" -gt $((before_pg + 1)) ] || [ "$after_redis" -gt $((before_redis + 1)) ]; then
  echo "connection counts did not return to the idle baseline" >&2
  exit 1
fi

if [ -n "${STAGING_SILENT_API_URL:-}" ]; then
  silent="${STAGING_SILENT_API_URL%/}"
  result="$(curl -sS --connect-timeout 2 --max-time 2 -o /dev/null -w '%{http_code} %{time_total}' "$silent/ready" || true)"
  if [ -z "${result:-}" ]; then
    echo "silent dependency curl produced no result" >&2
    exit 1
  fi
  code="${result%% *}"
  elapsed="${result##* }"
  python3 -c 'import sys; raise SystemExit(0 if float(sys.argv[1]) <= 2 else 1)' "$elapsed" || {
    echo "silent dependency returned $code in ${elapsed}s" >&2
    exit 1
  }
  if [ "$code" != "503" ]; then
    echo "silent dependency returned $code in ${elapsed}s" >&2
    exit 1
  fi
else
  echo "STAGING_READINESS_BLOCKED: STAGING_SILENT_API_URL is unset, so the silent-dependency deadline was not measured." >&2
  exit 2
fi

echo "readiness connection measurement passed"
