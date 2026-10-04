#!/bin/sh
# Idempotent host isolation for the SeaweedFS storage subnet.
#
# Same-subnet container traffic stays open so Master, Volume, Filer, and the
# S3 gateway can reach each other. An unauthorized container on that subnet is
# rejected by mTLS, -disableHttp, and the volume IP whitelist. Packets from
# the Docker host and from other networks toward Master, Volume, and Filer are
# dropped. The published S3 port is the exception.
#
# Rules are installed on every iptables backend that currently owns DOCKER-USER.
# Docker 29 on a host that still has an iptables-legacy filter table does not
# program that table when it creates a bridge. A same-subnet ACCEPT is added
# there, after the DROP rules, so storage traffic is forwarded and still
# subject to this chain.
#
# Reboot and Docker restart: --install copies this script and enables a systemd
# oneshot plus a docker.service ExecStartPost. Without systemd, the rules last
# until Docker restarts; the next `make up` or CI run installs them again.
# `verify-trust-boundary.sh` fails closed when the DROP rules are absent.
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
subnet="$SEAWEED_SUBNET"
gateway="$SEAWEED_GATEWAY_IP"
s3="$SEAWEED_S3_IP"

backends=""
for candidate in iptables-nft iptables-legacy iptables; do
  if ! command -v "$candidate" >/dev/null 2>&1; then
    continue
  fi
  if "$candidate" -S DOCKER-USER >/dev/null 2>&1; then
    case " $backends " in
      *" $candidate "*) ;;
      *) backends="$backends $candidate" ;;
    esac
  fi
done
# `iptables` is often a symlink to one of the two backends already recorded.
resolved=""
for candidate in $backends; do
  target="$(readlink -f "$(command -v "$candidate")")"
  case " $resolved " in
    *" $target "*) ;;
    *) resolved="$resolved $target" ;;
  esac
done
if [ -z "$resolved" ]; then
  echo "DOCKER-USER is missing. Start Docker before installing storage isolation." >&2
  exit 1
fi

rule_present() {
  bin="$1"
  shift
  "$bin" -C "$@" >/dev/null 2>&1
}

apply_backend() {
  bin="$1"
  "$bin" -N "$chain" 2>/dev/null || true
  "$bin" -F "$chain"
  # Published S3 listener. docker-proxy connects here from the host.
  "$bin" -A "$chain" -d "$s3" -p tcp --dport 8333 -j RETURN
  # The bridge gateway is the host. It must not reach Master, Volume, or Filer.
  "$bin" -A "$chain" -s "$gateway" -d "$subnet" -j DROP
  # Remaining same-subnet flows are the storage containers, including an
  # unauthorized container. Application controls reject that container.
  "$bin" -A "$chain" -s "$subnet" -d "$subnet" -j RETURN
  "$bin" -A "$chain" -d "$subnet" -j DROP
  if ! rule_present "$bin" DOCKER-USER -j "$chain"; then
    "$bin" -I DOCKER-USER 1 -j "$chain"
  fi

  "$bin" -N "$out_chain" 2>/dev/null || true
  "$bin" -F "$out_chain"
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

check_backend() {
  bin="$1"
  rule_present "$bin" DOCKER-USER -j "$chain" || return 1
  rule_present "$bin" "$chain" -d "$subnet" -j DROP || return 1
  rule_present "$bin" "$chain" -s "$gateway" -d "$subnet" -j DROP || return 1
  rule_present "$bin" OUTPUT -j "$out_chain" || return 1
  rule_present "$bin" "$out_chain" -d "$subnet" -j DROP || return 1
  rule_present "$bin" "$out_chain" -d "$s3" -p tcp --dport 8333 -j RETURN || return 1
}

if [ "$check_only" -eq 1 ]; then
  for bin in $resolved; do
    if ! check_backend "$bin"; then
      echo "storage isolation rules are absent on $bin" >&2
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
echo "storage isolation installed"

if [ "$install_boot" -ne 1 ]; then
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo "systemd is not running. Isolation is active until Docker restarts; rerun this script after a restart." >&2
  exit 0
fi

lib_dir=/usr/local/lib/editagent
mkdir -p "$lib_dir" /etc/systemd/system/docker.service.d
cp "$root/infra/seaweedfs/apply-host-isolation.sh" "$lib_dir/apply-host-isolation.sh"
cp "$root/infra/seaweedfs/storage-network.env" "$lib_dir/storage-network.env"
chmod 755 "$lib_dir/apply-host-isolation.sh"
chmod 644 "$lib_dir/storage-network.env"

cat > /etc/systemd/system/editagent-storage-isolation.service <<EOF
[Unit]
Description=Reapply EditAgent SeaweedFS host isolation
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=$lib_dir/apply-host-isolation.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/docker.service.d/editagent-storage-isolation.conf <<EOF
[Service]
ExecStartPost=$lib_dir/apply-host-isolation.sh
EOF

systemctl daemon-reload
systemctl enable editagent-storage-isolation.service >/dev/null
echo "storage isolation boot hook installed"
