#!/bin/sh
# Images that must pass Trivy before any registry publish.
printf '%s\n' \
  api \
  web \
  media-worker \
  render-worker \
  agent-worker \
  ai-worker \
  minio \
  object-ingress
