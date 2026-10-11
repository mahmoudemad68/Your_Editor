#!/bin/sh
# Images built from Dockerfiles that compose.yaml references.
# Object ingress is not in this tree.
printf '%s\n' \
  api \
  web \
  media-worker \
  render-worker \
  render-executor \
  agent-worker \
  ai-worker \
  seaweedfs \
  postgres \
  redis
