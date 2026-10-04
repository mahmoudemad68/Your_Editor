#!/bin/sh
# Images built from Dockerfiles that compose.yaml on main already references.
# Object ingress, a rebuilt Postgres image, and SeaweedFS are not on main.
printf '%s\n' \
  api \
  web \
  media-worker \
  render-worker \
  agent-worker \
  ai-worker \
  minio
