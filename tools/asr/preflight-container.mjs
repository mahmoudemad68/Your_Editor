/** Read-only production-image regression for private and host cgroup namespaces. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import console from "node:console";
import process from "node:process";

if (process.platform !== "linux")
  throw new Error("NOT_RUN_ON_WINDOWS: real cgroup namespace verification requires Linux Docker");

const image = process.argv[2];
assert.ok(["editagent-ai-asr:test", "editagent-ai-asr:small-test"].includes(image));
const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 128 * 1024 });
const results = [];
for (const namespace of ["private", "host"]) {
  const name = "asr-preflight-" + randomUUID();
  try {
    const report = JSON.parse(
      docker([
        "run",
        "--name",
        name,
        "--cgroupns",
        namespace,
        "--network",
        "none",
        "--user",
        "10001:10001",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--cpus",
        "2",
        "--memory",
        "3g",
        "--memory-swap",
        "3g",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
        "--entrypoint",
        "/app/.venv/bin/python",
        image,
        "-B",
        "-c",
        `import json,os,sys
from pathlib import Path
from editagent_ai_worker.infrastructure.asr_preflight import collect
before=dict(os.environ); files=set(Path('/tmp').rglob('*'))
value=collect(verify_models=True)
assert dict(os.environ)==before
assert set(Path('/tmp').rglob('*'))==files
assert not ({'numpy','ctranslate2','faster_whisper','onnxruntime'} & set(sys.modules))
print(json.dumps(value))`,
      ]),
    );
    assert.equal(report.status, "READY_FOR_QUALIFICATION");
    assert.deepEqual(report.blockers, []);
    assert.equal(report.modelsVerified, true);
    assert.equal(report.nativeLibrariesLoaded, false);
    assert.equal(report.performanceGuaranteed, false);
    assert.equal(report.deadlineMs, 600000);
    assert.deepEqual(report.cgroup, {
      version: 2,
      quotaCpus: 2,
      memoryBytes: 3 * 1024 ** 3,
      pids: 128,
      visibleAncestorsChecked: true,
    });
    assert.equal(docker(["diff", name]).trim(), "");
    const state = JSON.parse(docker(["inspect", name]))[0];
    assert.equal(state.State.ExitCode, 0);
    assert.equal(state.HostConfig.CgroupnsMode, namespace);
    assert.equal(state.HostConfig.NetworkMode, "none");
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
    assert.equal(state.Config.User, "10001:10001");
    results.push({
      namespace,
      status: "PASS",
      limits: report.cgroup,
      deadlineMs: report.deadlineMs,
      modelsVerified: true,
      noNativeImports: true,
      noEnvironmentMutation: true,
      noFilesystemChanges: true,
      network: "none",
      performanceGuaranteed: false,
    });
  } finally {
    docker(["rm", "-f", name]);
  }
}
console.log("ASR_CGROUP_NAMESPACES " + JSON.stringify({ image, status: "PASS", results }));
