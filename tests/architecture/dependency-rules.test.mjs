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

test("presentation import of infrastructure is rejected", async () => {
  const result = await runCruise([
    "tests/architecture/fixtures/presentation-imports-infrastructure",
  ]);
  assertRejected(result, "presentation-no-infrastructure");
});

test("Next.js app router import of infrastructure is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/app-router-imports-infrastructure"]);
  assertRejected(result, "presentation-no-infrastructure");
});

test("a package import of an app is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/package-imports-app"]);
  assertRejected(result, "packages-no-deployables");
});

test("a worker import of an app is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/worker-imports-app"]);
  assertRejected(result, "workers-no-apps");
});

test("a circular dependency is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/circular"]);
  assertRejected(result, "no-circular");
});

test("an unresolved production import is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/unresolved-production-import"]);
  assertRejected(result, "no-unresolved");
});

test("an unresolved external framework import from domain is rejected", async () => {
  const result = await runCruise(["tests/architecture/fixtures/domain-unresolved-framework"]);
  assertRejected(result, "no-unresolved");
});

test("Next.js source may import react without an architecture violation", async () => {
  const result = await runCruise(["apps/web/src"]);
  assert.equal(
    result.errorCount,
    0,
    `${[...result.names].join(", ")}\n${JSON.stringify(result.output.summary?.violations, null, 2)}`,
  );
  const reactImports = [];
  for (const mod of result.output.modules ?? []) {
    for (const dep of mod.dependencies ?? []) {
      if (dep.module === "react" || dep.module === "next" || dep.module?.startsWith("next/")) {
        reactImports.push(dep);
      }
    }
  }
  assert.ok(reactImports.length > 0, "expected apps/web to import react or next");
  assert.ok(reactImports.every((dep) => dep.couldNotResolve !== true));
});

test("production source satisfies the architecture rules", async () => {
  const result = await runCruise(["apps", "packages", "workers"]);
  assert.equal(
    result.errorCount,
    0,
    `${[...result.names].join(", ")}\n${JSON.stringify(result.output.summary?.violations, null, 2)}`,
  );
});
