#!/bin/sh
# Audit locked AI worker and optional evaluation inference dependencies.
# Optional inference fails on HIGH as well as CRITICAL findings.
# Development dependencies are included. A high finding is reported and does
# not fail this gate by itself.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp)"
report="$(mktemp)"
trap 'rm -f "$tmp" "$report"' EXIT

# Environment switches must not drop the locked dev group.
unset UV_NO_DEV
unset UV_NO_GROUP
unset UV_NO_DEFAULT_GROUPS

uv export \
  --project "$ROOT/workers/ai-worker" \
  --frozen \
  --all-groups \
  --no-emit-project \
  --no-hashes \
  --format requirements-txt \
  --output-file "$tmp"

audit_requirements() {
  requirements_file="$1"
  evidence_name="$2"
  shift 2
  set +e
  uvx pip-audit \
    --requirement "$requirements_file" \
    --format json \
    --vulnerability-service osv \
    --progress-spinner off >"$report"
  status=$?
  set -e
  if [ -n "${SUPPLY_CHAIN_EVIDENCE:-}" ]; then
    mkdir -p "$SUPPLY_CHAIN_EVIDENCE"
    cp "$report" "$SUPPLY_CHAIN_EVIDENCE/$evidence_name"
  fi
  python3 "$ROOT/infra/scripts/python_audit_report.py" "$report" "$status" "$@"
}

audit_requirements "$tmp" python-audit.json
audit_requirements "$ROOT/tools/evaluation/requirements-generation.txt" python-evaluation-audit.json --reject-high
