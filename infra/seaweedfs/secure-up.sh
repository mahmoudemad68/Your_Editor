#!/bin/sh
# Fail-closed startup for development and staging.
# Host isolation is installed before any service is started.
# Failure stops services and does not delete volumes.
# `docker compose up` is not this path.
# Usage: secure-up.sh <compose-file> [-p project] [-- service...]
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

file=${1:?compose file}
shift
project_args=""
if [ "${1:-}" = "-p" ]; then
  project_args="-p ${2:?project name}"
  shift 2
fi
services=""
if [ "${1:-}" = "--" ]; then
  shift
  services="$*"
fi

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

APPROVED_SEAWEED_IMAGE="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"

log "secure-up-invoked"

if [ "$(id -u)" -ne 0 ]; then
  if [ ! -x /usr/bin/sudo ] || ! /usr/bin/sudo -n true >/dev/null 2>&1; then
    echo "unsupported firewall: root or non-interactive /usr/bin/sudo -n is required" >&2
    exit 1
  fi
fi

compose() {
  # shellcheck disable=SC2086
  docker compose -f "$file" $project_args "$@"
}

fail_closed() {
  echo "fail-closed: $*" >&2
  compose stop >/dev/null 2>&1 || true
  exit 1
}

if [ "$(basename "$file")" = "compose.staging.yaml" ]; then
  env_file=${EDITAGENT_ENV_FILE:-$ROOT/staging.env}
  if [ ! -f "$env_file" ]; then
    fail_closed "staging environment file is missing: $env_file"
  fi
  env_mode=$(stat -c '%a' "$env_file")
  case "$env_mode" in
    600 | 400) ;;
    *) fail_closed "staging environment file must be mode 0600 or 0400, found $env_mode" ;;
  esac
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  export SEAWEED_REQUIRE_S3_ENV=1
  if [ -z "${S3_ACCESS_KEY_ID:-}" ] || [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then
    fail_closed "staging S3 credentials are required"
  fi
  if [ "$S3_SECRET_ACCESS_KEY" = "editagent-dev-secret" ]; then
    fail_closed "staging refuses the development S3 secret"
  fi
  if [ "${EDITAGENT_SEAWEEDFS_IMAGE:-}" != "$APPROVED_SEAWEED_IMAGE" ]; then
    fail_closed "EDITAGENT_SEAWEEDFS_IMAGE must be the approved SeaweedFS digest"
  fi
  "$ROOT/infra/scripts/staging-preflight.sh" || fail_closed "staging preflight"
  log "staging-env-loaded"
fi

if ! docker info >/dev/null 2>&1; then
  echo "fail-closed: docker is not available" >&2
  exit 1
fi

if [ "$(basename "$file")" = "compose.staging.yaml" ]; then
  "$ROOT/infra/scripts/staging-preflight.sh" --compose || fail_closed "staging preflight"
fi

"$ROOT/infra/seaweedfs/prepare-secrets.sh" || fail_closed "secret preparation"

# Stop anything already running so a previous insecure start cannot stay up
# while the firewall is being replaced. stop does not delete volumes.
compose stop >/dev/null 2>&1 || true

# shellcheck disable=SC2086
if ! compose up --no-start $services; then
  fail_closed "could not create networks and containers"
fi

meta=$(compose config --format json | python3 -c '
import json, sys
doc = json.load(sys.stdin)
ports = set()
for service in doc.get("services", {}).values():
    for item in service.get("ports") or []:
        target = item.get("target")
        if target:
            ports.add(str(target))
try:
    internal = doc["networks"]["storage_internal"]
    application = doc["networks"]["default"]
except KeyError:
    sys.exit("compose project is missing storage_internal or the default network")
def subnet(network):
    return network["ipam"]["config"][0]["subnet"]
print(doc.get("name") or "")
print(internal.get("name") or "storage_internal")
print(subnet(internal))
print("1" if internal.get("internal") else "0")
print(application.get("name") or "default")
print(subnet(application))
print(",".join(sorted(ports)) or "-")
') || fail_closed "cannot read compose networks"
project=$(printf '%s\n' "$meta" | sed -n '1p')
internal=$(printf '%s\n' "$meta" | sed -n '2p')
internal_subnet_config=$(printf '%s\n' "$meta" | sed -n '3p')
internal_flag=$(printf '%s\n' "$meta" | sed -n '4p')
app_net=$(printf '%s\n' "$meta" | sed -n '5p')
app_subnet_config=$(printf '%s\n' "$meta" | sed -n '6p')
published=$(printf '%s\n' "$meta" | sed -n '7p')
if ! docker network inspect "$internal" >/dev/null 2>&1; then
  if [ "$internal_flag" = "1" ]; then
    docker network create --label com.docker.compose.project="$project" \
      --label com.docker.compose.network=storage_internal \
      --subnet "$internal_subnet_config" --ipv6=false --internal "$internal" ||
      fail_closed "could not create the internal network"
  else
    docker network create --label com.docker.compose.project="$project" \
      --label com.docker.compose.network=storage_internal \
      --subnet "$internal_subnet_config" --ipv6=false "$internal" ||
      fail_closed "could not create the internal network"
  fi
fi
if ! docker network inspect "$app_net" >/dev/null 2>&1; then
  docker network create --label com.docker.compose.project="$project" \
    --label com.docker.compose.network=default \
    --subnet "$app_subnet_config" --ipv6=false "$app_net" ||
    fail_closed "could not create the application network"
fi

for network in "$internal" "$app_net"; do
  enabled=$(docker network inspect "$network" --format '{{.EnableIPv6}}')
  if [ "$enabled" = "true" ]; then
    fail_closed "IPv6 is enabled on $network"
  fi
done

subnet=$(docker network inspect "$internal" --format '{{(index .IPAM.Config 0).Subnet}}')
app_subnet=$(docker network inspect "$app_net" --format '{{(index .IPAM.Config 0).Subnet}}')
internal_id=$(docker network inspect "$internal" --format '{{.Id}}')
app_id=$(docker network inspect "$app_net" --format '{{.Id}}')
bridge=br-$(printf '%s' "$internal_id" | cut -c 1-12)
app_bridge=br-$(printf '%s' "$app_id" | cut -c 1-12)

state_dir="$ROOT/.local"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
state_file="$state_dir/isolation-${project}.state"
if [ -f "$state_file" ]; then
  # shellcheck disable=SC1090
  . "$state_file"
  if [ "${saved_subnet:-}" != "$subnet" ] || [ "${saved_bridge:-}" != "$bridge" ] ||
    [ "${saved_app_subnet:-}" != "$app_subnet" ] || [ "${saved_app_bridge:-}" != "$app_bridge" ] ||
    [ "${saved_published:-}" != "$published" ]; then
    "$ROOT/infra/seaweedfs/install-host-isolation.sh" remove \
      "$saved_subnet" "$saved_bridge" "$saved_app_subnet" "$saved_app_bridge" \
      "${saved_published:--}" || fail_closed "could not remove the previous firewall policy"
  fi
fi

if ! "$ROOT/infra/seaweedfs/install-host-isolation.sh" apply \
  "$subnet" "$bridge" "$app_subnet" "$app_bridge" "$published"; then
  fail_closed "could not install host isolation"
fi
if ! "$ROOT/infra/seaweedfs/install-host-isolation.sh" verify \
  "$subnet" "$bridge" "$app_subnet" "$app_bridge" "$published"; then
  fail_closed "host isolation is not effective"
fi
log "isolation-verified internal=$subnet app=$app_subnet"

image="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
probe="editagent-iso-probe-$$"
if ! docker run -d --name "$probe" --network "$internal" --entrypoint nc "$image" \
  -l -p 8888 >/dev/null; then
  fail_closed "could not start the bootstrap probe"
fi
probe_ip=$(docker inspect "$probe" --format '{{(index .NetworkSettings.Networks "'"$internal"'").IPAddress}}')
if ! docker run --rm --network "$internal" --entrypoint nc "$image" -z -w 2 "$probe_ip" 8888; then
  docker rm -f "$probe" >/dev/null 2>&1 || true
  fail_closed "bootstrap listener was not reachable from the internal network"
fi
log "bootstrap-listener-open ip=$probe_ip"
before_drop=$("$ROOT/infra/seaweedfs/install-host-isolation.sh" drop-count "$subnet" "$bridge" "$app_subnet" "$app_bridge" "$published" | awk '/^total / { print $2 }')
probe_started=$(date +%s%3N)
probe_exit=0
probe_code=$(curl -sS -m 1 -o /dev/null -w '%{http_code}' "http://${probe_ip}:8888/") || probe_exit=$?
probe_finished=$(date +%s%3N)
after_drop=$("$ROOT/infra/seaweedfs/install-host-isolation.sh" drop-count "$subnet" "$bridge" "$app_subnet" "$app_bridge" "$published" | awk '/^total / { print $2 }')
docker rm -f "$probe" >/dev/null
log "bootstrap-host-blocked status=${probe_code:-000} curl_exit=${probe_exit} drops_before=${before_drop:-0} drops_after=${after_drop:-0} ip=$probe_ip started_ms=$probe_started finished_ms=$probe_finished"
"$ROOT/infra/seaweedfs/evaluate-bootstrap-probe.sh" \
  "$probe_exit" "${before_drop:-0}" "${after_drop:-0}" ||
  fail_closed "bootstrap probe did not prove firewall isolation"

unpublished=""
published_services=""
# shellcheck disable=SC2086
for service in ${services:-$(compose config --services)}; do
  count=$(compose config --format json | python3 -c '
import json, sys
doc = json.load(sys.stdin)
service = sys.argv[1]
print(len((doc.get("services") or {}).get(service, {}).get("ports") or []))
' "$service")
  if [ "$count" = "0" ]; then
    unpublished="$unpublished $service"
  else
    published_services="$published_services $service"
  fi
done

if [ -n "$unpublished" ]; then
  # shellcheck disable=SC2086
  compose start $unpublished || fail_closed "could not start internal services"
fi
log "internal-services-started"

if [ -n "$published_services" ]; then
  # shellcheck disable=SC2086
  compose start $published_services || fail_closed "could not start published services"
fi
log "published-services-started"

if ! "$ROOT/infra/seaweedfs/install-host-isolation.sh" verify \
  "$subnet" "$bridge" "$app_subnet" "$app_bridge" "$published"; then
  fail_closed "host isolation did not survive service start"
fi
log "isolation-reverified"

# shellcheck disable=SC2086
if ! compose up -d --no-build --wait --wait-timeout 300 $services; then
  fail_closed "services did not become healthy"
fi

umask 077
cat >"$state_file" <<EOF
saved_subnet=$subnet
saved_bridge=$bridge
saved_app_subnet=$app_subnet
saved_app_bridge=$app_bridge
saved_published=$published
EOF
chmod 600 "$state_file"

if [ "${EDITAGENT_INSTALL_BOOT_UNIT:-}" = "1" ] && [ -d /run/systemd/system ]; then
  unit=/etc/systemd/system/editagent-secure-up.service
  env_file=${EDITAGENT_ENV_FILE:-$ROOT/staging.env}
  if [ ! -f "$env_file" ]; then
    fail_closed "boot unit environment file is missing: $env_file"
  fi
  env_mode=$(stat -c '%a' "$env_file")
  case "$env_mode" in
    600 | 400) ;;
    *) fail_closed "boot unit environment file must be mode 0600 or 0400, found $env_mode" ;;
  esac
  unit_body="[Unit]
Description=EditAgent fail-closed startup
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
Environment=SEAWEED_REQUIRE_S3_ENV=1
Environment=EDITAGENT_ENV_FILE=$env_file
Environment=EDITAGENT_INSTALL_BOOT_UNIT=0
EnvironmentFile=$env_file
ExecStart=$ROOT/infra/seaweedfs/secure-up.sh $file
ExecStop=/usr/bin/docker compose -f $ROOT/$file stop

[Install]
WantedBy=multi-user.target"
  if [ "$(id -u)" -eq 0 ]; then
    printf '%s\n' "$unit_body" >"$unit"
    systemctl daemon-reload
    systemctl enable editagent-secure-up.service
  else
    printf '%s\n' "$unit_body" | /usr/bin/sudo -n tee "$unit" >/dev/null ||
      fail_closed "could not install the boot unit"
    /usr/bin/sudo -n systemctl daemon-reload
    /usr/bin/sudo -n systemctl enable editagent-secure-up.service
  fi
  log "boot-unit-installed"
fi

log "secure-up-complete"
