#!/bin/sh
# Wait until the container network namespace has its input rules.
# SeaweedFS 4.48 answers volume /status to anyone who can open the TCP port.
# Docker often forwards that traffic on the bridge without the host FORWARD
# chain, so the rules have to exist in this namespace before weed listens.
set -eu

if [ "$(id -u)" = "0" ] && [ ! -f /tmp/firewall.ready ]; then
  i=0
  while [ ! -f /tmp/firewall.ready ]; do
    i=$((i + 1))
    if [ "$i" -gt 600 ]; then
      echo "firewall preflight did not complete" >&2
      exit 1
    fi
    sleep 0.1
  done
fi

exec /entrypoint.sh "$@"
