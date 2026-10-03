#!/bin/sh
# Compose networks do not stop the Docker host, or a container on another
# bridge, from opening connections to an internal container IP.
# This script adds those host firewall rules for a disposable proof.
# Usage:
#   isolate-internal-network.sh apply <internal-subnet> <internal-bridge>
#   isolate-internal-network.sh allow-forward <bridge>
#   isolate-internal-network.sh remove <internal-subnet> <internal-bridge>
#   isolate-internal-network.sh remove-forward <bridge>
#   isolate-internal-network.sh apply-edge <app-subnet>
#   isolate-internal-network.sh remove-edge <app-subnet>
set -eu

action=${1:?apply, remove, allow-forward, remove-forward, apply-edge, or remove-edge}
subnet=${2:-}
bridge=${3:-}

if [ "$action" = allow-forward ] || [ "$action" = remove-forward ]; then
  bridge=${2:?bridge interface}
  subnet=
fi

ipt() {
  if [ "$(id -u)" -eq 0 ]; then
    command "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "root or sudo is required for host firewall rules" >&2
    return 1
  fi
}

rule() {
  family=$1
  shift
  if [ "$family" = legacy ]; then
    if ! command -v iptables-legacy >/dev/null 2>&1; then
      return 0
    fi
    tool=iptables-legacy
  elif command -v iptables-nft >/dev/null 2>&1; then
    tool=iptables-nft
  else
    tool=iptables
  fi
  chain=$1
  # GitHub-hosted runners keep Docker's chains on one backend only.
  # Inserting into the other backend fails with "No chain/target/match".
  if ! ipt "$tool" -S "$chain" >/dev/null 2>&1; then
    echo "skip $tool $chain: chain is absent" >&2
    return 0
  fi
  if [ "$action" = remove ] || [ "$action" = remove-forward ] || [ "$action" = remove-edge ]; then
    ipt "$tool" -D "$@" >/dev/null 2>&1 || true
  else
    ipt "$tool" -C "$@" >/dev/null 2>&1 || ipt "$tool" -I "$@"
  fi
}

if [ "$action" = apply-edge ] || [ "$action" = remove-edge ]; then
  subnet=${2:?app subnet}
  # Published S3 is 8333 and the ingress is 8080. Every other port on the
  # application network is closed to the host and to sibling containers.
  # Insert the drops first so the port accepts stay at the head.
  for family in nft legacy; do
    rule "$family" OUTPUT -d "$subnet" -j DROP
    rule "$family" DOCKER-USER -d "$subnet" -j DROP
    rule "$family" OUTPUT -d "$subnet" -p tcp --dport 8333 -j ACCEPT
    rule "$family" OUTPUT -d "$subnet" -p tcp --dport 8080 -j ACCEPT
    rule "$family" DOCKER-USER -d "$subnet" -p tcp --dport 8333 -j RETURN
    rule "$family" DOCKER-USER -d "$subnet" -p tcp --dport 8080 -j RETURN
    # Replies use ephemeral ports. Without this, the SYN is allowed and the
    # SYN-ACK is dropped because its destination port is not 8333 or 8080.
    rule "$family" OUTPUT -d "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    rule "$family" DOCKER-USER -d "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  done
  echo "$action application network $subnet"
  exit 0
fi

if [ "$action" = allow-forward ] || [ "$action" = remove-forward ]; then
  # iptables-legacy FORWARD policy is DROP on this host. Container traffic
  # uses FORWARD, so the bridge must be accepted there.
  rule legacy DOCKER-FORWARD -i "$bridge" -j ACCEPT
  echo "$action container forwarding on $bridge"
  exit 0
fi

bridge=${3:?bridge interface}
subnet=${2:?subnet}

rule legacy DOCKER-FORWARD -i "$bridge" -j ACCEPT
# Same-bridge SeaweedFS traffic is returned to Docker's later ACCEPT.
# Every other interface, including the application bridge, is dropped.
# Insert the DROP first, then the RETURN, so the RETURN stays at the head.
if [ "$action" = apply ]; then
  rule nft DOCKER-USER -d "$subnet" -j DROP
  rule legacy DOCKER-USER -d "$subnet" -j DROP
  rule nft DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  rule legacy DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
else
  rule nft DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  rule legacy DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  rule nft DOCKER-USER -d "$subnet" -j DROP
  rule legacy DOCKER-USER -d "$subnet" -j DROP
fi
# Host processes use OUTPUT. Published S3 is on the application network,
# so this drop does not remove the external S3 endpoint.
rule nft OUTPUT -d "$subnet" -j DROP
rule legacy OUTPUT -d "$subnet" -j DROP

echo "$action host firewall for $subnet via $bridge"
