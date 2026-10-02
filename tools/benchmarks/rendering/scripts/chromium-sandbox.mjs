import { readdirSync, readFileSync } from "node:fs";

export const SANDBOX_DISABLE_FLAGS = ["--no-sandbox", "--disable-setuid-sandbox"];

export const CHROMIUM_OBSERVATION_METHOD = "renderer descendant process arguments";

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

export function parseProcStat(contents) {
  const text = String(contents);
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close < open) {
    return null;
  }
  const pid = Number(text.slice(0, open).trim());
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (!Number.isInteger(pid) || pid <= 0 || fields.length < 20) {
    return null;
  }
  const ppid = Number(fields[1]);
  const starttime = Number(fields[19]);
  if (!Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(starttime) || starttime < 0) {
    return null;
  }
  return { pid, ppid, starttime };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function identityFields(observation) {
  const fields = {};
  if (positiveInteger(observation?.browserPid)) {
    fields.browserPid = observation.browserPid;
  }
  if (positiveInteger(observation?.browserPpid)) {
    fields.browserPpid = observation.browserPpid;
  }
  if (positiveInteger(observation?.rendererPid)) {
    fields.rendererPid = observation.rendererPid;
  }
  return fields;
}

export function classifyChromiumSandbox(observation) {
  const identity = identityFields(observation);
  if (!observation || observation.inspected !== true || !Array.isArray(observation.argv)) {
    return {
      status: "UNVERIFIED",
      observationMethod: CHROMIUM_OBSERVATION_METHOD,
      ...identity,
      observedFlags: [],
      reason: observation?.reason ?? "process arguments could not be inspected",
    };
  }
  const observedFlags = SANDBOX_DISABLE_FLAGS.filter((flag) => observation.argv.includes(flag));
  if (observedFlags.length > 0) {
    return {
      status: "DISABLED",
      observationMethod: CHROMIUM_OBSERVATION_METHOD,
      ...identity,
      observedFlags,
    };
  }
  return {
    status: "NO_DISABLING_FLAG_OBSERVED",
    observationMethod: CHROMIUM_OBSERVATION_METHOD,
    ...identity,
    observedFlags: [],
    note: "No sandbox-disabling flag was present in the observed arguments. That does not establish that the Chromium sandbox is operational.",
  };
}

export function processDescendsFrom(pid, ancestorPid, processes, ancestorStartTime) {
  const ancestor = processes.get(ancestorPid);
  if (!ancestor) {
    return false;
  }
  if (ancestorStartTime != null && ancestor.starttime !== ancestorStartTime) {
    return false;
  }
  let current = pid;
  const seen = new Set();
  while (positiveInteger(current) && !seen.has(current)) {
    if (current === ancestorPid) {
      return true;
    }
    seen.add(current);
    const record = processes.get(current);
    if (!record) {
      return false;
    }
    current = record.ppid;
  }
  return false;
}

function isBrowserParent(argv) {
  return !argv.some((arg) => arg.startsWith("--type="));
}

export function selectRendererChromium({ processes, argvByPid, rendererPid, rendererStartTime }) {
  if (!positiveInteger(rendererPid)) {
    return { inspected: false, reason: "renderer PID is unavailable" };
  }
  const renderer = processes?.get(rendererPid);
  if (!renderer) {
    return {
      inspected: false,
      rendererPid,
      reason: "renderer process was not observed",
    };
  }
  if (rendererStartTime != null && renderer.starttime !== rendererStartTime) {
    return { inspected: false, rendererPid, reason: "renderer PID was reused" };
  }
  const parents = [];
  for (const [pid, argv] of argvByPid ?? []) {
    if (!isChromiumExecutable(argv) || !isBrowserParent(argv)) {
      continue;
    }
    if (!processDescendsFrom(pid, rendererPid, processes, renderer.starttime)) {
      continue;
    }
    const record = processes.get(pid);
    parents.push({
      argv,
      browserPid: pid,
      browserPpid: record.ppid,
    });
  }
  if (parents.length > 1) {
    return {
      inspected: false,
      rendererPid,
      reason: "more than one Chromium browser parent descends from the renderer",
    };
  }
  const selected = parents[0];
  if (!selected) {
    return {
      inspected: false,
      rendererPid,
      reason: "no Chromium process descending from the renderer was observed",
    };
  }
  return {
    inspected: true,
    argv: selected.argv,
    browserPid: selected.browserPid,
    browserPpid: selected.browserPpid,
    rendererPid,
  };
}

function readProcStat(procRoot, pid) {
  try {
    const stat = parseProcStat(readFileSync(`${procRoot}/${pid}/stat`, "utf8"));
    if (!stat || stat.pid !== pid) {
      return null;
    }
    return stat;
  } catch {
    return null;
  }
}

function readArgv(procRoot, pid) {
  try {
    return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((part) => part.length > 0);
  } catch {
    return null;
  }
}

export function readProcessStartTime(pid, procRoot = "/proc") {
  return readProcStat(procRoot, pid)?.starttime ?? null;
}

function readProcessTable(procRoot) {
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  const processes = new Map();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const stat = readProcStat(procRoot, Number(entry));
    if (stat) {
      processes.set(stat.pid, stat);
    }
  }
  return processes;
}

export function readLiveChromiumArgv({ rendererPid, rendererStartTime, procRoot = "/proc" } = {}) {
  if (!positiveInteger(rendererPid)) {
    return { inspected: false, reason: "renderer PID is unavailable" };
  }
  const processes = readProcessTable(procRoot);
  if (processes === null) {
    return { inspected: false, rendererPid, reason: "could not read /proc" };
  }
  const argvByPid = new Map();
  for (const pid of processes.keys()) {
    const before = processes.get(pid);
    const argv = readArgv(procRoot, pid);
    const after = readProcStat(procRoot, pid);
    if (!argv || !after || after.starttime !== before.starttime || after.ppid !== before.ppid) {
      continue;
    }
    processes.set(pid, after);
    argvByPid.set(pid, argv);
  }
  return selectRendererChromium({
    processes,
    argvByPid,
    rendererPid,
    rendererStartTime,
  });
}
