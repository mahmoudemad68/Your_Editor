#!/bin/sh
# Subnet-scoped host isolation for the integrated SeaweedFS topology.
# Rules are based on the network CIDR and bridge, not a discovered container IP.
# Binaries are absolute paths. Privilege is root or non-interactive sudo.
# A missing backend, chain, or privilege is a deployment failure.
# Usage:
#   install-host-isolation.sh apply <internal-subnet> <internal-bridge> <app-subnet> <app-bridge> <published-ports>
#   install-host-isolation.sh verify <internal-subnet> <internal-bridge> <app-subnet> <app-bridge> <published-ports>
#   install-host-isolation.sh remove <internal-subnet> <internal-bridge> <app-subnet> <app-bridge> <published-ports>
# published-ports is a comma-separated list of container ports the host may open, or "-".
set -eu

action=${1:?apply, verify, or remove}
subnet=${2:?internal subnet}
bridge=${3:?internal bridge}
app_subnet=${4:?application subnet}
app_bridge=${5:?application bridge}
published=${6:?published ports or -}

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif [ -x /usr/bin/sudo ] && /usr/bin/sudo -n true >/dev/null 2>&1; then
  SUDO="/usr/bin/sudo -n"
else
  echo "unsupported firewall: root or non-interactive /usr/bin/sudo -n is required" >&2
  exit 1
fi

run_bin() {
  if [ -n "$SUDO" ]; then
    # shellcheck disable=SC2086
    $SUDO "$@"
  else
    "$@"
  fi
}

search_dirs() {
  if [ -n "${EDITAGENT_FIREWALL_BIN_DIR:-}" ]; then
    printf '%s\n' "$EDITAGENT_FIREWALL_BIN_DIR"
  else
    printf '%s\n' /usr/sbin /sbin
  fi
}

find_bin() {
  name=$1
  dir=""
  for dir in $(search_dirs); do
    if [ -x "$dir/$name" ]; then
      printf '%s\n' "$dir/$name"
      return 0
    fi
  done
  return 1
}

collect() {
  found=""
  name=""
  for name in "$@"; do
    if path=$(find_bin "$name"); then
      case " $found " in
        *" $path "*) ;;
        *) found="$found $path" ;;
      esac
    fi
  done
  printf '%s\n' "${found# }"
}

TOOLS=$(collect iptables-nft iptables-legacy iptables)
IP6TOOLS=$(collect ip6tables-nft ip6tables-legacy ip6tables)

if [ -z "$TOOLS" ]; then
  echo "unsupported firewall: no iptables binary under /usr/sbin or /sbin" >&2
  exit 1
fi

chain_present() {
  run_bin "$1" -S "$2" >/dev/null 2>&1
}

SELECTED=""
for tool in $TOOLS; do
  if chain_present "$tool" DOCKER-USER && chain_present "$tool" DOCKER-FORWARD && chain_present "$tool" OUTPUT; then
    SELECTED="$SELECTED $tool"
  else
    echo "firewall backend skipped because Docker chains are absent: $tool" >&2
  fi
done
SELECTED=${SELECTED# }
if [ -z "$SELECTED" ]; then
  echo "unsupported firewall: no backend has DOCKER-USER, DOCKER-FORWARD, and OUTPUT" >&2
  echo "checked: $TOOLS" >&2
  exit 1
fi

MESH="8333 8080 3000 3001 5432 6379 3200"
PUBLISHED=""
if [ "$published" != "-" ]; then
  old_ifs=$IFS
  IFS=,
  for port in $published; do
    case "$port" in
      "" | *[!0-9]*)
        echo "unsupported firewall: published port list is invalid" >&2
        exit 1
        ;;
    esac
    PUBLISHED="$PUBLISHED $port"
  done
  IFS=$old_ifs
fi
FORWARD_PORTS=$MESH
for port in $PUBLISHED; do
  case " $FORWARD_PORTS " in
    *" $port "*) ;;
    *) FORWARD_PORTS="$FORWARD_PORTS $port" ;;
  esac
done

install_rule() {
  tool=$1
  shift
  if [ "$action" = remove ]; then
    run_bin "$tool" -D "$@" >/dev/null 2>&1 || true
    return 0
  fi
  run_bin "$tool" -C "$@" >/dev/null 2>&1 || run_bin "$tool" -I "$@"
}

require_all() {
  description=$1
  shift
  tool=""
  for tool in $SELECTED; do
    if ! install_rule "$tool" "$@"; then
      echo "firewall rule failed on $tool: $description" >&2
      exit 1
    fi
  done
}

visible_all() {
  description=$1
  shift
  tool=""
  for tool in $SELECTED; do
    if ! run_bin "$tool" -C "$@" >/dev/null 2>&1; then
      echo "unsupported firewall: required rule is not effective on $tool: $description" >&2
      exit 1
    fi
    echo "$tool $*"
  done
}

ensure_ip6() {
  tool=$1
  shift
  if [ "$action" = remove ]; then
    run_bin "$tool" -D "$@" >/dev/null 2>&1 || true
    return 0
  fi
  if [ "$action" = verify ]; then
    run_bin "$tool" -C "$@" >/dev/null
    echo "$tool $*"
    return 0
  fi
  run_bin "$tool" -C "$@" >/dev/null 2>&1 || run_bin "$tool" -I "$@"
}

ipv6_rules() {
  if [ ! -f /proc/net/if_inet6 ]; then
    if [ "$action" = verify ]; then
      echo "ipv6-policy: kernel has no IPv6"
    fi
    return 0
  fi
  if [ -z "$IP6TOOLS" ]; then
    echo "unsupported firewall: the kernel has IPv6 and ip6tables is missing" >&2
    exit 1
  fi
  tool=""
  iface=""
  for tool in $IP6TOOLS; do
    for iface in "$bridge" "$app_bridge"; do
      ensure_ip6 "$tool" FORWARD -i "$iface" -j DROP
      ensure_ip6 "$tool" FORWARD -o "$iface" -j DROP
      ensure_ip6 "$tool" OUTPUT -o "$iface" -j DROP
    done
  done
}

apply_v4() {
  require_all "internal drop" DOCKER-USER -d "$subnet" -j DROP
  require_all "internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  require_all "host internal drop" OUTPUT -d "$subnet" -j DROP
  require_all "internal bridge forward" DOCKER-FORWARD -i "$bridge" -j ACCEPT
  require_all "application bridge forward" DOCKER-FORWARD -i "$app_bridge" -j ACCEPT
  require_all "app subnet drop" DOCKER-USER -d "$app_subnet" -j DROP
  require_all "host app subnet drop" OUTPUT -d "$app_subnet" -j DROP
  port=""
  for port in $FORWARD_PORTS; do
    require_all "app port $port" DOCKER-USER -d "$app_subnet" -p tcp --dport "$port" -j RETURN
  done
  for port in $PUBLISHED; do
    require_all "host published $port" OUTPUT -d "$app_subnet" -p tcp --dport "$port" -j ACCEPT
  done
  require_all "app established" DOCKER-USER -d "$app_subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  require_all "host app established" OUTPUT -d "$app_subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
}

if [ "$action" = remove ]; then
  # Delete accepts before drops so a partial remove cannot leave a hole.
  port=""
  for port in $FORWARD_PORTS; do
    require_all "remove app port $port" DOCKER-USER -d "$app_subnet" -p tcp --dport "$port" -j RETURN
  done
  for port in $PUBLISHED; do
    require_all "remove host published $port" OUTPUT -d "$app_subnet" -p tcp --dport "$port" -j ACCEPT
  done
  require_all "remove app established" DOCKER-USER -d "$app_subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  require_all "remove host app established" OUTPUT -d "$app_subnet" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  require_all "remove app drop" DOCKER-USER -d "$app_subnet" -j DROP
  require_all "remove host app drop" OUTPUT -d "$app_subnet" -j DROP
  require_all "remove internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  require_all "remove internal drop" DOCKER-USER -d "$subnet" -j DROP
  require_all "remove host internal drop" OUTPUT -d "$subnet" -j DROP
  require_all "remove internal forward" DOCKER-FORWARD -i "$bridge" -j ACCEPT
  require_all "remove app forward" DOCKER-FORWARD -i "$app_bridge" -j ACCEPT
  ipv6_rules
  echo "removed host isolation for $subnet"
  exit 0
fi

if [ "$action" = verify ]; then
  echo "firewall-backends: $SELECTED"
  visible_all "internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  visible_all "internal drop" DOCKER-USER -d "$subnet" -j DROP
  visible_all "host internal drop" OUTPUT -d "$subnet" -j DROP
  visible_all "app subnet drop" DOCKER-USER -d "$app_subnet" -j DROP
  visible_all "host app subnet drop" OUTPUT -d "$app_subnet" -j DROP
  ipv6_rules
  exit 0
fi

if [ "$action" != apply ]; then
  echo "unsupported firewall action: $action" >&2
  exit 1
fi

apply_v4
ipv6_rules
echo "applied host isolation internal=$subnet app=$app_subnet"
