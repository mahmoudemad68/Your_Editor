#!/bin/sh
# Restart an isolated dockerd and record restart-policy behavior.
# The host daemon is left running so unrelated stacks stay up.
# EditAgent compose files set restart "no", which must stay stopped.
set -eu

name=editagent-us113-dind
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f "$name" >/dev/null 2>&1 || true
started=0
i=0
while [ "$i" -lt 5 ]; do
  if docker run -d --name "$name" --privileged -e DOCKER_DRIVER=vfs docker:29-dind >/dev/null; then
    started=1
    break
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  i=$((i + 1))
  sleep 2
done
if [ "$started" != "1" ]; then
  echo "docker-restart: could not start the isolated daemon" >&2
  exit 1
fi

i=0
while [ "$i" -lt 60 ]; do
  if docker exec "$name" docker info >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
docker exec "$name" docker info >/dev/null

docker exec "$name" docker pull busybox:1.36 >/dev/null
docker exec "$name" docker run -d --name stay-down --restart=no busybox:1.36 sleep 180 >/dev/null
docker exec "$name" docker run -d --name come-back --restart=always busybox:1.36 sleep 180 >/dev/null
before_down=$(docker exec "$name" docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' stay-down)
before_up=$(docker exec "$name" docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' come-back)
echo "docker-restart: before stay-down=$before_down come-back=$before_up"

docker restart "$name" >/dev/null
i=0
while [ "$i" -lt 60 ]; do
  if docker exec "$name" docker info >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
docker exec "$name" docker info >/dev/null

after_down=$(docker exec "$name" docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' stay-down)
after_up=$(docker exec "$name" docker inspect -f '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}' come-back)
echo "docker-restart: after stay-down=$after_down come-back=$after_up"
if [ "$after_down" != "false no" ]; then
  echo "docker-restart: restart=no container was running after dockerd restarted" >&2
  exit 1
fi
if [ "$after_up" != "true always" ]; then
  echo "docker-restart: restart=always container did not return, so the daemon restart was not effective" >&2
  exit 1
fi
echo "docker-restart: pass"
