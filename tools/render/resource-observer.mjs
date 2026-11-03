/** Bounded private diagnostics, never a replacement for production resource gates. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { setInterval, clearInterval } from "node:timers";
import { withoutQualificationCredentials } from "../test/pc100-candidate-policy.mjs";
import process from "node:process";
const fields = [
  "memory.events",
  "memory.events.local",
  "memory.current",
  "memory.peak",
  "memory.max",
  "pids.current",
  "pids.max",
  "cpu.stat",
];
// Use tiny existing shell/cat processes rather than launching another V8 heap
// inside an already memory-constrained renderer.
const cgroup = `for p in ${fields.join(" ")}; do printf '\\n__RESOURCE__%s\\n' "$p"; if [ -r "/sys/fs/cgroup/$p" ]; then cat "/sys/fs/cgroup/$p"; else printf '__UNAVAILABLE__\\n'; fi; done`;
export function parseCgroup(text) {
  const result = Object.create(null);
  for (const part of text.split("\n__RESOURCE__").slice(1)) {
    const at = part.indexOf("\n"),
      key = part.slice(0, at),
      value = part.slice(at + 1).trim();
    if (!fields.includes(key) || Object.hasOwn(result, key) || !value)
      throw Error("RESOURCE_CGROUP_REJECTED");
    result[key] = value === "__UNAVAILABLE__" ? null : value;
  }
  if (Object.keys(result).length !== fields.length) throw Error("RESOURCE_CGROUP_REJECTED");
  return result;
}
export function classifyTermination(before, after, code, watchdog, containerOOM = false) {
  const kills = (x) => Number(/(?:^|\n)oom_kill (\d+)/.exec(x?.["memory.events"] ?? "")?.[1]);
  const delta = kills(after) - kills(before);
  return {
    exit_code: code,
    watchdog_fired: watchdog,
    container_oom_killed: containerOOM === true,
    oom_kill_delta: Number.isFinite(delta) ? delta : null,
    cause: watchdog
      ? "WATCHDOG"
      : containerOOM === true
        ? "CONTAINER_OOM_KILL_OBSERVED"
        : !Number.isFinite(delta)
          ? "RESOURCE_EVIDENCE_UNAVAILABLE"
          : delta > 0
            ? "CGROUP_OOM_KILL_OBSERVED"
            : code === 137
              ? "SIGKILL_CAUSE_NOT_PROVEN"
              : "NO_OOM_KILL_OBSERVED",
  };
}
export function startResourceObserver(containers, destination, execute) {
  if (
    !Array.isArray(containers) ||
    !containers.length ||
    containers.some((n) => !/^render-(executor|coordinator)-[a-f0-9]{12}$/.test(n))
  )
    throw Error("RESOURCE_OBSERVER_CONTAINER_REJECTED");
  const run =
    execute ??
    (async (args) =>
      (
        await promisify(execFile)("docker", args, {
          encoding: "utf8",
          timeout: 2500,
          maxBuffer: 65536,
          env: withoutQualificationCredentials(process.env),
        })
      ).stdout);
  const frames = [];
  let inFlight = false,
    stopped = false;
  async function sample() {
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = [];
      for (const id of containers) {
        const r = { container: id };
        try {
          const i = JSON.parse(await run(["inspect", id]))[0];
          r.state = {
            running: i.State.Running,
            oom_killed: i.State.OOMKilled,
            exit_code: i.State.ExitCode,
          };
          r.limits = {
            memory: i.HostConfig.Memory,
            memory_swap: i.HostConfig.MemorySwap,
            nano_cpus: i.HostConfig.NanoCpus,
            pids: i.HostConfig.PidsLimit,
          };
          r.cgroup = parseCgroup(await run(["exec", id, "/bin/sh", "-c", cgroup]));
          r.process_tree = (await run(["top", id, "-eo", "pid,ppid,comm,rss"])).slice(0, 16384);
        } catch {
          r.observation = "UNAVAILABLE";
        }
        rows.push(r);
      }
      const host = {
        node_rss: process.memoryUsage().rss,
        node_max_rss: process.resourceUsage().maxRSS,
      };
      try {
        const text = await readFile("/proc/meminfo", "utf8");
        host.memory = Object.fromEntries(
          [...text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm)].map(
            (m) => [m[1], Number(m[2]) * 1024],
          ),
        );
      } catch {
        host.memory = null;
      }
      for (const name of ["memory.events", "memory.peak", "memory.max"])
        try {
          host[name] = (await readFile("/sys/fs/cgroup/" + name, "utf8")).trim();
        } catch {
          host[name] = null;
        }
      frames.push({ at: new Date().toISOString(), host, containers: rows });
      if (frames.length > 64) frames.splice(1, 1); // preserve initial baseline and latest 63 observations
    } finally {
      inFlight = false;
    }
  }
  const first = sample(),
    timer = setInterval(() => {
      if (!stopped) void sample();
    }, 5000);
  return {
    ready: first,
    sample,
    async stop(outcome = {}) {
      stopped = true;
      clearInterval(timer);
      await first;
      while (inFlight) await new Promise((r) => globalThis.setTimeout(r, 10));
      await sample();
      const result = {
        schema: "render-resources-v1",
        scope: "owned-render-containers-only",
        outcome,
        samples: frames,
      };
      await writeFile(destination, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
      return result;
    },
  };
}
