/** Prove the aggregate rejects every failing status and accepts only an allowed OBSERVED exclusion. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gate = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "qa93-gate-"));
const results = [];
function run(name, body, allow = "") {
  const file = path.join(dir, name + ".json");
  writeFileSync(file, JSON.stringify(body));
  const child = spawnSync(process.execPath, [gate, file, allow], { encoding: "utf8" });
  return child.status ?? 99;
}
function expect(id, actual, expected) {
  const status = actual === expected ? "PASS" : "FAIL";
  results.push({
    id,
    title: id,
    status,
    expected: `exit ${expected}`,
    actual: `exit ${actual}`,
    ms: 0,
  });
  console.log(`[QA93] ${id} ${status}`);
}
try {
  const base = {
    results: [{ id: "T", title: "t", status: "PASS", expected: "ok", actual: { n: 1 }, ms: 0 }],
  };
  expect("G4-INJECT-PASS", run("pass", base), 0);
  for (const status of ["FAIL", "ERROR", "NOT_RUN", "NOT_VERIFIED"]) {
    expect(
      `G4-INJECT-${status}`,
      run(status, {
        results: [{ id: "T", title: "t", status, expected: "x", actual: null, ms: 0 }],
      }),
      1,
    );
  }
  expect(
    "G4-INJECT-OBSERVED-UNLISTED",
    run("obs", {
      results: [
        {
          id: "NOTE",
          title: "t",
          status: "OBSERVED",
          exclusion: "x".repeat(50),
          expected: "",
          actual: null,
          ms: 0,
        },
      ],
    }),
    1,
  );
  expect(
    "G4-INJECT-OBSERVED-ALLOWED",
    run(
      "obs-ok",
      {
        results: [
          {
            id: "NOTE",
            title: "t",
            status: "OBSERVED",
            exclusion:
              "Written exclusion for a non-blocking observation that is not an acceptance requirement.",
            expected: "",
            actual: null,
            ms: 0,
          },
        ],
      },
      "NOTE",
    ),
    0,
  );
  expect("G4-INJECT-EMPTY", run("empty", { results: [] }), 1);
  expect(
    "G4-INJECT-MISSING-STATUS",
    run("bad", {
      results: [{ id: "T", title: "t", status: "MAYBE", expected: "", actual: null, ms: 0 }],
    }),
    1,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const out = process.argv[2];
if (out) {
  const { writeReport } = await import("./report.mjs");
  writeReport(out, results, { suite: "gate-self-test" });
}
if (results.some((r) => r.status !== "PASS")) process.exit(1);
