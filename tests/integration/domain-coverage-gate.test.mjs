import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "package.json"));
test("US-116 AC2: the real Vitest/V8 domain gate rejects below 80% lines", () => {
  const dir = mkdtempSync(path.join(root, "tests/.coverage-proof-"));
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(
      path.join(dir, "src/example.ts"),
      `export function used() { return 1; }\n` +
        Array.from(
          { length: 12 },
          (_, i) =>
            `export function unused${i}() {\n  const value = ${i};\n  return value + 1;\n}\n`,
        ).join(""),
    );
    writeFileSync(
      path.join(dir, "src/example.test.ts"),
      'import { test, expect } from "vitest";\nimport { used } from "./example";\ntest("covered function", () => expect(used()).toBe(1));\n',
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"),
        "run",
        "--root",
        dir,
        "--config",
        path.join(root, "tools/test/vitest.config.mts"),
        "--coverage",
      ],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Coverage for lines.*does not meet.*80/);
    console.log("BELOW_THRESHOLD_EXIT_CODE", result.status);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
