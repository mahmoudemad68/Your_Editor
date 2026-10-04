#!/bin/sh
# Authorize publication only when every mandatory image scan passed.
# A missing result is a failure. This script does not push images.
set -eu

scan_dir=${SCAN_DIR:?SCAN_DIR is required}
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)

for service in $("$root/supply-chain-required-scans.sh"); do
  result="$scan_dir/$service"
  if [ ! -f "$result" ]; then
    echo "security gate rejected $service: scan result missing" >&2
    exit 1
  fi
  status=$(tr -d '[:space:]' <"$result")
  if [ "$status" != "pass" ]; then
    echo "security gate rejected $service: $status" >&2
    exit 1
  fi
done

echo "supply-chain security gate passed"
