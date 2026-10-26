#!/bin/sh
# Same committed conformance cases against the actual deployed modules. No paid
# call, mounted credentials, external network or production planner enablement.
set -eu
image="$1"
mkdir -p .local/agent-provider-image
python3 - <<'PY'
from pathlib import Path
source = Path('packages/agent-core/src/provider.test.ts').read_text()
for name in ('provider-http', 'provider-replay', 'provider'):
    source = source.replace(f'"./{name}.js"', '"@editagent/agent-core"')
Path('.local/agent-provider-image/provider.test.ts').write_text(source)
PY
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 10001:10001 \
  --memory 256m --memory-swap 256m --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777 \
  --mount "type=bind,src=$(pwd)/.local/agent-provider-image/provider.test.ts,dst=/app/provider-image.test.ts,readonly" \
  --entrypoint node "$image" --experimental-strip-types --test /app/provider-image.test.ts
printf '%s\n' 'PACKAGED_PROVIDER_CONFORMANCE PASS: offline HTTP adapters and deterministic replay; no live qualification'
