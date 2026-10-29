#!/bin/sh
# Replace each SeaweedFS data directory from a stopped backup.
# A restore merges nothing: the directory is cleared, then the archive is extracted.
# The historical MinIO volume is not mounted and not deleted.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$root"
image="$("$root/infra/seaweedfs/image-reference.sh" live)"
source_dir="${1:?backup directory is required}"
project="${COMPOSE_PROJECT_NAME:-editagent}"

# Validate EVERY archive before stopping/deleting any data. No partial restore
# after a missing, corrupt, traversal or link-bearing input.
python3 - "$source_dir" <<'PY'
import sys,tarfile,posixpath,hashlib,re
from pathlib import Path
source=Path(sys.argv[1])
manifest=(source/'SHA256SUMS').read_text().splitlines()
expected={f'seaweed-{r}.tar' for r in ['master','volume','filer']}
checks={}
for line in manifest:
    match=re.fullmatch(r'([a-f0-9]{64})  (seaweed-(?:master|volume|filer)\.tar)',line)
    if not match or match[2] in checks: raise ValueError('invalid snapshot checksum manifest')
    checks[match[2]]=match[1]
if set(checks)!=expected: raise ValueError('incomplete snapshot manifest')
for name,digest in checks.items():
    archive=source/name
    if archive.is_symlink(): raise ValueError('snapshot archive is a symlink')
    h=hashlib.sha256()
    with archive.open('rb') as f:
        while chunk:=f.read(1048576): h.update(chunk)
    if h.hexdigest()!=digest: raise ValueError('corrupt snapshot')
for role in ['master','volume','filer']:
    with tarfile.open(Path(sys.argv[1])/f'seaweed-{role}.tar','r:') as t:
        names=set()
        for m in t:
            name=posixpath.normpath(m.name)
            if name.startswith('/') or name=='..' or name.startswith('../') or name in names or not(m.isfile() or m.isdir()): raise ValueError('unsafe restore archive')
            names.add(name)
PY

docker compose stop seaweed-master seaweed-volume seaweed-filer seaweed-s3
for volume in seaweed-master seaweed-volume seaweed-filer; do
  archive="$source_dir/${volume}.tar"
  test -s "$archive"
  name="${project}_${volume}"
  docker run --rm --entrypoint sh -v "${name}:/data" -v "$archive:/backup.tar:ro" \
    "$image" \
    -c 'set -eu; find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar -C /data -xf /backup.tar'
done
./infra/seaweedfs/rearm-storage.sh
echo "seaweedfs volumes restored from $source_dir"
