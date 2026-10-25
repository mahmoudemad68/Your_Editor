#!/usr/bin/env bash
# QA PR #73 (Issue #72): run the PR read-only ASR preflight inside the PR-built production AI image under controlled jails,
# including both cgroup namespaces and a restrictive systemd parent slice (QA-authored).
set -uo pipefail
out="$1"; image="${2:-editagent-ai-worker:local}"
: > "$out"
WRAP='import json,os,sys,runpy,io,contextlib
env=dict(os.environ); sys.argv=["asr_preflight","--verify-models"]; buf=io.StringIO(); code=0
with contextlib.redirect_stdout(buf):
    try: runpy.run_module("editagent_ai_worker.infrastructure.asr_preflight", run_name="__main__")
    except SystemExit as e: code=e.code
r=json.loads(buf.getvalue())
mi=[l for l in open("/proc/self/mountinfo") if " /sys/fs/cgroup " in l]
print(json.dumps({"exit":code,"status":r["status"],"blockers":r["blockers"],"cgroup":r["cgroup"],"modelsVerified":r["modelsVerified"],
 "deadlineMs":r["deadlineMs"],"resourceAssurance":r.get("resourceAssurance"),"perfGuaranteed":r["performanceGuaranteed"],"membership":open("/proc/self/cgroup").read().strip(),
 "cgroupMountRoot":[l.split()[3] for l in mi],
 "native":sorted(m for m in ("ctranslate2","onnxruntime","faster_whisper","av","numpy","torch") if m in sys.modules),
 "envMutated":dict(os.environ)!=env}))'
run() { # label, extra docker args...
  local label="$1"; shift
  local name="qa73-pf-$RANDOM"
  local res
  res=$(docker run --name "$name" --entrypoint /app/.venv/bin/python --user 10001:10001 --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --network none --tmpfs /tmp:rw,size=128m "$@" "$image" -c "$WRAP" 2>&1 | tail -1)
  local diff=$(docker diff "$name" | wc -l)
  docker rm -f "$name" >/dev/null
  python3 - "$label" "$diff" "$res" >> "$out" <<'EOF'
import json,sys
label,diff,res=sys.argv[1:4]
try: r=json.loads(res)
except Exception: r={"raw":res[-400:]}
print(json.dumps({"label":label,"containerFsChanges":int(diff),**r}))
EOF
}
Q="--cpus 2 --memory 3g --memory-swap 3g --pids-limit 128"
run "production jail, private cgroupns" $Q --cgroupns private
run "production jail, HOST cgroupns (Issue #69)" $Q --cgroupns host
run "4 CPUs, host cgroupns" --cpus 4 --memory 3g --memory-swap 3g --pids-limit 128 --cgroupns host
run "no limits, host cgroupns" --cgroupns host
run "1 GiB memory, host cgroupns" --cpus 2 --memory 1g --memory-swap 1g --pids-limit 128 --cgroupns host
run "64 pids, private cgroupns" --cpus 2 --memory 3g --memory-swap 3g --pids-limit 64 --cgroupns private
run "1 CPU affinity, host cgroupns" $Q --cgroupns host --cpuset-cpus 0
run "native override, host cgroupns" $Q --cgroupns host -e CT2_FORCE_CPU_ISA=AVX512
run "GPU device, host cgroupns" $Q --cgroupns host -e EDITAGENT_ASR_DEVICE=cuda
run "model root missing, host cgroupns" $Q --cgroupns host -e EDITAGENT_ASR_MODEL_ROOT=/nonexistent
run "forged host-assurance env, private cgroupns" $Q --cgroupns private -e EDITAGENT_HOST_PARENT_LIMITS=VERIFIED -e EDITAGENT_RESOURCE_ASSURANCE=host_verified -e EDITAGENT_ASR_RESOURCE_ATTESTATION=trusted
run "missing cgroup evidence (empty ro bind), private cgroupns" $Q --cgroupns private --mount type=bind,src=$(mktemp -d),dst=/sys/fs/cgroup,readonly
# Restrictive ancestor: a systemd slice ABOVE the container (1 CPU / 1 GiB / 64 tasks) while the container claims 2/3GiB/128.
if [ "$(docker info --format '{{.CgroupDriver}}')" = "systemd" ]; then
  sudo tee /run/systemd/system/qa73restrict.slice >/dev/null <<'EOF'
[Slice]
CPUQuota=100%
MemoryMax=1G
TasksMax=64
EOF
  sudo systemctl daemon-reload && sudo systemctl start qa73restrict.slice
  python3 -c "import json,sys;p=\"/sys/fs/cgroup/qa73restrict.slice/\";print(json.dumps({\"label\":\"trusted host read of parent slice\",**{f:open(p+f).read().strip() for f in (\"cpu.max\",\"memory.max\",\"pids.max\")}}))" >> "$out"
  run "restrictive PARENT slice 1CPU/1GiB/64, host cgroupns (ancestor visible)" $Q --cgroupns host --cgroup-parent qa73restrict.slice
  run "restrictive PARENT slice 1CPU/1GiB/64, private cgroupns (ancestor hidden)" $Q --cgroupns private --cgroup-parent qa73restrict.slice
  run "restrictive PARENT slice bound read-only as delegated root, host cgroupns" $Q --cgroupns host --mount type=bind,src=/sys/fs/cgroup/qa73restrict.slice,dst=/sys/fs/cgroup,readonly
  sudo systemctl stop qa73restrict.slice || true
fi
cat "$out"
