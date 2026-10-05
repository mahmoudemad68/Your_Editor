#!/bin/sh
# Scans the security gate requires. This workflow does not publish images.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
"$root/supply-chain-services.sh"
printf '%s\n' dependencies
