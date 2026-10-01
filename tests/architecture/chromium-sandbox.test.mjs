import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { classifyChromiumSandbox } from "../../tools/benchmarks/rendering/scripts/chromium-sandbox.mjs";

test("argv that includes --no-sandbox is classified as DISABLED", () => {
  const argv = [
    "/opt/chrome-headless-shell",
    "--headless=old",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ];
  const result = classifyChromiumSandbox({ inspected: true, argv });
  assert.equal(result.status, "DISABLED");
  assert.equal(result.observationMethod, "live Chromium process arguments");
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

test("committed Docker evidence records the flags observed on the Chromium process", () => {
  const record = JSON.parse(
    readFileSync(path.resolve("tools/benchmarks/rendering/results/docker.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(record, "sandboxDisabled"), false);
  assert.equal(record.exitCode, 0);
  assert.equal(record.user, 10001);
  assert.equal(record.validation.ok, true);
  assert.deepEqual(record.chromiumSandbox.observedFlags, [
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ]);
  const classified = classifyChromiumSandbox({
    inspected: true,
    argv: ["chrome-headless-shell", ...record.chromiumSandbox.observedFlags],
  });
  assert.equal(classified.status, record.chromiumSandbox.status);
  assert.deepEqual(classified.observedFlags, record.chromiumSandbox.observedFlags);
  const dockerfile = readFileSync(
    path.resolve("tools/benchmarks/rendering/docker/Dockerfile"),
    "utf8",
  );
  assert.equal(dockerfile.includes("Chromium sandbox stays on"), false);
  assert.match(dockerfile, /uid 10001/);
  assert.match(dockerfile, /--no-sandbox/);
  assert.match(dockerfile, /--disable-setuid-sandbox/);
});
