#!/bin/sh
# Scans the security gate requires. Built images are published.
# SeaweedFS is the pinned upstream image and is scanned, not rebuilt.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
"$root/supply-chain-services.sh"
printf '%s\n' seaweedfs
