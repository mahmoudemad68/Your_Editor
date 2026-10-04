#!/bin/sh
# Boot the checked-in unit under an isolated systemd PID 1.
# This host's PID 1 is not systemd, so the probe uses a privileged container.
# It does not start the host Docker daemon and does not deploy staging.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
name=editagent-us113-systemd
image=editagent-systemd-boot:us113
approved="chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
placeholder="example.invalid/image@sha256:abababababababababababababababababababababababababababababababab"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -t "$image" - <<'EOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv nodejs python3 ca-certificates sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/lib/systemd/systemd /sbin/init \
    && if [ ! -e /usr/bin/node ] && [ -x /usr/bin/nodejs ]; then ln -sf /usr/bin/nodejs /usr/bin/node; fi
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
fi

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  "$image" >/dev/null

ready=0
i=0
while [ "$i" -lt 40 ]; do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in
    running | degraded)
      ready=1
      break
      ;;
  esac
  i=$((i + 1))
  sleep 1
done
if [ "$ready" != "1" ]; then
  docker logs "$name" >&2 || true
  echo "systemd-boot: isolated systemd did not become ready" >&2
  exit 1
fi

docker exec "$name" mkdir -p /opt/editagent/infra/seaweedfs /opt/editagent/infra/scripts
docker cp "$ROOT/infra/seaweedfs/secure-up.sh" "$name":/opt/editagent/infra/seaweedfs/secure-up.sh
docker cp "$ROOT/infra/seaweedfs/evaluate-bootstrap-probe.sh" "$name":/opt/editagent/infra/seaweedfs/evaluate-bootstrap-probe.sh
docker cp "$ROOT/infra/seaweedfs/prepare-secrets.sh" "$name":/opt/editagent/infra/seaweedfs/prepare-secrets.sh
docker cp "$ROOT/infra/seaweedfs/install-host-isolation.sh" "$name":/opt/editagent/infra/seaweedfs/install-host-isolation.sh
docker cp "$ROOT/infra/seaweedfs/editagent-secure-up.service" "$name":/etc/systemd/system/editagent-secure-up.service
docker cp "$ROOT/infra/scripts/staging-preflight.sh" "$name":/opt/editagent/infra/scripts/staging-preflight.sh
docker cp "$ROOT/infra/scripts/image-digest.mjs" "$name":/opt/editagent/infra/scripts/image-digest.mjs
docker cp "$ROOT/compose.staging.yaml" "$name":/opt/editagent/compose.staging.yaml
docker exec "$name" chmod 755 \
  /opt/editagent/infra/seaweedfs/secure-up.sh \
  /opt/editagent/infra/seaweedfs/evaluate-bootstrap-probe.sh \
  /opt/editagent/infra/seaweedfs/prepare-secrets.sh \
  /opt/editagent/infra/seaweedfs/install-host-isolation.sh \
  /opt/editagent/infra/scripts/staging-preflight.sh
docker exec "$name" sh -c 'cat > /etc/systemd/system/docker.service <<EOF
[Unit]
Description=Stub Docker for the boot probe
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
EOF'
docker exec "$name" systemctl daemon-reload
docker exec "$name" systemctl start docker.service

env_body="EDITAGENT_API_IMAGE=${placeholder}
EDITAGENT_WEB_IMAGE=${placeholder}
EDITAGENT_MEDIA_WORKER_IMAGE=${placeholder}
EDITAGENT_RENDER_WORKER_IMAGE=${placeholder}
EDITAGENT_AGENT_WORKER_IMAGE=${placeholder}
EDITAGENT_AI_WORKER_IMAGE=${placeholder}
EDITAGENT_OBJECT_INGRESS_IMAGE=${placeholder}
EDITAGENT_POSTGRES_IMAGE=${placeholder}
EDITAGENT_REDIS_IMAGE=${placeholder}
EDITAGENT_SEAWEEDFS_IMAGE=${approved}
S3_ACCESS_KEY_ID=staging-access
S3_SECRET_ACCESS_KEY=staging-secret-not-default
"

if docker exec "$name" systemctl start editagent-secure-up.service; then
  echo "systemd-boot: missing environment file started the unit" >&2
  exit 1
fi
missing_journal=$(docker exec "$name" journalctl -u editagent-secure-up.service --no-pager)
if printf '%s\n' "$missing_journal" | grep -q 'secure-up-invoked'; then
  echo "systemd-boot: secure-up ran without an environment file" >&2
  printf '%s\n' "$missing_journal" >&2
  exit 1
fi
if ! printf '%s\n' "$missing_journal" | grep -q 'Failed to load environment files'; then
  echo "systemd-boot: missing environment file did not fail in systemd" >&2
  printf '%s\n' "$missing_journal" >&2
  exit 1
fi
printf '%s\n' "$missing_journal" | grep 'Failed to load environment files' | sed 's/^/systemd-boot: journal /'
echo "systemd-boot: missing-env=unit-failed-before-exec"

printf '%s' "$env_body" | docker exec -i "$name" sh -c 'umask 022; cat > /opt/editagent/staging.env; chmod 644 /opt/editagent/staging.env'
docker exec "$name" systemctl reset-failed editagent-secure-up.service || true
if docker exec "$name" systemctl start editagent-secure-up.service; then
  echo "systemd-boot: mode 0644 environment file was accepted" >&2
  exit 1
fi
loose_journal=$(docker exec "$name" journalctl -u editagent-secure-up.service --no-pager)
printf '%s\n' "$loose_journal" | grep -q '0600 or 0400'
if printf '%s\n' "$loose_journal" | grep -q 'staging-env-loaded'; then
  echo "systemd-boot: readable environment file reached secret validation" >&2
  exit 1
fi
printf '%s\n' "$loose_journal" | grep '0600 or 0400' | sed 's/^/systemd-boot: journal /'
echo "systemd-boot: readable-env=fail-closed"

docker exec "$name" chmod 600 /opt/editagent/staging.env
docker exec "$name" systemctl reset-failed editagent-secure-up.service || true
if docker exec "$name" systemctl start editagent-secure-up.service; then
  echo "systemd-boot: valid environment started services without docker" >&2
  exit 1
fi
valid_journal=$(docker exec "$name" journalctl -u editagent-secure-up.service --no-pager)
printf '%s\n' "$valid_journal" | grep -q 'staging-env-loaded'
printf '%s\n' "$valid_journal" | grep -q 'docker is not available'
printf '%s\n' "$valid_journal" | grep -E 'secure-up-invoked|staging-env-loaded|docker is not available' | sed 's/^/systemd-boot: journal /'
echo "systemd-boot: valid-env=loaded-and-fail-closed"
echo "systemd-boot: services-started=no"
echo "systemd-boot: pass"
