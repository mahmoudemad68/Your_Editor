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
: "${S3_PORT:=${MINIO_PORT:-9000}}"

./infra/seaweedfs/prepare-secrets.sh
docker compose up -d --wait --wait-timeout 180 postgres redis seaweed-master seaweed-volume seaweed-filer seaweed-s3

echo "Checking PostgreSQL"
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT current_database();"'

echo "Checking Redis"
docker compose exec -T redis redis-cli PING

echo "Ensuring object-storage bucket"
S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-$MINIO_ROOT_USER}" \
  S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-$MINIO_ROOT_PASSWORD}" \
  S3_BUCKET="$S3_BUCKET" \
  S3_REGION="$S3_REGION" \
  S3_HOST="${S3_HOST:-127.0.0.1}" \
  S3_PORT="$S3_PORT" \
  python3 "$ROOT/infra/scripts/ensure_bucket.py"

echo "Infrastructure bootstrap complete. No application entities were inserted."
