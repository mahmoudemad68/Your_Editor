/** Probe transport failures mean not-yet-ready, never false healthy status. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./media-analysis-orchestration.test.mjs", import.meta.url),
  "utf8",
);
const script = source.match(/`(import urllib\.request,urllib\.error\ntry: print\([\s\S]*?)`/u)?.[1];
assert.ok(script, "The production-container probe must remain exercised");
const readyScript = script.replace("${route}", "ready");
for (const [name, expression, expected] of [
  ["healthy", "return SimpleNamespace(status=200)", "200"],
  ["unready", "raise urllib.error.HTTPError('http://local/ready',503,'unready',{},None)", "503"],
  ["disconnected", "raise urllib.error.URLError('private-test-transport-detail')", "0"],
  ["bounded timeout", "raise TimeoutError('private-test-timeout-detail')", "0"],
]) {
  test(`real container readiness probe: ${name}`, () => {
    const prefix = `from types import SimpleNamespace\nimport urllib.request, urllib.error\ndef injected(*args, **kwargs):\n ${expression}\nurllib.request.urlopen=injected\n`;
    const output = execFileSync("python3", ["-c", prefix + readyScript], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(output.trim(), expected);
    assert.ok(!output.includes("private-test"));
  });
}
