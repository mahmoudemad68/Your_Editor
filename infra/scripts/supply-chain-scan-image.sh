#!/bin/sh
# Write an SBOM and a HIGH,CRITICAL Trivy report for one image.
# A critical finding fails this script before the pass file is written.
# High findings stay in the JSON report. Ignore files are rejected.
# Usage: supply-chain-scan-image.sh <service> <image>
set -eu

service=${1:?service is required}
image=${2:?image is required}

if [ -e .trivyignore ] || [ -e .trivyignore.yaml ]; then
  echo "vulnerability ignore file is not allowed" >&2
  exit 1
fi
unset TRIVY_IGNORE_UNFIXED
unset TRIVY_IGNOREFILE

syft "$image" -o "spdx-json=sbom-${service}.spdx.json"
test -s "sbom-${service}.spdx.json"
trivy version > "trivy-${service}.version.txt"
trivy image \
  --severity HIGH,CRITICAL \
  --format json \
  --output "trivy-${service}.json" \
  --exit-code 0 \
  "$image"
test -s "trivy-${service}.json"
trivy image --severity CRITICAL --exit-code 1 "$image"
printf 'pass\n' > "$service"
