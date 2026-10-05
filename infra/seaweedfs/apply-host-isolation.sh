#!/bin/sh
# Idempotent host isolation for the SeaweedFS storage subnet.
#
# SeaweedFS 4.48 serves Volume GET /status with no whitelist and no JWT.
# Same-subnet packets are therefore not left open. Only the four storage
# addresses may open Master, Volume, and Filer. Replies use conntrack.
# The published S3 port is the exception. IPv6 on the storage bridge is
# dropped, because the volume process also listens on ::.
#
# Rules are installed before containers start. Storage services use
# restart: "no", so Docker does not bring them up before this script runs.
# --install enables a systemd unit and a docker.service ExecStartPost when
# systemd is running. Without systemd the script exits 3 and does not claim
# reboot persistence. A missing iptables backend exits 1.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
env_file="$root/infra/seaweedfs/storage-network.env"
if [ ! -f "$env_file" ]; then
  env_file=/usr/local/lib/editagent/storage-network.env
fi
# shellcheck disable=SC1091
. "$env_file"

install_boot=0
check_only=0
for arg in "$@"; do
  case "$arg" in
    --install) install_boot=1 ;;
    --check) check_only=1 ;;
    *)
      echo "usage: $0 [--install|--check]" >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E "$0" "$@"
fi

chain=EDITAGENT-STORAGE
out_chain=EDITAGENT-STORAGE-OUT
v6_chain=EDITAGENT-STORAGE6
v6_out=EDITAGENT-STORAGE6-OUT
subnet="$SEAWEED_SUBNET"
s3="$SEAWEED_S3_IP"
master="$SEAWEED_MASTER_IP"
volume="$SEAWEED_VOLUME_IP"
filer="$SEAWEED_FILER_IP"
project="${COMPOSE_PROJECT_NAME:-editagent}"

resolved=""
for candidate in iptables-nft iptables-legacy; do
  if ! command -v "$candidate" >/dev/null 2>&1; then
    continue
  fi
  if "$candidate" -S DOCKER-USER >/dev/null 2>&1; then
    resolved="$resolved $candidate"
  fi
done
if [ -z "$resolved" ] && command -v iptables >/dev/null 2>&1; then
  if iptables -S DOCKER-USER >/dev/null 2>&1; then
    resolved="iptables"
  fi
fi
if [ -z "$resolved" ]; then
  echo "DOCKER-USER is missing. Start Docker before installing storage isolation." >&2
  exit 1
fi

bridge=""
if docker network inspect "${project}_storage_internal" >/dev/null 2>&1; then
  net_id="$(docker network inspect -f '{{.Id}}' "${project}_storage_internal")"
  bridge="br-$(printf '%.12s' "$net_id")"
fi

rule_present() {
  bin="$1"
  shift
  "$bin" -C "$@" >/dev/null 2>&1
}

allow_tcp() {
  bin="$1"
  src="$2"
  dst="$3"
  port="$4"
  "$bin" -A "$chain" -s "$src" -d "$dst" -p tcp --dport "$port" -j RETURN
}

apply_backend() {
  bin="$1"
  "$bin" -N "$chain" 2>/dev/null || true
  "$bin" -F "$chain"
  "$bin" -A "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  # Published S3 listener, including docker-proxy from the host.
  "$bin" -A "$chain" -d "$s3" -p tcp --dport 8333 -j RETURN
  # Master gRPC and HTTPS from the roles that dial it.
  for src in "$volume" "$filer" "$s3"; do
    allow_tcp "$bin" "$src" "$master" 19333
    allow_tcp "$bin" "$src" "$master" 9333
  done
  # Volume HTTP and gRPC from the roles that store or allocate needles.
  for src in "$master" "$filer" "$s3"; do
    allow_tcp "$bin" "$src" "$volume" 8080
    allow_tcp "$bin" "$src" "$volume" 18080
  done
  # Filer HTTP and gRPC from S3 and master.
  for src in "$s3" "$master"; do
    allow_tcp "$bin" "$src" "$filer" 8888
    allow_tcp "$bin" "$src" "$filer" 18888
  done
  "$bin" -A "$chain" -d "$subnet" -j DROP
  if ! rule_present "$bin" DOCKER-USER -j "$chain"; then
    "$bin" -I DOCKER-USER 1 -j "$chain"
  fi

  "$bin" -N "$out_chain" 2>/dev/null || true
  "$bin" -F "$out_chain"
  "$bin" -A "$out_chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$bin" -A "$out_chain" -d "$s3" -p tcp --dport 8333 -j RETURN
  "$bin" -A "$out_chain" -d "$subnet" -j DROP
  if ! rule_present "$bin" OUTPUT -j "$out_chain"; then
    "$bin" -I OUTPUT 1 -j "$out_chain"
  fi

  # Legacy filter tables can drop a user-defined bridge that Docker programmed
  # only in nft. Accept same-subnet flows after DOCKER-USER has filtered them.
  if "$bin" -S DOCKER-FORWARD >/dev/null 2>&1; then
    if ! rule_present "$bin" DOCKER-FORWARD -s "$subnet" -d "$subnet" -j ACCEPT; then
      "$bin" -I DOCKER-FORWARD 1 -s "$subnet" -d "$subnet" -j ACCEPT
    fi
  fi
}

apply_ip6() {
  bin="$1"
  if ! "$bin" -S DOCKER-USER >/dev/null 2>&1; then
    echo "IPv6 DOCKER-USER is missing on $bin" >&2
    return 1
  fi
  "$bin" -N "$v6_chain" 2>/dev/null || true
  "$bin" -F "$v6_chain"
  if [ -n "$bridge" ]; then
    "$bin" -A "$v6_chain" -i "$bridge" -j DROP
    "$bin" -A "$v6_chain" -o "$bridge" -j DROP
  fi
  if ! rule_present "$bin" DOCKER-USER -j "$v6_chain"; then
    "$bin" -I DOCKER-USER 1 -j "$v6_chain"
  fi
  "$bin" -N "$v6_out" 2>/dev/null || true
  "$bin" -F "$v6_out"
  if [ -n "$bridge" ]; then
    "$bin" -A "$v6_out" -o "$bridge" -j DROP
  fi
  if ! rule_present "$bin" OUTPUT -j "$v6_out"; then
    "$bin" -I OUTPUT 1 -j "$v6_out"
  fi
}

check_backend() {
  bin="$1"
  rule_present "$bin" DOCKER-USER -j "$chain" || return 1
  rule_present "$bin" "$chain" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN || return 1
  rule_present "$bin" "$chain" -s "$s3" -d "$volume" -p tcp --dport 8080 -j RETURN || return 1
  rule_present "$bin" "$chain" -d "$subnet" -j DROP || return 1
  rule_present "$bin" OUTPUT -j "$out_chain" || return 1
  rule_present "$bin" "$out_chain" -d "$subnet" -j DROP || return 1
  rule_present "$bin" "$out_chain" -d "$s3" -p tcp --dport 8333 -j RETURN || return 1
  if "$bin" -S "$chain" | grep -q -- "-s $subnet -d $subnet -j RETURN"; then
    echo "storage isolation still allows the whole subnet on $bin" >&2
    return 1
  fi
}

check_ip6() {
  bin="$1"
  rule_present "$bin" DOCKER-USER -j "$v6_chain" || return 1
  if [ -z "$bridge" ]; then
    echo "storage bridge is missing; IPv6 isolation cannot be checked" >&2
    return 1
  fi
  rule_present "$bin" "$v6_chain" -i "$bridge" -j DROP || return 1
  rule_present "$bin" "$v6_chain" -o "$bridge" -j DROP || return 1
  rule_present "$bin" OUTPUT -j "$v6_out" || return 1
  rule_present "$bin" "$v6_out" -o "$bridge" -j DROP || return 1
}

ip6_bins=""
for candidate in ip6tables-nft ip6tables-legacy; do
  if ! command -v "$candidate" >/dev/null 2>&1; then
    continue
  fi
  if "$candidate" -S DOCKER-USER >/dev/null 2>&1; then
    ip6_bins="$ip6_bins $candidate"
  fi
done
if [ -z "$ip6_bins" ]; then
  echo "IPv6 iptables backend is missing." >&2
  exit 1
fi

if [ "$check_only" -eq 1 ]; then
  for bin in $resolved; do
    if ! check_backend "$bin"; then
      echo "storage isolation rules are absent on $bin" >&2
      exit 1
    fi
  done
  for bin in $ip6_bins; do
    if ! check_ip6 "$bin"; then
      echo "IPv6 storage isolation rules are absent on $bin" >&2
      exit 1
    fi
  done
  echo "storage isolation rules present"
  exit 0
fi

for bin in $resolved; do
  apply_backend "$bin"
  if ! check_backend "$bin"; then
    echo "storage isolation failed to install on $bin" >&2
    exit 1
  fi
done
for bin in $ip6_bins; do
  if ! apply_ip6 "$bin"; then
    echo "IPv6 storage isolation failed to install on $bin" >&2
    exit 1
  fi
  if [ -n "$bridge" ] && ! check_ip6 "$bin"; then
    echo "IPv6 storage isolation failed to install on $bin" >&2
    exit 1
  fi
done
if [ -z "$bridge" ]; then
  echo "storage bridge is not created yet; IPv6 interface drops are pending" >&2
  exit 1
fi
if command -v nft >/dev/null 2>&1; then
  if nft list chain ip6 filter DOCKER-USER >/dev/null 2>&1; then
    if ! nft list chain ip6 filter DOCKER-USER | grep -q EDITAGENT-STORAGE6; then
      echo "nft ip6 DOCKER-USER does not jump to the storage chain" >&2
      exit 1
    fi
  fi
fi
echo "storage isolation installed"

if [ "$install_boot" -ne 1 ]; then
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo "REBOOT_PERSISTENCE=UNVERIFIED" >&2
  echo "systemd is not running. Firewall rules are active for this boot only." >&2
  exit 3
fi

lib_dir=/usr/local/lib/editagent
mkdir -p "$lib_dir" /etc/systemd/system/docker.service.d
cp "$root/infra/seaweedfs/apply-host-isolation.sh" "$lib_dir/apply-host-isolation.sh"
cp "$root/infra/seaweedfs/start-storage.sh" "$lib_dir/start-storage.sh"
cp "$root/infra/seaweedfs/storage-network.env" "$lib_dir/storage-network.env"
printf '%s\n' "$root" >"$lib_dir/repo-root"
chmod 755 "$lib_dir/apply-host-isolation.sh" "$lib_dir/start-storage.sh"
chmod 644 "$lib_dir/storage-network.env" "$lib_dir/repo-root"

cat > /etc/systemd/system/editagent-storage-isolation.service <<EOF
[Unit]
Description=Start EditAgent SeaweedFS after host isolation
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=$lib_dir/start-storage.sh --from-boot
RemainAfterExit=yes
ExecStop=/usr/bin/docker compose --project-directory $root stop seaweed-s3 seaweed-filer seaweed-volume seaweed-master

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/docker.service.d/editagent-storage-isolation.conf <<EOF
[Service]
ExecStartPost=$lib_dir/start-storage.sh --from-boot
EOF

systemctl daemon-reload
systemctl enable editagent-storage-isolation.service >/dev/null
echo "storage isolation boot hook installed"
