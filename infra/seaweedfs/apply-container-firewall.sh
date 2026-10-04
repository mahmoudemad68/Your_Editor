#!/bin/sh
# Install input rules inside each storage container network namespace.
# Host FORWARD rules do not see same-bridge traffic on every Docker host.
# These rules do: only the four storage addresses, plus loopback, may open
# the internal service ports. The S3 listener on 8333 stays open.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$root/infra/seaweedfs/storage-network.env"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E "$0" "$@"
fi

cd "$root"

peers="$SEAWEED_MASTER_IP $SEAWEED_VOLUME_IP $SEAWEED_FILER_IP $SEAWEED_S3_IP"

container_id() {
  docker compose ps -q "$1"
}

wait_pid() {
  cid="$1"
  i=0
  while [ "$i" -lt 50 ]; do
    pid="$(docker inspect -f '{{.State.Pid}}' "$cid" 2>/dev/null || echo 0)"
    if [ "$pid" != "0" ] && [ -n "$pid" ]; then
      echo "$pid"
      return 0
    fi
    i=$((i + 1))
    sleep 0.2
  done
  echo "container $cid has no network namespace" >&2
  return 1
}

pick_bin() {
  pid="$1"
  for bin in iptables-nft iptables-legacy iptables; do
    if nsenter -t "$pid" -n "$bin" -S INPUT >/dev/null 2>&1; then
      echo "$bin"
      return 0
    fi
  done
  echo "no iptables backend in netns $pid" >&2
  return 1
}

apply_one() {
  service="$1"
  shift
  cid="$(container_id "$service")"
  if [ -z "$cid" ]; then
    echo "container for $service is not created" >&2
    return 1
  fi
  pid="$(wait_pid "$cid")"
  bin="$(pick_bin "$pid")"
  nsenter -t "$pid" -n "$bin" -N SEAWEED-IN 2>/dev/null || true
  nsenter -t "$pid" -n "$bin" -F SEAWEED-IN
  nsenter -t "$pid" -n "$bin" -A SEAWEED-IN -i lo -j ACCEPT
  nsenter -t "$pid" -n "$bin" -A SEAWEED-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for peer in $peers; do
    nsenter -t "$pid" -n "$bin" -A SEAWEED-IN -s "$peer" -j ACCEPT
  done
  for port in "$@"; do
    nsenter -t "$pid" -n "$bin" -A SEAWEED-IN -p tcp --dport "$port" -j DROP
  done
  if ! nsenter -t "$pid" -n "$bin" -C INPUT -j SEAWEED-IN >/dev/null 2>&1; then
    nsenter -t "$pid" -n "$bin" -I INPUT 1 -j SEAWEED-IN
  fi
  docker exec "$cid" touch /tmp/firewall.ready
}

apply_one seaweed-master 9333 19333
apply_one seaweed-volume 8080 18080
apply_one seaweed-filer 8888 18888
apply_one seaweed-s3
echo "container firewall installed"
