#!/bin/sh
# Owner-installed Docker ExecStartPost hook; never rebuild source on reboot.
set -eu
root=${1:?persistent deployment root required}
release=$(readlink -f "$root/current")
test -f "$release/release.json"
exec python3 "$release/infra/scripts/staging_release.py" resume --root "$root" --release-dir "$release"
