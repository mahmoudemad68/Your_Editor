#!/bin/sh
# Image names are selectors, never authorization. Every path inspects bytes.
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$root"
case "${1:-}" in
built)
  image="$(docker image inspect editagent-seaweedfs:local --format '{{.Id}}')"
  ;;
live)
  image=
  for role in seaweed-master seaweed-volume seaweed-filer seaweed-s3; do
    container="$(docker compose ps -aq "$role")"
    test -n "$container"
    actual="$(docker inspect --format '{{.Image}}' "$container")"
    if [ -n "$image" ] && [ "$image" != "$actual" ]; then
      echo 'storage roles do not share an immutable image' >&2; exit 1
    fi
    image="$actual"
  done
  ;;
*) echo 'usage: image-reference.sh built|live' >&2; exit 2 ;;
esac
[ "${#image}" -eq 71 ] || exit 1
printf '%s\n' "$image" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
# Authenticate archive/layers, the actual ELF and both build receipts before
# reading the immutable profile marker. This runs for BOTH selectors and does
# not depend on CI flags, tags, labels, matching locks or caller receipts.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sh infra/seaweedfs/verify-image.sh "$image" "$work" >&2
python3 - "$work/verify-image.json" "$root/infra/seaweedfs/security-build.lock.json" "$image" "$work/production-candidate" <<'PY' >&2
import hashlib,json,sys
from pathlib import Path

def unique(pairs):
    out={}
    for key,value in pairs:
        if key in out: raise ValueError('duplicate provenance field')
        out[key]=value
    return out

def require(ok,code='OPERATOR_IMAGE_PROVENANCE_INVALID'):
    if not ok: raise SystemExit(code)

try:
    raw=Path(sys.argv[1]).read_bytes();lock_bytes=Path(sys.argv[2]).read_bytes()
    require(len(raw)<=4*1024**2 and len(lock_bytes)<=1024**2)
    v=json.loads(raw,object_pairs_hook=unique);lock=json.loads(lock_bytes,object_pairs_hook=unique)
    require(v['image_id']==sys.argv[3] and v['lock_sha256']==hashlib.sha256(lock_bytes).hexdigest())
    require(all(v.get(k) is True for k in ('old_elf_absent','runtime_preserved','build_records_match_final_elf')))
    builds=[v['build_measurements'][name] for name in ('one','two')]
    require(all(b['elf_sha256']==v['elf_sha256'] and b['cache_initially_empty'] is True for b in builds))
    profile='seaweedfs-go-s-w-diagnostic-v1'
    flags='-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=ffa87c2+editagent-sec1 -s -w'
    expected={'schema_version':1,'profile':profile,'diagnostic_only':True,'elf_sha256':v['elf_sha256'],'flags_sha256':hashlib.sha256(flags.encode()).hexdigest(),'source_commit':'ffa87c25fdf587178b1521ad87f2a4a72a02e584','go_version':'go1.26.10'}
    marked=any('output_profile' in b or 'diagnostic_marker' in b or '-s' in b.get('elf',{}).get('linker_flags','') for b in builds)
    production='seaweedfs-go-s-w-production-candidate-v1'
    if lock['build'].get('output_profile')==production:
        require(lock['build'].get('diagnostic_only') is False,'OPERATOR_PROFILE_INCONSISTENT')
        K=hashlib.sha256(json.dumps(lock['build']['production_contract'],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        require(K==lock['build']['production_contract_sha256'],'OPERATOR_CONTRACT_DRIFT')
        for label,b in zip(('one','two'),builds):
            expected_pc={'schema_version':2,'trust_class':'production-candidate','profile':production,'build_contract_sha256':K,'lock_sha256':v['lock_sha256'],'elf_sha256':v['elf_sha256'],'flags_sha256':hashlib.sha256(flags.encode()).hexdigest(),'source_commit':'ffa87c25fdf587178b1521ad87f2a4a72a02e584','go_version':'go1.26.10','cache_label':label}
            require('diagnostic_marker' not in b and b.get('output_profile')==production and b.get('production_candidate_marker')==expected_pc,'OPERATOR_PRODUCTION_MARKER_INVALID')
        Path(sys.argv[4]).write_text('receipt-required')
    elif marked or 'output_profile' in lock['build'] or 'diagnostic_only' in lock['build']:
        require(lock['build'].get('output_profile')==profile and lock['build'].get('diagnostic_only') is True,'OPERATOR_PROFILE_INCONSISTENT')
        for b in builds:
            m=b.get('diagnostic_marker',{})
            require(m==expected and type(m.get('schema_version')) is int and m.get('diagnostic_only') is True and b.get('output_profile')==profile and b.get('elf',{}).get('linker_flags')==flags,'S_W_DIAGNOSTIC_MARKER_INVALID')
        raise SystemExit('S_W_OPERATOR_STARTUP_FORBIDDEN')
    # Missing markers cannot disguise an unknown or stripped binary as legacy.
    if lock['build'].get('output_profile')!=production:
        require(v['elf_sha256']=='6b48572984287dcf64ed09a9080a720e65d4bf5c810c2282782fb4e5da8aa3c8','OPERATOR_PROFILE_EVIDENCE_MISSING')
except (ValueError,KeyError,TypeError,OSError,AttributeError):
    raise SystemExit('OPERATOR_IMAGE_PROVENANCE_INVALID')
PY
if [ -f "$work/production-candidate" ] || [ "${GITHUB_ACTIONS:-}" = true ]; then
  : "${SEAWEED_QUALIFIED_RECEIPT:?CI requires qualified producer evidence}"
  node tools/test/load-qualified-storage.mjs verify-local "$SEAWEED_QUALIFIED_RECEIPT" "$image" >&2
fi
printf '%s\n' "$image"
