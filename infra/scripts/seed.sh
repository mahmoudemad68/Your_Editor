#!/bin/sh
# Bootstrap the development data services. Does not insert application rows.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${POSTGRES_USER:=editagent}"
: "${POSTGRES_DB:=editagent}"
: "${MINIO_ROOT_USER:=editagent}"
: "${MINIO_ROOT_PASSWORD:=editagent-dev-secret}"
: "${S3_BUCKET:=editagent}"
: "${S3_REGION:=us-east-1}"
: "${MINIO_PORT:=9000}"

docker compose up -d --wait --wait-timeout 180 postgres redis minio

echo "Checking PostgreSQL"
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database();"'

echo "Checking Redis"
docker compose exec -T redis redis-cli PING

echo "Ensuring MinIO bucket"
MINIO_ROOT_USER="$MINIO_ROOT_USER" \
  MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
  S3_BUCKET="$S3_BUCKET" \
  S3_REGION="$S3_REGION" \
  MINIO_HOST="${MINIO_HOST:-127.0.0.1}" \
  MINIO_PORT="$MINIO_PORT" \
  python3 "$ROOT/infra/scripts/ensure_bucket.py"

echo "Infrastructure bootstrap complete. No application entities were inserted."
