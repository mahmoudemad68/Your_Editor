#!/bin/sh
# Host isolation for the integrated SeaweedFS topology.
# This is not the disposable spike script. It drops the internal storage
# subnet on the host and on other bridges, drops every port on the S3
# container's application address except 8333, and rejects IPv6 on the
# internal bridge. A missing firewall chain is a failure.
# Usage:
#   install-host-isolation.sh apply <internal-subnet> <internal-bridge> <s3-app-ip> <app-bridge>
#   install-host-isolation.sh verify <internal-subnet> <internal-bridge> <s3-app-ip> <app-bridge>
#   install-host-isolation.sh remove <internal-subnet> <internal-bridge> <s3-app-ip> <app-bridge>
set -eu

action=${1:?apply, verify, or remove}
subnet=${2:?internal subnet}
bridge=${3:?internal bridge}
s3_ip=${4:?s3 application address}
app_bridge=${5:?application bridge}

ipt() {
  if [ "$(id -u)" -eq 0 ]; then
    command "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "unsupported firewall: root or sudo is required" >&2
    exit 1
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

IP6TOOLS=""
if command -v ip6tables-nft >/dev/null 2>&1; then
  IP6TOOLS="$IP6TOOLS ip6tables-nft"
elif command -v ip6tables >/dev/null 2>&1; then
  IP6TOOLS="$IP6TOOLS ip6tables"
fi
if command -v ip6tables-legacy >/dev/null 2>&1; then
  IP6TOOLS="$IP6TOOLS ip6tables-legacy"
fi
IP6TOOLS=${IP6TOOLS# }

chain_present() {
  ipt "$1" -S "$2" >/dev/null 2>&1
}

chain_present_any() {
  chain=$1
  for tool in $TOOLS; do
    if chain_present "$tool" "$chain"; then
      return 0
    fi
  done
  return 1
}

install_rule() {
  tool=$1
  shift
  chain=$1
  if ! chain_present "$tool" "$chain"; then
    return 2
  fi
  if [ "$action" = remove ]; then
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
  if [ "$action" != remove ] && [ "$ok" -eq 0 ]; then
    echo "unsupported firewall: $description" >&2
    echo "checked backends: ${TOOLS:-none}" >&2
    exit 1
  fi
}

rule_visible() {
  tool=$1
  shift
  chain=$1
  chain_present "$tool" "$chain" && ipt "$tool" -C "$@" >/dev/null 2>&1
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

ipv6_policy() {
  if [ -d "/sys/class/net/$bridge" ] && [ -f /proc/net/if_inet6 ]; then
    if [ -z "$IP6TOOLS" ]; then
      echo "unsupported firewall: the kernel has IPv6 and ip6tables is missing" >&2
      exit 1
    fi
    for tool in $IP6TOOLS; do
      if [ "$action" = remove ]; then
        ipt "$tool" -D FORWARD -i "$bridge" -j DROP >/dev/null 2>&1 || true
        ipt "$tool" -D FORWARD -o "$bridge" -j DROP >/dev/null 2>&1 || true
        ipt "$tool" -D OUTPUT -o "$bridge" -j DROP >/dev/null 2>&1 || true
      else
        ipt "$tool" -C FORWARD -i "$bridge" -j DROP >/dev/null 2>&1 || ipt "$tool" -I FORWARD -i "$bridge" -j DROP
        ipt "$tool" -C FORWARD -o "$bridge" -j DROP >/dev/null 2>&1 || ipt "$tool" -I FORWARD -o "$bridge" -j DROP
        ipt "$tool" -C OUTPUT -o "$bridge" -j DROP >/dev/null 2>&1 || ipt "$tool" -I OUTPUT -o "$bridge" -j DROP
      fi
    done
    if [ "$action" = verify ]; then
      tool=${IP6TOOLS%% *}
      ipt "$tool" -C FORWARD -i "$bridge" -j DROP >/dev/null 2>&1
      ipt "$tool" -C OUTPUT -o "$bridge" -j DROP >/dev/null 2>&1
      echo "$tool FORWARD -i $bridge -j DROP"
      echo "$tool OUTPUT -o $bridge -j DROP"
    fi
  elif [ "$action" = verify ]; then
    echo "ipv6-policy: kernel has no IPv6 addresses"
  fi
}

if [ "$action" = verify ]; then
  echo "firewall-backends: ${TOOLS:-none}"
  require_visible "internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  require_visible "internal drop" DOCKER-USER -d "$subnet" -j DROP
  require_visible "host internal drop" OUTPUT -d "$subnet" -j DROP
  if chain_present_any DOCKER-FORWARD; then
    require_visible "internal bridge forward" DOCKER-FORWARD -i "$bridge" -j ACCEPT
    require_visible "application bridge forward" DOCKER-FORWARD -i "$app_bridge" -j ACCEPT
  fi
  require_visible "s3 port" DOCKER-USER -d "$s3_ip" -p tcp --dport 8333 -j RETURN
  require_visible "s3 established" DOCKER-USER -d "$s3_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  require_visible "s3 other ports" DOCKER-USER -d "$s3_ip" -j DROP
  require_visible "host s3 port" OUTPUT -d "$s3_ip" -p tcp --dport 8333 -j ACCEPT
  require_visible "host s3 drop" OUTPUT -d "$s3_ip" -j DROP
  ipv6_policy
  exit 0
fi

if [ "$action" = remove ]; then
  if chain_present_any DOCKER-FORWARD; then
    require_one "remove internal bridge forward" DOCKER-FORWARD -i "$bridge" -j ACCEPT
    require_one "remove application bridge forward" DOCKER-FORWARD -i "$app_bridge" -j ACCEPT
  fi
  require_one "remove s3 established" DOCKER-USER -d "$s3_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  require_one "remove s3 port" DOCKER-USER -d "$s3_ip" -p tcp --dport 8333 -j RETURN
  require_one "remove s3 drop" DOCKER-USER -d "$s3_ip" -j DROP
  require_one "remove host s3 established" OUTPUT -d "$s3_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  require_one "remove host s3 port" OUTPUT -d "$s3_ip" -p tcp --dport 8333 -j ACCEPT
  require_one "remove host s3 drop" OUTPUT -d "$s3_ip" -j DROP
  require_one "remove internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  require_one "remove internal drop" DOCKER-USER -d "$subnet" -j DROP
  require_one "remove host internal drop" OUTPUT -d "$subnet" -j DROP
  ipv6_policy
  echo "removed host isolation for $subnet"
  exit 0
fi

if chain_present_any DOCKER-FORWARD; then
  require_one "internal bridge forward" DOCKER-FORWARD -i "$bridge" -j ACCEPT
  require_one "application bridge forward" DOCKER-FORWARD -i "$app_bridge" -j ACCEPT
fi
require_one "internal drop" DOCKER-USER -d "$subnet" -j DROP
require_one "internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
require_one "host internal drop" OUTPUT -d "$subnet" -j DROP
require_one "s3 drop" DOCKER-USER -d "$s3_ip" -j DROP
require_one "s3 port" DOCKER-USER -d "$s3_ip" -p tcp --dport 8333 -j RETURN
require_one "s3 established" DOCKER-USER -d "$s3_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
require_one "host s3 drop" OUTPUT -d "$s3_ip" -j DROP
require_one "host s3 port" OUTPUT -d "$s3_ip" -p tcp --dport 8333 -j ACCEPT
require_one "host s3 established" OUTPUT -d "$s3_ip" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ipv6_policy
echo "applied host isolation for $subnet via $bridge s3=$s3_ip"
