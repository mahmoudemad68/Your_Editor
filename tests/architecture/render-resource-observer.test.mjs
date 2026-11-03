import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyTermination,
  startResourceObserver,
  parseCgroup,
} from "../../tools/render/resource-observer.mjs";
test("137 alone cannot establish OOM; absent evidence is never zero", () => {
  assert.equal(
    classifyTermination(null, null, 137, false, true).cause,
    "CONTAINER_OOM_KILL_OBSERVED",
  );
  assert.equal(classifyTermination(null, null, 137, false).cause, "RESOURCE_EVIDENCE_UNAVAILABLE");
  assert.equal(
    classifyTermination(
      { "memory.events": "oom_kill 0" },
      { "memory.events": "oom_kill 0" },
      137,
      false,
    ).cause,
    "SIGKILL_CAUSE_NOT_PROVEN",
  );
  assert.equal(
    classifyTermination(
      { "memory.events": "oom_kill 2" },
      { "memory.events": "oom_kill 3" },
      137,
      false,
    ).cause,
    "CGROUP_OOM_KILL_OBSERVED",
  );
  assert.equal(classifyTermination(null, null, null, true).cause, "WATCHDOG");
});
test("resource observation captures only owned processes, kernel counters and fixed limits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "render-resources-")),
    file = path.join(dir, "evidence.json"),
    calls = [];
  try {
    const execute = async (args) => {
      calls.push(args);
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            State: { Running: true, OOMKilled: false, ExitCode: 0 },
            HostConfig: { Memory: 128, MemorySwap: 128, NanoCpus: 1000, PidsLimit: 64 },
            Config: { Env: ["SECRET=never-publish"] },
          },
        ]);
      if (args[0] === "exec")
        return [
          "memory.events",
          "memory.events.local",
          "memory.current",
          "memory.peak",
          "memory.max",
          "pids.current",
          "pids.max",
          "cpu.stat",
        ]
          .map(
            (k) => `\n__RESOURCE__${k}\n${k.startsWith("memory.events") ? "oom_kill 0" : "128"}\n`,
          )
          .join("");
      return "PID PPID COMMAND RSS\n1 0 node 12\n";
    };
    const observer = startResourceObserver(["render-executor-0123456789ab"], file, execute);
    await observer.ready;
    await assert.rejects(observer.phase("arbitrary secret / path"), /RESOURCE_PHASE_REJECTED/);
    await observer.phase("proof-0");
    await observer.stop({ exit_code: 137 });
    const text = await readFile(file, "utf8"),
      r = JSON.parse(text);
    assert.ok(r.samples.length >= 2);
    assert.equal(r.samples[0].containers[0].limits.memory, 128);
    assert.equal(r.samples.at(-1).phase, "proof-0");
    assert.doesNotMatch(text, /SECRET|never-publish/);
    assert.ok(calls.every((a) => a[1] === "render-executor-0123456789ab"));
    assert.ok(calls.some((a) => a.join(" ").endsWith("pid,ppid,comm,rss")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cgroup diagnostics reject missing and duplicated measurement fields", () => {
  assert.throws(() => parseCgroup(""), /RESOURCE_CGROUP_REJECTED/);
  assert.throws(
    () =>
      parseCgroup(
        "\n__RESOURCE__memory.events\noom_kill 0\n__RESOURCE__memory.events\noom_kill 1\n",
      ),
    /RESOURCE_CGROUP_REJECTED/,
  );
});

test("an in-flight sample retains its original phase during a phase transition", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "render-phase-"));
  let release;
  const blocked = new Promise((r) => {
    release = r;
  });
  let first = true;
  try {
    const obs = startResourceObserver(
      ["render-coordinator-0123456789ab"],
      path.join(dir, "e.json"),
      async () => {
        if (first) {
          first = false;
          await blocked;
        }
        throw Error("observation unavailable");
      },
    );
    const transition = obs.phase("proof-1");
    release();
    await transition;
    const result = await obs.stop();
    assert.equal(result.samples[0].phase, "startup");
    assert.equal(result.samples[1].phase, "proof-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("unavailable observations and unsafe container selections fail closed", async () => {
  assert.throws(() => startResourceObserver(["other-container"], "unused"), /CONTAINER_REJECTED/);
  const dir = await mkdtemp(path.join(tmpdir(), "render-resources-"));
  try {
    const obs = startResourceObserver(
      ["render-executor-0123456789ab"],
      path.join(dir, "e.json"),
      async () => {
        throw Error("unavailable");
      },
    );
    const r = await obs.stop();
    assert.equal(r.samples.at(-1).containers[0].observation, "UNAVAILABLE");
    assert.equal(r.samples.at(-1).containers[0].cgroup, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
