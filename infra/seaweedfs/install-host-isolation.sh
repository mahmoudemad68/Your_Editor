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

require_effective_backend() {
  if [ -n "${EDITAGENT_FIREWALL_BIN_DIR:-}" ]; then
    return 0
  fi
  driver=$(docker info --format '{{.FirewallBackend.Driver}}' 2>/dev/null || true)
  if [ "$driver" != "iptables" ]; then
    echo "unsupported firewall: docker firewall backend is '${driver:-unknown}', expected iptables" >&2
    exit 1
  fi
  resolved=$(readlink -f /usr/sbin/iptables 2>/dev/null || readlink -f /sbin/iptables || true)
  case "$resolved" in
    *nft*) name=iptables-nft ;;
    *legacy*) name=iptables-legacy ;;
    *)
      echo "unsupported firewall: docker iptables resolves to ${resolved:-missing}" >&2
      exit 1
      ;;
  esac
  if ! EFFECTIVE=$(find_bin "$name"); then
    echo "unsupported firewall: effective backend $name is not installed" >&2
    exit 1
  fi
  case " $SELECTED " in
    *" $EFFECTIVE "*) ;;
    *)
      echo "unsupported firewall: docker uses $EFFECTIVE but Docker chains are absent there" >&2
      exit 1
      ;;
  esac
  echo "firewall-backend-effective: $EFFECTIVE driver=$driver"
}

assert_ipv4_forward() {
  tool=$1
  run_bin "$tool" -S FORWARD | python3 -c '
import sys
lines = [line for line in sys.stdin.read().splitlines() if line.startswith("-A ")]
if not lines or lines[0] != "-A FORWARD -j DOCKER-USER":
    sys.exit("IPv4 FORWARD does not reach DOCKER-USER before other rules")
print("ipv4-forward-ok")
'
}

assert_ipv6_order() {
  tool=$1
  chain=$2
  export BRIDGE="$bridge" APP_BRIDGE="$app_bridge" CHAIN="$chain"
  run_bin "$tool" -S "$chain" | python3 -c '
import os, sys
lines = [line for line in sys.stdin.read().splitlines() if line.startswith("-A ")]
chain = os.environ["CHAIN"]
ifaces = [os.environ["BRIDGE"], os.environ["APP_BRIDGE"]]
directions = ["-i", "-o"] if chain == "FORWARD" else ["-o"]
for iface in ifaces:
    for direction in directions:
        drop_at = -1
        for index, line in enumerate(lines):
            if f"{direction} {iface}" in line and "-j DROP" in line:
                drop_at = index
                break
        if drop_at < 0:
            sys.exit(f"IPv6 {chain} is missing DROP for {direction} {iface}")
        for line in lines[:drop_at]:
            if f"{direction} {iface}" in line and ("-j ACCEPT" in line or "-j RETURN" in line):
                sys.exit(f"IPv6 {chain} accepts {iface} before DROP")
print(f"ipv6-order-ok {chain}")
'
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
    if [ "$action" = verify ]; then
      assert_ipv6_order "$tool" FORWARD
      assert_ipv6_order "$tool" OUTPUT
    fi
  done
  if [ "$action" = verify ]; then
    echo "ipv6-policy: drop"
  fi
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

assert_order() {
  tool=$1
  chain=$2
  export SUBNET="$subnet" BRIDGE="$bridge" APP_SUBNET="$app_subnet" PUBLISHED="$PUBLISHED" CHAIN="$chain"
  run_bin "$tool" -S "$chain" | python3 -c '
import os, sys
lines = [line for line in sys.stdin.read().splitlines() if line.startswith("-A ")]
subnet = os.environ["SUBNET"]
bridge = os.environ["BRIDGE"]
app = os.environ["APP_SUBNET"]
published = os.environ["PUBLISHED"].split()
chain = os.environ["CHAIN"]
accept = "RETURN" if chain == "DOCKER-USER" else "ACCEPT"

def first(predicate):
    for index, line in enumerate(lines):
        if predicate(line):
            return index
    return -1

if chain == "DOCKER-USER":
    internal_return = first(lambda line: f"-d {subnet}" in line and f"-i {bridge}" in line and "-j RETURN" in line)
    internal_drop = first(lambda line: f"-d {subnet}" in line and "-i " not in line and "-j DROP" in line)
    if internal_return < 0 or internal_drop < 0 or internal_return > internal_drop:
        sys.exit(f"{chain}: internal RETURN must precede the subnet DROP")
    for line in lines[:internal_drop]:
        if "-j ACCEPT" not in line and "-j RETURN" not in line:
            continue
        if f"-d {subnet}" not in line and " -d " in line:
            continue
        if f"-d {subnet}" in line and f"-i {bridge}" in line:
            continue
        sys.exit(f"{chain}: a rule before the internal DROP can expose that subnet through another bridge: {line}")
else:
    internal_drop = first(lambda line: f"-d {subnet}" in line and "-j DROP" in line)
    if internal_drop < 0:
        sys.exit(f"{chain}: host DROP for the internal subnet is missing")
app_drop = first(lambda line: f"-d {app}" in line and "-j DROP" in line and "--dport" not in line and "conntrack" not in line)
established = first(lambda line: f"-d {app}" in line and "conntrack" in line and f"-j {accept}" in line)
if app_drop < 0 or established < 0 or established > app_drop:
    sys.exit(f"{chain}: established traffic must precede the application subnet DROP")
for port in published:
    allowed = first(lambda line, port=port: f"-d {app}" in line and f"--dport {port}" in line and f"-j {accept}" in line)
    if allowed < 0 or allowed > app_drop:
        sys.exit(f"{chain}: published port {port} must precede the application subnet DROP")
print(f"order-ok {chain}")
'
}

drop_packets() {
  tool=$1
  run_bin "$tool" -nvx -L OUTPUT | awk -v subnet="$subnet" '
    $3 == "DROP" && $9 == subnet { sum += $1; found = 1 }
    END { print sum + 0 }
  '
}

if [ "$action" = "drop-count" ]; then
  total=0
  for tool in $SELECTED; do
    count=$(drop_packets "$tool")
    echo "$tool $count"
    total=$((total + count))
  done
  echo "total $total"
  exit 0
fi

if [ "$action" = verify ]; then
  require_effective_backend
  echo "firewall-backends: $SELECTED"
  for tool in $SELECTED; do
    assert_ipv4_forward "$tool"
  done
  visible_all "internal return" DOCKER-USER -d "$subnet" -i "$bridge" -j RETURN
  visible_all "internal drop" DOCKER-USER -d "$subnet" -j DROP
  visible_all "host internal drop" OUTPUT -d "$subnet" -j DROP
  visible_all "app subnet drop" DOCKER-USER -d "$app_subnet" -j DROP
  visible_all "host app subnet drop" OUTPUT -d "$app_subnet" -j DROP
  for port in $PUBLISHED; do
    visible_all "published $port" OUTPUT -d "$app_subnet" -p tcp --dport "$port" -j ACCEPT
    visible_all "forward $port" DOCKER-USER -d "$app_subnet" -p tcp --dport "$port" -j RETURN
  done
  for tool in $SELECTED; do
    assert_order "$tool" DOCKER-USER
    assert_order "$tool" OUTPUT
  done
  ipv6_rules
  exit 0
fi

if [ "$action" != apply ]; then
  echo "unsupported firewall action: $action" >&2
  exit 1
fi

require_effective_backend
apply_v4
ipv6_rules
echo "applied host isolation internal=$subnet app=$app_subnet"
