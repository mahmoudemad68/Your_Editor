#!/bin/sh
# Fail when the locked AI worker dependencies have a critical vulnerability.
# A moderate finding is reported and does not fail this gate.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp)"
report="$(mktemp)"
trap 'rm -f "$tmp" "$report"' EXIT

uv export \
  --project "$ROOT/workers/ai-worker" \
  --frozen \
  --no-dev \
  --no-emit-project \
  --no-hashes \
  --format requirements-txt \
  --output-file "$tmp"

set +e
uvx pip-audit \
  --requirement "$tmp" \
  --format json \
  --vulnerability-service osv \
  --progress-spinner off >"$report"
status=$?
set -e

if [ -n "${SUPPLY_CHAIN_EVIDENCE:-}" ]; then
  mkdir -p "$SUPPLY_CHAIN_EVIDENCE"
  cp "$report" "$SUPPLY_CHAIN_EVIDENCE/python-audit.json"
fi

python3 "$ROOT/infra/scripts/python_audit_report.py" "$report" "$status"
