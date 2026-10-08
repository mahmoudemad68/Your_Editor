#!/bin/sh
# Called only after staging Environment review and Owner enablement.
set -eu
: "${STAGING_HOST:?}" "${STAGING_USER:?}" "${STAGING_PATH:?}" "${STAGING_SSH_KEY:?}" "${STAGING_KNOWN_HOSTS:?}" "${GITHUB_SHA:?}" "${GHCR_PULL_TOKEN:?}" "${GHCR_PULL_USER:?}"
python3 - <<'PY'
import os,re
for name,pattern in [('STAGING_HOST',r'[A-Za-z0-9][A-Za-z0-9.-]*'),('STAGING_USER',r'[a-z_][a-z0-9_-]*'),('STAGING_PATH',r'/[A-Za-z0-9_/-]+'),('GITHUB_SHA',r'[0-9a-f]{40}'),('GHCR_PULL_USER',r'[A-Za-z0-9_-]+')]:
 assert re.fullmatch(pattern,os.environ[name]), 'Invalid deployment configuration'
assert '..' not in os.environ['STAGING_PATH'].split('/'), 'Invalid deployment path'
PY
private=$(mktemp -d)
trap 'rm -rf "$private"' EXIT
printf '%s\n' "$STAGING_SSH_KEY" > "$private/key"
printf '%s\n' "$STAGING_KNOWN_HOSTS" > "$private/known_hosts"
chmod 600 "$private/key" "$private/known_hosts"
target="$STAGING_USER@$STAGING_HOST"
remote="$STAGING_PATH/releases/$GITHUB_SHA"
ssh -i "$private/key" -o UserKnownHostsFile="$private/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 "$target" "mkdir -p '$remote'"
scp -i "$private/key" -o UserKnownHostsFile="$private/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 release-bundle.tar.gz "$target:$remote/bundle.tar.gz"
printf '%s' "$GHCR_PULL_TOKEN" | ssh -i "$private/key" -o UserKnownHostsFile="$private/known_hosts" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10 "$target" "tar -xzf '$remote/bundle.tar.gz' -C '$remote' && python3 '$remote/infra/scripts/staging_release.py' deploy --root '$STAGING_PATH' --release-dir '$remote' --registry-user '$GHCR_PULL_USER'"
