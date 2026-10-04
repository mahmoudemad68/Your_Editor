#!/bin/sh
# Images built from Dockerfiles that compose.yaml references.
# Object ingress and SeaweedFS are not in this tree.
printf '%s\n' \
  api \
  web \
  media-worker \
  render-worker \
  agent-worker \
  ai-worker \
  minio \
  postgres \
  redis
