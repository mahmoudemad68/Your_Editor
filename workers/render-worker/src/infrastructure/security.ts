import { readFileSync, readdirSync } from "node:fs";
import { loadRendererProcessConfig } from "./config.js";
/** Fail closed in the credential-free browser container. Never enabled by user props. */
export function assertRenderIsolation(): void {
  loadRendererProcessConfig();
  const status = readFileSync("/proc/self/status", "utf8");
  const limit = (file: string) => readFileSync(`/sys/fs/cgroup/${file}`, "utf8").trim();
  const memory = Number(limit("memory.max")),
    pids = Number(limit("pids.max"));
  const [quota = NaN, period = NaN] = limit("cpu.max").split(" ").map(Number);
  const root = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .find((x) => x.split(" ")[1] === "/");
  if (
    process.getuid?.() !== 10001 ||
    process.getgid?.() !== 10001 ||
    !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status) ||
    !/^CapEff:\s+0+$/m.test(status) ||
    !/^CapBnd:\s+0+$/m.test(status) ||
    !Number.isFinite(memory) ||
    memory > 8589934592 ||
    limit("memory.swap.max") !== "0" ||
    memory < 268435456 ||
    !Number.isInteger(pids) ||
    pids > 512 ||
    pids < 64 ||
    !Number.isFinite(quota) ||
    quota <= 0 ||
    !Number.isFinite(period) ||
    period <= 0 ||
    quota / period > 4 ||
    !root?.split(" ")[3]?.split(",").includes("ro") ||
    readdirSync("/sys/class/net").some((x) => x !== "lo")
  )
    throw new Error("Mandatory render container isolation is absent.");
  const mounts = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .map((x) => x.split(" "));
  for (const location of ["/tmp", "/render-work", "/run/render"]) {
    const mount = mounts.find((x) => x[1] === location);
    const size = /^size=(\d+)([kmg]?)$/.exec(
      mount?.[3]?.split(",").find((x) => x.startsWith("size=")) ?? "",
    );
    const bytes = size
      ? Number(size[1]) * ({ k: 1024, m: 1048576, g: 1073741824 }[size[2] as "k" | "m" | "g"] ?? 1)
      : NaN;
    if (
      mount?.[2] !== "tmpfs" ||
      !["nosuid", "nodev", "noexec"].every((flag) => mount?.[3]?.split(",").includes(flag)) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > (location === "/run/render" ? 8388608 : 2147483648)
    )
      throw new Error("Bounded render filesystem is absent.");
  }
  const fileLimit = readFileSync("/proc/self/limits", "utf8")
    .split("\n")
    .find((x) => x.startsWith("Max file size"))
    ?.trim()
    .split(/\s+/);
  if (!fileLimit || Number(fileLimit[3]) > 1073741824 || !Number.isFinite(Number(fileLimit[3])))
    throw new Error("Render file-size limit is absent.");
}
