#!/bin/sh
# Restart and stale-marker checks for the container firewall.
# A previous startup id must not let weed listen in a new network namespace.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E "$0" "$@"
fi

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
. "$root/infra/seaweedfs/storage-network.env"
cd "$root"
image="${SEAWEED_IMAGE:-editagent-seaweedfs:local}"

fail() {
  echo "firewall lifecycle failed: $1" >&2
  exit 1
}

# Loopback reaches weed only after this process has started listening.
# An unauthorized container can be dropped by the host firewall, so it cannot
# prove whether weed itself is up.
local_status() {
  docker exec editagent-seaweed-volume \
    curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8080/status || true
}

outside_status() {
  docker run --rm --network "${COMPOSE_PROJECT_NAME:-editagent}_storage_internal" \
    --entrypoint sh "$image" -c \
    "curl -s -o /tmp/b -w '%{http_code}' --max-time 3 http://${SEAWEED_VOLUME_IP}:8080/status || true"
}

code="$(outside_status)"
if [ "$code" = "200" ]; then
  fail "normal startup exposed volume status"
fi
echo "normal-startup status=$code"

docker exec editagent-seaweed-volume touch /tmp/firewall.ready
docker exec editagent-seaweed-volume sh -c 'mkdir -p /tmp/editagent-startup; printf "%s\n" "stale 1" >/tmp/editagent-startup/ack'
docker restart editagent-seaweed-volume >/dev/null
sleep 2
code="$(local_status)"
if [ "$code" = "200" ]; then
  fail "docker restart reused readiness from the previous namespace"
fi
echo "docker-restart local=$code"
./infra/seaweedfs/apply-container-firewall.sh >/dev/null
i=0
health="starting"
while [ "$i" -lt 40 ]; do
  health="$(docker inspect -f '{{.State.Health.Status}}' editagent-seaweed-volume 2>/dev/null || echo missing)"
  if [ "$health" = "healthy" ]; then
    break
  fi
  i=$((i + 1))
  sleep 2
done
if [ "$health" != "healthy" ]; then
  fail "volume did not become healthy after the installer acknowledged the new namespace"
fi
code="$(outside_status)"
if [ "$code" = "200" ]; then
  fail "rearmed volume exposed status"
fi
echo "restart-rearmed status=$code"

docker kill editagent-seaweed-volume >/dev/null
docker start editagent-seaweed-volume >/dev/null
sleep 2
code="$(local_status)"
if [ "$code" = "200" ]; then
  fail "kill/start opened volume status before acknowledgement"
fi
echo "kill-start local=$code"
./infra/seaweedfs/rearm-storage.sh >/dev/null
code="$(outside_status)"
if [ "$code" = "200" ]; then
  fail "kill/start rearm exposed volume status"
fi
echo "kill-start-rearmed status=$code"

docker compose stop seaweed-volume >/dev/null
./infra/seaweedfs/rearm-storage.sh >/dev/null
code="$(outside_status)"
if [ "$code" = "200" ]; then
  fail "compose stop/start exposed volume status"
fi
echo "compose-stop-rearm status=$code"

# Disposable network. Host rules for 172.30.210.0/24 do not apply here.
disposable="editagent-fw-disposable"
docker rm -f fw-listen fw-nonce >/dev/null 2>&1 || true
docker network rm "$disposable" >/dev/null 2>&1 || true
docker network create --subnet 172.30.211.0/24 "$disposable" >/dev/null
docker run -d --name fw-listen --network "$disposable" --ip 172.30.211.10 \
  --entrypoint sleep "$image" infinity >/dev/null
docker exec -d fw-listen sh -c 'while true; do printf "HTTP/1.0 200 OK\r\n\r\nstatus-body\n" | nc -l -p 8080; done'
sleep 0.5
open_report="$(docker run --rm --network "$disposable" --ip 172.30.211.20 --entrypoint sh "$image" -c \
  'code=$(curl -s -o /tmp/b -w "%{http_code}" --max-time 3 http://172.30.211.10:8080/ || true); leak=0; if grep -q status-body /tmp/b 2>/dev/null; then leak=1; fi; printf "%s %s" "$code" "$leak"')"
# Install only the container input drop. No host DOCKER-USER rule is added for this subnet.
listen_pid="$(docker inspect -f '{{.State.Pid}}' fw-listen)"
nsenter -t "$listen_pid" -n iptables-nft -N SEAWEED-IN 2>/dev/null || true
nsenter -t "$listen_pid" -n iptables-nft -F SEAWEED-IN
nsenter -t "$listen_pid" -n iptables-nft -A SEAWEED-IN -i lo -j ACCEPT
nsenter -t "$listen_pid" -n iptables-nft -A SEAWEED-IN -p tcp --dport 8080 -j DROP
nsenter -t "$listen_pid" -n iptables-nft -C INPUT -j SEAWEED-IN >/dev/null 2>&1 \
  || nsenter -t "$listen_pid" -n iptables-nft -I INPUT 1 -j SEAWEED-IN
drop_report="$(docker run --rm --network "$disposable" --ip 172.30.211.20 --entrypoint sh "$image" -c \
  'code=$(curl -s -o /tmp/b -w "%{http_code}" --max-time 3 http://172.30.211.10:8080/ || true); leak=0; if grep -q status-body /tmp/b 2>/dev/null; then leak=1; fi; printf "%s %s" "$code" "$leak"')"
echo "disposable-bridge open=$open_report filtered=$drop_report"
case "$open_report" in
  *" 1")
    case "$drop_report" in
      *" 1") fail "container input rule did not hide the status body" ;;
    esac
    ;;
esac
case "$drop_report" in
  *" 1") fail "container input rule exposed a status body with no host filter" ;;
esac

docker rm -f fw-nonce >/dev/null 2>&1 || true
docker run -d --name fw-nonce --network "$disposable" --ip 172.30.211.11 \
  -e EDITAGENT_FIREWALL_WAIT_SECONDS=4 \
  --entrypoint /usr/local/bin/editagent-entrypoint.sh \
  "$image" version >/dev/null
sleep 0.4
docker exec fw-nonce touch /tmp/firewall.ready
docker exec fw-nonce sh -c 'mkdir -p /tmp/editagent-startup; printf "%s\n" "stale 1" >/tmp/editagent-startup/ack'
sleep 1
running="$(docker inspect -f '{{.State.Running}}' fw-nonce)"
if [ "$running" != "true" ]; then
  fail "a stale marker allowed the entrypoint to finish"
fi
# Installer exits before acknowledgement: rules may exist, weed must not start.
nonce_pid="$(docker inspect -f '{{.State.Pid}}' fw-nonce)"
nsenter -t "$nonce_pid" -n iptables-nft -N SEAWEED-IN 2>/dev/null || true
nsenter -t "$nonce_pid" -n iptables-nft -F SEAWEED-IN
nsenter -t "$nonce_pid" -n iptables-nft -A SEAWEED-IN -i lo -j ACCEPT
nsenter -t "$nonce_pid" -n iptables-nft -C INPUT -j SEAWEED-IN >/dev/null 2>&1 \
  || nsenter -t "$nonce_pid" -n iptables-nft -I INPUT 1 -j SEAWEED-IN
sleep 1
running="$(docker inspect -f '{{.State.Running}}' fw-nonce)"
if [ "$running" != "true" ]; then
  fail "weed started after the installer stopped before acknowledgement"
fi
echo "installer-abort still-waiting=1"
sleep 4
exited="$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' fw-nonce)"
case "$exited" in
  "false 1") ;;
  *) fail "preflight timeout did not fail closed ($exited)" ;;
esac

set +e
docker run --rm --user 1000 --entrypoint /usr/local/bin/editagent-entrypoint.sh "$image" version >/dev/null 2>&1
nonroot=$?
set -e
if [ "$nonroot" = "0" ]; then
  fail "non-root startup bypassed the firewall preflight"
fi
echo "non-root-startup exit=$nonroot"

docker rm -f fw-listen fw-nonce >/dev/null 2>&1 || true
docker network rm "$disposable" >/dev/null 2>&1 || true
echo "firewall lifecycle holds"
