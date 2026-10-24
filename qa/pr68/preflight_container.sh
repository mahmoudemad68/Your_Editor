#!/usr/bin/env bash
# QA: run the PR's read-only ASR preflight inside the PR-built production AI image under controlled jails.
set -uo pipefail
out="$1"; image="${2:-editagent-ai-worker:local}"
: > "$out"
WRAP='import json,os,sys,runpy,io,contextlib
env=dict(os.environ); sys.argv=["asr_preflight","--verify-models"]; buf=io.StringIO(); code=0
with contextlib.redirect_stdout(buf):
    try: runpy.run_module("editagent_ai_worker.infrastructure.asr_preflight", run_name="__main__")
    except SystemExit as e: code=e.code
r=json.loads(buf.getvalue())
print(json.dumps({"exit":code,"status":r["status"],"blockers":r["blockers"],"cgroup":r["cgroup"],"container":r["container"],"cpu":r["cpuCapabilities"],
 "affinity":r["affinityCpus"],"deps":r["dependencies"],"modelsVerified":r["modelsVerified"],"timeoutMs":r["timeoutMs"],"device":r["device"],
 "perfGuaranteed":r["performanceGuaranteed"],"native":sorted(m for m in ("ctranslate2","onnxruntime","faster_whisper","av","numpy","torch") if m in sys.modules),
 "envMutated":dict(os.environ)!=env}))'
run() { # label, extra docker args...
  local label="$1"; shift
  local name="qa68-pf-$RANDOM"
  local started=$(date +%s.%N)
  local res
  res=$(docker run --name "$name" --entrypoint /app/.venv/bin/python --user 10001:10001 --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --network none --tmpfs /tmp:rw,size=128m "$@" "$image" -c "$WRAP" 2>&1 | tail -1)
  local secs=$(python3 -c "print(round($(date +%s.%N)-$started,2))")
  local diff=$(docker diff "$name" | wc -l)
  docker rm -f "$name" >/dev/null
  python3 - "$label" "$secs" "$diff" "$res" >> "$out" <<'EOF'
import json,sys
label,secs,diff,res=sys.argv[1:5]
try: r=json.loads(res)
except Exception: r={"raw":res[-400:]}
print(json.dumps({"label":label,"seconds":float(secs),"containerFsChanges":int(diff),**r}))
EOF
}
Q="--cpus 2 --memory 3g --memory-swap 3g --pids-limit 128"
run "production jail 2CPU/3GiB/128 (private cgroupns)" $Q --cgroupns private
run "same jail, host cgroup namespace" $Q --cgroupns host
run "4 CPUs (unqualified profile)" --cpus 4 --memory 3g --memory-swap 3g --pids-limit 128 --cgroupns private
run "no limits at all" --cgroupns private
run "native override CT2_FORCE_CPU_ISA=AVX512" $Q --cgroupns private -e CT2_FORCE_CPU_ISA=AVX512
run "model root missing" $Q --cgroupns private -e EDITAGENT_ASR_MODEL_ROOT=/nonexistent
run "GPU device requested" $Q --cgroupns private -e EDITAGENT_ASR_DEVICE=cuda
run "1 CPU affinity" $Q --cgroupns private --cpuset-cpus 0
cat "$out"
