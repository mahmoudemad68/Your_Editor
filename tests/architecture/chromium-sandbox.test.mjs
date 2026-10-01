import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  classifyChromiumSandbox,
  parseProcStat,
  readLiveChromiumArgv,
  readProcessStartTime,
  selectRendererChromium,
} from "../../tools/benchmarks/rendering/scripts/chromium-sandbox.mjs";

const tracked = [];

after(() => {
  for (const pid of tracked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
});

function track(pid) {
  if (Number.isInteger(pid) && pid > 0) {
    tracked.push(pid);
  }
  return pid;
}

function chromiumBinary() {
  const directory = mkdtempSync(path.join(tmpdir(), "chromium-identity-"));
  const binary = path.join(directory, "chrome-headless-shell");
  symlinkSync(process.execPath, binary);
  return { directory, binary };
}

function spawnChromium(binary, args) {
  const child = spawn(binary, ["-e", "setInterval(() => {}, 1000);", "--", ...args], {
    stdio: "ignore",
  });
  track(child.pid);
  return child;
}

function spawnRenderer(binary, chromeArgs) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        const browser = spawn(process.env.CHROME_BIN, ["-e", "setInterval(() => {}, 1000);", "--", ...process.env.CHROME_ARGS.split("\\n")], {
          stdio: "ignore",
        });
        process.send({ browserPid: browser.pid });
        setInterval(() => {}, 1000);
      `,
    ],
    {
      env: {
        ...process.env,
        CHROME_BIN: binary,
        CHROME_ARGS: chromeArgs.join("\n"),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  track(child.pid);
  return child;
}

async function observeRenderer(renderer) {
  const message = await once(renderer, "message");
  const browserPid = message[0].browserPid;
  track(browserPid);
  const rendererStartTime = readProcessStartTime(renderer.pid);
  const deadline = Date.now() + 5000;
  let observation = { inspected: false, reason: "timed out" };
  while (Date.now() < deadline) {
    observation = readLiveChromiumArgv({
      rendererPid: renderer.pid,
      rendererStartTime,
    });
    if (observation.inspected === true) {
      return { observation, browserPid, rendererStartTime };
    }
    await delay(50);
  }
  return { observation, browserPid, rendererStartTime };
}

test("argv that includes --no-sandbox is classified as DISABLED", () => {
  const argv = [
    "/opt/chrome-headless-shell",
    "--headless=old",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ];
  const result = classifyChromiumSandbox({ inspected: true, argv });
  assert.equal(result.status, "DISABLED");
  assert.equal(result.observationMethod, "renderer descendant process arguments");
  assert.deepEqual(result.observedFlags, ["--no-sandbox"]);
  for (const flag of result.observedFlags) {
    assert.equal(argv.includes(flag), true);
  }
});

test("argv that includes --disable-setuid-sandbox records that flag", () => {
  const argv = ["/opt/chrome-headless-shell", "--disable-setuid-sandbox", "--headless=old"];
  const result = classifyChromiumSandbox({ inspected: true, argv });
  assert.equal(result.status, "DISABLED");
  assert.deepEqual(result.observedFlags, ["--disable-setuid-sandbox"]);
  assert.equal(argv.includes("--disable-setuid-sandbox"), true);
});

test("an unreadable process is UNVERIFIED", () => {
  const result = classifyChromiumSandbox({
    inspected: false,
    reason: "could not read /proc",
  });
  assert.equal(result.status, "UNVERIFIED");
  assert.deepEqual(result.observedFlags, []);
  assert.equal(result.reason, "could not read /proc");
});

test("missing disabling flags do not claim the Chromium sandbox is operational", () => {
  const argv = ["/opt/chrome-headless-shell", "--headless=old", "--disable-dev-shm-usage"];
  const result = classifyChromiumSandbox({ inspected: true, argv });
  assert.equal(result.status, "NO_DISABLING_FLAG_OBSERVED");
  assert.deepEqual(result.observedFlags, []);
  assert.equal(result.status === "ENABLED", false);
  assert.match(result.note, /does not establish that the Chromium sandbox is operational/);
});

test("proc stat parsing keeps the parent PID when the process name contains parentheses", () => {
  const parsed = parseProcStat(
    "321 (chrome (sandbox) helper) S 44 1 1 0 -1 0 0 0 0 0 10 2 0 0 20 0 1 0 987654 100 0 0",
  );
  assert.deepEqual(parsed, { pid: 321, ppid: 44, starttime: 987654 });
});

test("the lower PID is ignored when it is not a descendant of the renderer", () => {
  const processes = new Map([
    [1, { pid: 1, ppid: 0, starttime: 1 }],
    [10, { pid: 10, ppid: 1, starttime: 50 }],
    [14, { pid: 14, ppid: 1, starttime: 70 }],
    [15, { pid: 15, ppid: 10, starttime: 80 }],
    [16, { pid: 16, ppid: 15, starttime: 81 }],
  ]);
  const argvByPid = new Map([
    [14, ["/usr/lib/chromium/chrome", "--headless=old"]],
    [15, ["/opt/chrome-headless-shell", "--no-sandbox", "--disable-setuid-sandbox"]],
    [16, ["/opt/chrome-headless-shell", "--type=renderer", "--no-sandbox"]],
  ]);
  const selected = selectRendererChromium({
    processes,
    argvByPid,
    rendererPid: 10,
    rendererStartTime: 50,
  });
  assert.equal(selected.browserPid, 15);
  assert.equal(selected.browserPpid, 10);
  const classified = classifyChromiumSandbox(selected);
  assert.equal(classified.status, "DISABLED");
  assert.deepEqual(classified.observedFlags, ["--no-sandbox", "--disable-setuid-sandbox"]);
  assert.equal(classified.browserPid, 15);
  assert.equal(classified.browserPpid, 10);
  assert.equal(classified.rendererPid, 10);
});

test("only an unrelated Chromium process stays UNVERIFIED", () => {
  const processes = new Map([
    [1, { pid: 1, ppid: 0, starttime: 1 }],
    [10, { pid: 10, ppid: 1, starttime: 50 }],
    [14, { pid: 14, ppid: 1, starttime: 70 }],
  ]);
  const selected = selectRendererChromium({
    processes,
    argvByPid: new Map([[14, ["/usr/lib/chromium/chrome", "--headless=old"]]]),
    rendererPid: 10,
    rendererStartTime: 50,
  });
  const classified = classifyChromiumSandbox(selected);
  assert.equal(classified.status, "UNVERIFIED");
  assert.equal(classified.browserPid, undefined);
  assert.deepEqual(classified.observedFlags, []);
});

test("two browser parents under one renderer are UNVERIFIED", () => {
  const processes = new Map([
    [10, { pid: 10, ppid: 1, starttime: 50 }],
    [15, { pid: 15, ppid: 10, starttime: 80 }],
    [17, { pid: 17, ppid: 10, starttime: 90 }],
  ]);
  const selected = selectRendererChromium({
    processes,
    argvByPid: new Map([
      [15, ["/opt/chrome-headless-shell", "--no-sandbox", "--disable-setuid-sandbox"]],
      [17, ["/opt/chrome-headless-shell", "--headless=old"]],
    ]),
    rendererPid: 10,
    rendererStartTime: 50,
  });
  assert.equal(classifyChromiumSandbox(selected).status, "UNVERIFIED");
});

test("a missing renderer PID is UNVERIFIED", () => {
  const classified = classifyChromiumSandbox(readLiveChromiumArgv({}));
  assert.equal(classified.status, "UNVERIFIED");
  assert.equal(classified.reason, "renderer PID is unavailable");
  assert.deepEqual(classified.observedFlags, []);
});

test("an unreadable proc directory is UNVERIFIED", () => {
  const classified = classifyChromiumSandbox(
    readLiveChromiumArgv({ rendererPid: 1, procRoot: path.join(tmpdir(), "missing-proc-root") }),
  );
  assert.equal(classified.status, "UNVERIFIED");
  assert.equal(classified.reason, "could not read /proc");
});

test("a renderer that exits before Chromium starts is UNVERIFIED", async () => {
  const renderer = spawn(process.execPath, ["-e", "process.exit(0)"]);
  track(renderer.pid);
  const rendererPid = renderer.pid;
  const rendererStartTime = readProcessStartTime(rendererPid);
  await once(renderer, "exit");
  const classified = classifyChromiumSandbox(
    readLiveChromiumArgv({ rendererPid, rendererStartTime }),
  );
  assert.equal(classified.status, "UNVERIFIED");
  assert.equal(classified.browserPid, undefined);
  assert.deepEqual(classified.observedFlags, []);
});

test("a live process name with parentheses still yields its parent PID", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.title = 'a (b) c'; setInterval(() => {}, 1000);",
  ]);
  track(child.pid);
  await delay(100);
  const parsed = parseProcStat(readFileSync(`/proc/${child.pid}/stat`, "utf8"));
  assert.equal(parsed.pid, child.pid);
  assert.equal(parsed.ppid, process.pid);
  assert.match(readFileSync(`/proc/${child.pid}/stat`, "utf8"), /\(a \(b\) c\)/);
});

test("an unrelated browser started first is ignored", { timeout: 15_000 }, async () => {
  const { directory, binary } = chromiumBinary();
  const unrelated = spawnChromium(binary, ["--headless=old"]);
  const renderer = spawnRenderer(binary, [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--headless=old",
  ]);
  try {
    const { observation, browserPid } = await observeRenderer(renderer);
    const actual = parseProcStat(readFileSync(`/proc/${browserPid}/stat`, "utf8"));
    assert.equal(observation.browserPid, browserPid);
    assert.equal(observation.browserPpid, actual.ppid);
    assert.equal(actual.ppid, renderer.pid);
    assert.equal(unrelated.pid === browserPid, false);
    const classified = classifyChromiumSandbox(observation);
    assert.equal(classified.status, "DISABLED");
    assert.deepEqual(classified.observedFlags, ["--no-sandbox", "--disable-setuid-sandbox"]);
    assert.equal(classified.browserPid, browserPid);
    assert.equal(classified.browserPpid, renderer.pid);
    assert.equal(classified.rendererPid, renderer.pid);
  } finally {
    renderer.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unrelated browser started second is ignored", { timeout: 15_000 }, async () => {
  const { directory, binary } = chromiumBinary();
  const renderer = spawnRenderer(binary, [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--headless=old",
  ]);
  try {
    const { browserPid } = await observeRenderer(renderer);
    const unrelated = spawnChromium(binary, ["--headless=old"]);
    await delay(100);
    const again = readLiveChromiumArgv({
      rendererPid: renderer.pid,
      rendererStartTime: readProcessStartTime(renderer.pid),
    });
    assert.equal(again.browserPid, browserPid);
    assert.equal(again.browserPid === unrelated.pid, false);
    const classified = classifyChromiumSandbox(again);
    assert.equal(classified.status, "DISABLED");
    assert.deepEqual(classified.observedFlags, ["--no-sandbox", "--disable-setuid-sandbox"]);
    assert.equal(classified.browserPpid, renderer.pid);
  } finally {
    renderer.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a live namespace with only an unrelated browser is UNVERIFIED", async () => {
  const { directory, binary } = chromiumBinary();
  const renderer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
  track(renderer.pid);
  const unrelated = spawnChromium(binary, ["--headless=old"]);
  try {
    await delay(150);
    const classified = classifyChromiumSandbox(
      readLiveChromiumArgv({
        rendererPid: renderer.pid,
        rendererStartTime: readProcessStartTime(renderer.pid),
      }),
    );
    assert.equal(classified.status, "UNVERIFIED");
    assert.equal(classified.browserPid, undefined);
    assert.deepEqual(classified.observedFlags, []);
    assert.equal(classified.status === "NO_DISABLING_FLAG_OBSERVED", false);
    assert.equal(unrelated.pid > 0, true);
  } finally {
    renderer.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the renderer's Chromium without disabling flags is not called operational", async () => {
  const { directory, binary } = chromiumBinary();
  const renderer = spawnRenderer(binary, ["--headless=old"]);
  try {
    const { observation, browserPid } = await observeRenderer(renderer);
    const classified = classifyChromiumSandbox(observation);
    assert.equal(observation.browserPid, browserPid);
    assert.equal(classified.status, "NO_DISABLING_FLAG_OBSERVED");
    assert.deepEqual(classified.observedFlags, []);
    assert.match(classified.note, /does not establish that the Chromium sandbox is operational/);
  } finally {
    renderer.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("committed Docker evidence records the flags observed on the Chromium process", () => {
  const record = JSON.parse(
    readFileSync(path.resolve("tools/benchmarks/rendering/results/docker.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(record, "sandboxDisabled"), false);
  assert.equal(record.exitCode, 0);
  assert.equal(record.user, 10001);
  assert.equal(record.validation.ok, true);
  assert.equal(record.chromiumSandbox.observationMethod, "renderer descendant process arguments");
  assert.deepEqual(record.chromiumSandbox.observedFlags, [
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ]);
  for (const field of ["browserPid", "browserPpid", "rendererPid"]) {
    assert.equal(Number.isInteger(record.chromiumSandbox[field]), true);
    assert.equal(record.chromiumSandbox[field] > 0, true);
  }
  assert.equal(record.chromiumSandbox.browserPid === record.chromiumSandbox.rendererPid, false);
  const classified = classifyChromiumSandbox({
    inspected: true,
    argv: ["chrome-headless-shell", ...record.chromiumSandbox.observedFlags],
    browserPid: record.chromiumSandbox.browserPid,
    browserPpid: record.chromiumSandbox.browserPpid,
    rendererPid: record.chromiumSandbox.rendererPid,
  });
  assert.equal(classified.status, record.chromiumSandbox.status);
  assert.deepEqual(classified.observedFlags, record.chromiumSandbox.observedFlags);
  assert.equal(classified.browserPid, record.chromiumSandbox.browserPid);
  const dockerfile = readFileSync(
    path.resolve("tools/benchmarks/rendering/docker/Dockerfile"),
    "utf8",
  );
  assert.equal(dockerfile.includes("Chromium sandbox stays on"), false);
  assert.match(dockerfile, /uid 10001/);
  assert.match(dockerfile, /--no-sandbox/);
  assert.match(dockerfile, /--disable-setuid-sandbox/);
});
