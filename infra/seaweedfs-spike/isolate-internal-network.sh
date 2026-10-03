#!/bin/sh
# Compose networks do not stop the Docker host, or a container on another
# bridge, from opening connections to an internal container IP.
# This script adds those host firewall rules for a disposable proof.
# A missing DOCKER-USER chain on one backend is ignored only when another
# backend accepts the same rule. If no backend can hold the rule, the script
# exits with an unsupported-firewall error.
# Usage:
#   isolate-internal-network.sh apply <internal-subnet> <internal-bridge>
#   isolate-internal-network.sh allow-forward <bridge>
#   isolate-internal-network.sh remove <internal-subnet> <internal-bridge>
#   isolate-internal-network.sh remove-forward <bridge>
#   isolate-internal-network.sh apply-edge <app-subnet>
#   isolate-internal-network.sh remove-edge <app-subnet>
#   isolate-internal-network.sh verify <internal-subnet> <internal-bridge> <app-subnet> <app-bridge>
set -eu

action=${1:?apply, remove, allow-forward, remove-forward, apply-edge, remove-edge, or verify}
subnet=${2:-}
bridge=${3:-}
app_subnet=${4:-}

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
    echo "unsupported firewall: root or sudo is required for host firewall rules" >&2
    return 1
  fi
}

TOOLS=""
if command -v iptables-nft >/dev/null 2>&1; then
  TOOLS="$TOOLS iptables-nft"
elif command -v iptables >/dev/null 2>&1; then
  TOOLS="$TOOLS iptables"
fi
if command -v iptables-legacy >/dev/null 2>&1; then
  TOOLS="$TOOLS iptables-legacy"
fi
TOOLS=${TOOLS# }

chain_present() {
  tool=$1
  chain=$2
  ipt "$tool" -S "$chain" >/dev/null 2>&1
}

# 0 = rule installed or already present
# 2 = this backend has no such chain
install_rule() {
  tool=$1
  shift
  chain=$1
  if ! chain_present "$tool" "$chain"; then
    return 2
  fi
  if [ "$action" = remove ] || [ "$action" = remove-forward ] || [ "$action" = remove-edge ]; then
    ipt "$tool" -D "$@" >/dev/null 2>&1 || true
    return 0
  fi
  ipt "$tool" -C "$@" >/dev/null 2>&1 || ipt "$tool" -I "$@"
}

require_one() {
  description=$1
  shift
  ok=0
  for tool in $TOOLS; do
    if install_rule "$tool" "$@"; then
      ok=$((ok + 1))
    else
      status=$?
      if [ "$status" -ne 2 ]; then
        echo "firewall rule failed on $tool: $*" >&2
        exit 1
      fi
    fi
  done
  if [ "$ok" -eq 0 ]; then
    echo "unsupported firewall: $description" >&2
    echo "checked backends: ${TOOLS:-none}" >&2
    echo "Docker must expose the named chain on iptables-nft or iptables-legacy." >&2
    exit 1
  fi
}

delete_everywhere() {
  for tool in $TOOLS; do
    install_rule "$tool" "$@" || true
  done
}

rule_visible() {
  tool=$1
  shift
  chain=$1
  if ! chain_present "$tool" "$chain"; then
    return 1
  fi
  ipt "$tool" -C "$@" >/dev/null 2>&1
}

require_visible() {
  description=$1
  shift
  for tool in $TOOLS; do
    if rule_visible "$tool" "$@"; then
      echo "$tool $*"
      return 0
    fi
  done
  echo "unsupported firewall: required rule is not effective: $description" >&2
  echo "checked backends: ${TOOLS:-none}" >&2
  exit 1
}

if [ "$action" = verify ]; then
  subnet=${2:?internal subnet}
  bridge=${3:?bridge interface}
  app_subnet=${4:?app subnet}
  app_bridge=${5:?app bridge}
  echo "firewall-backends: ${TOOLS:-none}"
  require_visible "internal bridge return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  require_visible "internal subnet drop" DOCKER-USER -d "$subnet" -j DROP
  require_visible "host output drop" OUTPUT -d "$subnet" -j DROP
  require_visible "container forward accept" DOCKER-FORWARD -i "$bridge" -j ACCEPT
  require_visible "app bridge forward" DOCKER-FORWARD -i "$app_bridge" -j ACCEPT
  require_visible "app established return" DOCKER-USER -d "$app_subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  require_visible "app s3 return" DOCKER-USER -d "$app_subnet" -p tcp --dport 8333 -j RETURN
  require_visible "app ingress return" DOCKER-USER -d "$app_subnet" -p tcp --dport 8080 -j RETURN
  require_visible "app subnet drop" DOCKER-USER -d "$app_subnet" -j DROP
  require_visible "host app established" OUTPUT -d "$app_subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  require_visible "host app s3" OUTPUT -d "$app_subnet" -p tcp --dport 8333 -j ACCEPT
  require_visible "host app ingress" OUTPUT -d "$app_subnet" -p tcp --dport 8080 -j ACCEPT
  require_visible "host app drop" OUTPUT -d "$app_subnet" -j DROP
  exit 0
fi

if [ "$action" = apply-edge ] || [ "$action" = remove-edge ]; then
  subnet=${2:?app subnet}
  # Published S3 is 8333 and the ingress is 8080. Every other port on the
  # application network is closed to the host and to sibling containers.
  # Insert the drops first so the port accepts stay at the head.
  if [ "$action" = remove-edge ]; then
    delete_everywhere OUTPUT -d "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    delete_everywhere DOCKER-USER -d "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    delete_everywhere OUTPUT -d "$subnet" -p tcp --dport 8080 -j ACCEPT
    delete_everywhere OUTPUT -d "$subnet" -p tcp --dport 8333 -j ACCEPT
    delete_everywhere DOCKER-USER -d "$subnet" -p tcp --dport 8080 -j RETURN
    delete_everywhere DOCKER-USER -d "$subnet" -p tcp --dport 8333 -j RETURN
    delete_everywhere OUTPUT -d "$subnet" -j DROP
    delete_everywhere DOCKER-USER -d "$subnet" -j DROP
    echo "$action application network $subnet"
    exit 0
  fi
  require_one "DOCKER-USER app subnet drop" DOCKER-USER -d "$subnet" -j DROP
  require_one "OUTPUT app subnet drop" OUTPUT -d "$subnet" -j DROP
  require_one "DOCKER-USER S3 port" DOCKER-USER -d "$subnet" -p tcp --dport 8333 -j RETURN
  require_one "DOCKER-USER ingress port" DOCKER-USER -d "$subnet" -p tcp --dport 8080 -j RETURN
  require_one "OUTPUT S3 port" OUTPUT -d "$subnet" -p tcp --dport 8333 -j ACCEPT
  require_one "OUTPUT ingress port" OUTPUT -d "$subnet" -p tcp --dport 8080 -j ACCEPT
  # Replies use ephemeral ports. Without this, the SYN is allowed and the
  # SYN-ACK is dropped because its destination port is not 8333 or 8080.
  require_one "DOCKER-USER established" DOCKER-USER -d "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  require_one "OUTPUT established" OUTPUT -d "$subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  echo "$action application network $subnet"
  exit 0
fi

if [ "$action" = allow-forward ] || [ "$action" = remove-forward ]; then
  if [ "$action" = remove-forward ]; then
    delete_everywhere DOCKER-FORWARD -i "$bridge" -j ACCEPT
    echo "$action container forwarding on $bridge"
    exit 0
  fi
  # iptables-legacy FORWARD policy is DROP on this host. Container traffic
  # uses FORWARD, so the bridge must be accepted there when that chain exists.
  require_one "DOCKER-FORWARD bridge accept" DOCKER-FORWARD -i "$bridge" -j ACCEPT
  echo "$action container forwarding on $bridge"
  exit 0
fi

bridge=${3:?bridge interface}
subnet=${2:?subnet}

if [ "$action" = remove ]; then
  delete_everywhere DOCKER-FORWARD -i "$bridge" -j ACCEPT
  delete_everywhere DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  delete_everywhere DOCKER-USER -d "$subnet" -j DROP
  delete_everywhere OUTPUT -d "$subnet" -j DROP
  echo "$action host firewall for $subnet via $bridge"
  exit 0
fi

require_one "DOCKER-FORWARD internal bridge" DOCKER-FORWARD -i "$bridge" -j ACCEPT
# Same-bridge SeaweedFS traffic is returned to Docker's later ACCEPT.
# Every other interface, including the application bridge, is dropped.
# Insert the DROP first, then the RETURN, so the RETURN stays at the head.
require_one "DOCKER-USER internal drop" DOCKER-USER -d "$subnet" -j DROP
require_one "DOCKER-USER internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
# Host processes use OUTPUT. Published S3 is on the application network,
# so this drop does not remove the external S3 endpoint.
require_one "OUTPUT internal drop" OUTPUT -d "$subnet" -j DROP

echo "$action host firewall for $subnet via $bridge"
