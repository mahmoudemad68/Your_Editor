#!/bin/sh
# Do not start weed because a file from a previous process still exists.
# Docker restart keeps the writable layer and drops the network namespace,
# including the SEAWEED-IN chain. This process publishes a new startup id
# and waits for the installer to acknowledge that exact id in this namespace.
set -eu

if [ "$(id -u)" != "0" ]; then
  echo "refusing non-root SeaweedFS startup" >&2
  exit 1
fi

rm -f /tmp/firewall.ready
mkdir -p /tmp/editagent-startup
chmod 700 /tmp/editagent-startup
rm -f /tmp/editagent-startup/ack

if [ -r /proc/sys/kernel/random/uuid ]; then
  nonce="$(cat /proc/sys/kernel/random/uuid)"
else
  nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
fi
netns="$(readlink /proc/self/ns/net)"
printf '%s %s\n' "$nonce" "$netns" >/tmp/editagent-startup/id
chmod 644 /tmp/editagent-startup/id

limit="${EDITAGENT_FIREWALL_WAIT_SECONDS:-60}"
deadline=$(($(date +%s) + limit))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -f /tmp/editagent-startup/ack ]; then
    ack="$(cat /tmp/editagent-startup/ack)"
    now="$(readlink /proc/self/ns/net)"
    if [ "$ack" = "$nonce $netns" ] && [ "$now" = "$netns" ]; then
      exec /entrypoint.sh "$@"
    fi
  fi
  sleep 0.1
done

echo "firewall preflight did not complete" >&2
exit 1
