#!/bin/sh
# Retired. Applying isolation after containers are already running is the
# fail-open window. Use infra/seaweedfs/secure-up.sh.
echo "refusing to isolate after startup; use infra/seaweedfs/secure-up.sh" >&2
exit 1
