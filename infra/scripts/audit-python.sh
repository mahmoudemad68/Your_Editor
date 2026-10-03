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

python3 - "$report" "$status" <<'PY'
import json
import sys

path, raw_status = sys.argv[1], int(sys.argv[2])
try:
    report = json.load(open(path, encoding="utf-8"))
except json.JSONDecodeError as exc:
    raise SystemExit(f"Python dependency scan did not return JSON ({exc}).") from exc

dependencies = report.get("dependencies", [])
critical = []
other = []
for dependency in dependencies:
    name = dependency.get("name", "unknown")
    version = dependency.get("version", "unknown")
    for vulnerability in dependency.get("vulns", []):
        label = f"{name}=={version} {vulnerability.get('id', 'unknown')}"
        severities = []
        raw = vulnerability.get("severity")
        if isinstance(raw, str):
            severities.append(raw.upper())
        elif isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict):
                    severities.append(str(item.get("severity", "")).upper())
                else:
                    severities.append(str(item).upper())
        if "CRITICAL" in severities:
            critical.append(label)
        elif severities:
            other.append(label)
        else:
            critical.append(f"{label} (no severity; treated as critical)")

if critical:
    print("Critical Python vulnerabilities:")
    for item in critical:
        print(f"- {item}")
    raise SystemExit(1)
if raw_status not in (0, 1):
    raise SystemExit(f"pip-audit failed with status {raw_status}.")
if other:
    print(f"Python dependency scan found {len(other)} non-critical findings.")
else:
    print("Python dependency scan found no vulnerabilities.")
PY
