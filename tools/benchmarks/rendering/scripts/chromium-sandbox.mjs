import { readdirSync, readFileSync } from "node:fs";

export const SANDBOX_DISABLE_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox"];

const CHROME_EXECUTABLES = new Set([
  "chrome",
  "chrome-headless-shell",
  "chromium",
  "chromium-browser",
]);

export function isChromiumExecutable(argv) {
  const base = String(argv?.[0] ?? "")
    .split("/")
    .pop();
  return CHROME_EXECUTABLES.has(base);
}

export function selectBrowserArgv(argvs) {
  const parents = argvs.filter((argv) => !argv.some((arg) => arg.startsWith("--type=")));
  return parents[0] ?? argvs[0] ?? null;
}

export function classifyChromiumSandbox(observation) {
  const observationMethod = "live Chromium process arguments";
  if (!observation || observation.inspected !== true || !Array.isArray(observation.argv)) {
    return {
      status: "UNVERIFIED",
      observationMethod,
      observedFlags: [],
      reason: observation?.reason ?? "process arguments could not be inspected",
    };
  }
  const observedFlags = SANDBOX_DISABLE_FLAGS.filter((flag) => observation.argv.includes(flag));
  if (observedFlags.length > 0) {
    return {
      status: "DISABLED",
      observationMethod,
      observedFlags,
    };
  }
  return {
    status: "NO_DISABLING_FLAG_OBSERVED",
    observationMethod,
    observedFlags: [],
    note: "No sandbox-disabling flag was present in the observed arguments. That does not establish that the Chromium sandbox is operational.",
  };
}

export function readLiveChromiumArgv() {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return { inspected: false, reason: "could not read /proc" };
  }
  const argvs = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let raw;
    try {
      raw = readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const argv = raw.split("\0").filter((part) => part.length > 0);
    if (isChromiumExecutable(argv)) {
      argvs.push(argv);
    }
  }
  const argv = selectBrowserArgv(argvs);
  if (argv === null) {
    return { inspected: false, reason: "no Chromium process was observed" };
  }
  return { inspected: true, argv };
}
