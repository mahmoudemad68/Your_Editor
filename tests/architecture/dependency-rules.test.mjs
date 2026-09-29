import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { cruise } from "dependency-cruiser";

const require = createRequire(import.meta.url);
const { forbidden } = require("../../tools/architecture/forbidden-rules.cjs");

const cruiseOptions = {
  ruleSet: { forbidden },
  validate: true,
  tsPreCompilationDeps: true,
  doNotFollow: { path: "node_modules" },
  exclude: {
    path: "(^|/)(dist|dist-test|\\.next|coverage)/",
  },
  outputType: "json",
};

async function runCruise(paths) {
  const result = await cruise(paths, cruiseOptions);
  const output = typeof result.output === "string" ? JSON.parse(result.output) : result.output;
  const names = new Set();
  for (const violation of output.summary?.violations ?? []) {
    const name = violation.rule?.name ?? violation.name;
    if (name) {
      names.add(name);
    }
  }
  return { errorCount: output.summary?.error ?? 0, names, output };
}

function assertRejected(result, ruleName) {
  assert.ok(result.errorCount > 0, JSON.stringify(result.output.summary, null, 2));
  assert.ok(result.names.has(ruleName), [...result.names].join(", ") || "(no rule names)");
}

test("domain import of an infrastructure package is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/domain-imports-infrastructure"]);
  assertRejected(result, "domain-no-infrastructure");
});

test("domain import of NestJS is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/domain-imports-framework"]);
  assertRejected(result, "domain-no-frameworks");
});

test("application import of infrastructure is rejected", async () => {
  const result = await runCruise([
    "tests/architecture/fixtures/application-imports-infrastructure",
  ]);
  assertRejected(result, "application-no-outer-layers");
});

test("cross-module domain import is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/domain-cross-module"]);
  assertRejected(result, "domain-modules-do-not-import-each-other");
});

test("production source satisfies the architecture rules", async () => {
  const result = await runCruise(["apps", "packages", "workers"]);
  assert.equal(
    result.errorCount,
    0,
    `${[...result.names].join(", ")}\n${JSON.stringify(result.output.summary?.violations, null, 2)}`,
  );
});
