/** Read-only production-image regression for private and host cgroup namespaces. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import console from "node:console";
import process from "node:process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "linux")
  throw new Error("NOT_RUN_ON_WINDOWS: real cgroup namespace verification requires Linux Docker");

const image = process.argv[2];
assert.ok(["editagent-ai-asr:test", "editagent-ai-asr:small-test"].includes(image));
const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 128 * 1024 });
const results = [];
const restrictive = process.argv.includes("--restrictive-parent");
const slice = "your_editor_qa" + randomUUID().replaceAll("-", "") + ".slice";
const hidden = mkdtempSync(path.join(tmpdir(), "asr-missing-cgroup-"));
const systemctl = (args) =>
  execFileSync("sudo", ["systemctl", ...args], { encoding: "utf8", timeout: 15000 });
const cases = [
  { namespace: "private", kind: "qualified", qualified: true },
  { namespace: "host", kind: "qualified", qualified: true },
  { namespace: "private", kind: "missing", qualified: false },
  { namespace: "private", kind: "unlimited", qualified: false },
];
let parentCreated = false;
let delegatedRoot;
try {
  if (restrictive) {
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "Parent setup is restricted to the disposable authorized CI runner",
    );
    assert.equal(docker(["info", "--format", "{{.CgroupDriver}}"]).trim(), "systemd");
    parentCreated = true;
    systemctl(["set-property", "--runtime", slice, "CPUQuota=100%", "MemoryMax=1G", "TasksMax=64"]);
    systemctl(["start", slice]);
    const group = systemctl(["show", slice, "--property=ControlGroup", "--value"]).trim();
    assert.match(group, /^\/your_editor_qa[a-f0-9]+\.slice$/);
    const root = "/sys/fs/cgroup" + group;
    delegatedRoot = root;
    const [quota, period] = readFileSync(path.join(root, "cpu.max"), "utf8")
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(quota / period, 1);
    assert.equal(Number(readFileSync(path.join(root, "memory.max"), "utf8")), 1024 ** 3);
    assert.equal(Number(readFileSync(path.join(root, "pids.max"), "utf8")), 64);
    cases.push({ namespace: "private", kind: "restrictive_parent", qualified: true });
    cases.push({ namespace: "host", kind: "restrictive_parent", qualified: false });
    cases.push({ namespace: "host", kind: "delegated", qualified: false });
  }
  for (const { namespace, kind, qualified } of cases) {
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
          ...(kind === "unlimited"
            ? []
            : ["--cpus", "2", "--memory", "3g", "--memory-swap", "3g", "--pids-limit", "128"]),
          ...(kind === "restrictive_parent" ? ["--cgroup-parent", slice] : []),
          ...(kind === "missing"
            ? ["--mount", `type=bind,src=${hidden},dst=/sys/fs/cgroup,readonly`]
            : []),
          ...(kind === "delegated"
            ? ["--mount", `type=bind,src=${delegatedRoot},dst=/sys/fs/cgroup,readonly`]
            : []),
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
      assert.equal(report.status, qualified ? "READY_FOR_QUALIFICATION" : "NOT_QUALIFIED");
      if (qualified) assert.deepEqual(report.blockers, []);
      else assert.ok(report.blockers.includes("resource_profile_not_qualified"));
      assert.deepEqual(report.resourceAssurance, {
        scope: "visible_cgroup_namespace_only",
        visibleProfileMatches: qualified,
        hostParentLimits: "NOT_VERIFIED",
        operatorVerificationRequired: true,
        limitation: "Stricter host, pod or parent-slice limits may be invisible.",
      });
      assert.equal(report.modelsVerified, true);
      assert.equal(report.nativeLibrariesLoaded, false);
      assert.equal(report.performanceGuaranteed, false);
      assert.equal(report.deadlineMs, 600000);
      if (qualified)
        assert.deepEqual(report.cgroup, {
          version: 2,
          quotaCpus: 2,
          memoryBytes: 3 * 1024 ** 3,
          pids: 128,
          visibleAncestorsChecked: true,
        });
      if (kind === "restrictive_parent" && namespace === "host") {
        assert.equal(report.cgroup.quotaCpus, 1);
        assert.equal(report.cgroup.memoryBytes, 1024 ** 3);
        assert.equal(report.cgroup.pids, 64);
      }
      if (["missing", "delegated"].includes(kind)) {
        assert.equal(report.cgroup.visibleAncestorsChecked, false);
        assert.equal(report.cgroup.version, null);
      }
      assert.equal(docker(["diff", name]).trim(), "");
      const state = JSON.parse(docker(["inspect", name]))[0];
      assert.equal(state.State.ExitCode, 0);
      assert.equal(state.HostConfig.CgroupnsMode, namespace);
      assert.equal(state.HostConfig.NetworkMode, "none");
      assert.equal(state.HostConfig.ReadonlyRootfs, true);
      assert.equal(state.Config.User, "10001:10001");
      results.push({
        namespace,
        scenario: kind,
        status: "PASS",
        limits: report.cgroup,
        deadlineMs: report.deadlineMs,
        modelsVerified: true,
        noNativeImports: true,
        noEnvironmentMutation: true,
        noFilesystemChanges: true,
        network: "none",
        performanceGuaranteed: false,
        resourceAssurance: report.resourceAssurance,
        ...(kind === "restrictive_parent"
          ? { trustedTestHostParent: { quotaCpus: 1, memoryBytes: 1024 ** 3, pids: 64 } }
          : {}),
      });
    } finally {
      docker(["rm", "-f", name]);
    }
  }
} finally {
  if (parentCreated) {
    systemctl(["stop", slice]);
    systemctl(["revert", slice]);
  }
  rmSync(hidden, { recursive: true, force: true });
}
console.log(
  "ASR_CGROUP_NAMESPACES " +
    JSON.stringify({ image, status: "PASS", restrictiveParentTested: restrictive, results }),
);
