import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { repositoryRoot } from "../../tools/evaluation/validate.mjs";

test("Supply Chain audits optional inference requirements and preserves separate evidence offline", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "evaluation-audit-")),
    bin = resolve(dir, "bin"),
    evidence = resolve(dir, "evidence");
  mkdirSync(bin);
  try {
    writeFileSync(
      resolve(bin, "uv"),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output-file" ]; then shift; printf "ruff==0.12.0\\n" > "$1"; exit 0; fi; shift; done\nexit 2\n',
      { mode: 0o755 },
    );
    writeFileSync(
      resolve(bin, "uvx"),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--requirement" ]; then shift; printf "%s\\n" "$1" >> "$AUDIT_INVOCATIONS"; case "$1" in */requirements-generation.txt) test "$OPTIONAL_SCAN_FAIL" != 1 || exit 2;; esac; fi; shift; done\nprintf \'{"dependencies":[]}\\n\'\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SUPPLY_CHAIN_EVIDENCE: evidence,
      AUDIT_INVOCATIONS: resolve(dir, "calls"),
      OPTIONAL_SCAN_FAIL: "0",
    };
    const command = resolve(repositoryRoot, "infra/scripts/audit-python.sh");
    const success = spawnSync("sh", [command], { env, encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(env.AUDIT_INVOCATIONS, "utf8").trim().split("\n").length, 2);
    assert.match(
      readFileSync(env.AUDIT_INVOCATIONS, "utf8"),
      /tools\/evaluation\/requirements-generation\.txt/,
    );
    for (const name of ["python-audit.json", "python-evaluation-audit.json"])
      assert.deepEqual(JSON.parse(readFileSync(resolve(evidence, name))), { dependencies: [] });
    const failure = spawnSync("sh", [command], {
      env: { ...env, OPTIONAL_SCAN_FAIL: "1" },
      encoding: "utf8",
    });
    assert.notEqual(
      failure.status,
      0,
      "A failed optional scan must fail the shared Supply Chain gate",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("optional inference rejects HIGH findings without relaxing the existing Python baseline policy", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "evaluation-audit-high-"));
  try {
    const vulnerability = "CVE-2026-4000",
      report = resolve(dir, "report.json");
    writeFileSync(
      resolve(dir, `${vulnerability}.json`),
      JSON.stringify({
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
      }),
    );
    writeFileSync(
      report,
      JSON.stringify({
        dependencies: [{ name: "synthetic-test", version: "1", vulns: [{ id: vulnerability }] }],
      }),
    );
    const args = [resolve(repositoryRoot, "infra/scripts/python_audit_report.py"), report, "1"],
      options = { env: { ...process.env, PYTHON_AUDIT_OSV_FIXTURE: dir }, encoding: "utf8" };
    assert.equal(spawnSync("python3", args, options).status, 0);
    const strict = spawnSync("python3", [...args, "--reject-high"], options);
    assert.equal(strict.status, 1);
    assert.match(strict.stdout, /High Python vulnerabilities/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
