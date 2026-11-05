import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectBootstrap } from "../../tools/test/pc100-bootstrap-preflight.mjs";
const H = "a".repeat(40),
  B = "b".repeat(40),
  M = "c".repeat(40);
function fixture(conclusion = "failure") {
  const routes = [];
  return {
    routes,
    read: async (route) => {
      routes.push(route);
      if (route === "branches/main") return { protected: true, commit: { sha: B } };
      if (route === "branches/main/protection")
        return { enforce_admins: { enabled: true }, required_status_checks: { contexts: ["ci"] } };
      if (route === "rules/branches/main")
        return [
          {
            type: "required_status_checks",
            ruleset_id: 77,
            parameters: { required_status_checks: [{ context: "supply-chain-security" }] },
          },
        ];
      if (route === "rulesets/77") return { id: 77, enforcement: "active", bypass_actors: [] };
      if (route.startsWith("pulls/"))
        return {
          number: Number(route.split("/")[1]),
          head: { sha: H },
          base: { sha: B, ref: "main" },
          merge_commit_sha: M,
        };
      if (route.startsWith("commits/"))
        return {
          total_count: 2,
          check_runs: ["ci", "supply-chain-security"].map((name, i) => ({
            id: i + 1,
            name,
            app: { id: 15368 },
            head_sha: M,
            status: "completed",
            conclusion,
          })),
        };
      assert.fail(route);
    },
  };
}
test("deadlock preflight is executable and only inspects fixed read endpoints", async () => {
  const f = fixture(),
    r = await inspectBootstrap(f.read);
  assert.equal(r.outcome, "BLOCKED_REQUIRED_CHECKS");
  assert.equal(r.enforce_admins, true);
  assert.equal(r.settings_mutation_authorized, false);
  assert.equal(r.candidate_admission_authorized, false);
  assert.equal(r.next_route, "REVIEW_CURRENT_BASE_AND_REPORTED_REQUIRED_CHECKS");
  assert.deepEqual(
    r.pulls.map((p) => p.pr),
    [103, 100],
  );
  assert.ok(f.routes.every((r) => !r.includes("tokens")));
});
test("green checks still never authorize merge or candidate admission", async () => {
  const r = await inspectBootstrap(fixture("success").read);
  assert.equal(r.outcome, "REQUIRED_CHECKS_PASS_REVIEW_STILL_REQUIRED");
  assert.equal(r.candidate_admission_authorized, false);
  assert.equal(r.release_authorized, false);
  assert.equal(r.live_a6_enforced, false);
  assert.equal(r.next_route, "INDEPENDENT_REVIEW_AND_OWNER_INSTALLATION_GATES");
});

test("post-Route-A checks on an old base cannot qualify current main", async () => {
  const f = fixture("success");
  const r = await inspectBootstrap(async (route) => {
    const value = await f.read(route);
    return route === "pulls/100"
      ? { ...value, base: { ...value.base, sha: "d".repeat(40) } }
      : value;
  });
  assert.equal(r.pulls.find((p) => p.pr === 103).on_current_base, true);
  assert.equal(r.pulls.find((p) => p.pr === 100).on_current_base, false);
  assert.equal(r.outcome, "BLOCKED_REQUIRED_CHECKS");
  assert.equal(r.candidate_admission_authorized, false);
});

test("main changing during read-only qualification is rejected", async () => {
  const f = fixture("success");
  let calls = 0;
  await assert.rejects(
    () =>
      inspectBootstrap(async (route) => {
        if (route === "branches/main" && ++calls === 2)
          return { protected: true, commit: { sha: "e".repeat(40) } };
        return f.read(route);
      }),
    /BOOTSTRAP_BASE_DRIFT/,
  );
});

test("unmergeable dependency cannot reuse old positive HEAD checks", async () => {
  const f = fixture("success");
  const r = await inspectBootstrap(async (route) => {
    const value = await f.read(route);
    return route === "pulls/100" ? { ...value, merge_commit_sha: null } : value;
  });
  const p = r.pulls.find((p) => p.pr === 100);
  assert.equal(p.test_merge_available, false);
  assert.equal(p.M, null);
  assert.ok(p.required.every((c) => c.check === null && c.status === "missing"));
  assert.equal(r.outcome, "BLOCKED_REQUIRED_CHECKS");
  assert.equal(r.candidate_admission_authorized, false);
  assert.ok(f.routes.every((route) => !route.includes("commits/null")));
});

test("incomplete or string-typed main identity cannot produce a readiness report", async () => {
  for (const main of [
    { protected: "true", commit: { sha: B } },
    { protected: true, commit: {} },
  ]) {
    const f = fixture("success");
    await assert.rejects(
      () => inspectBootstrap((route) => (route === "branches/main" ? main : f.read(route))),
      /BOOTSTRAP_PROTECTION_UNVERIFIABLE/,
    );
  }
});
test("incomplete protection and API errors remain unverified", async () => {
  for (const field of ["branches/main/protection", "rulesets/77"]) {
    const f = fixture();
    await assert.rejects(() => inspectBootstrap((r) => (r === field ? {} : f.read(r))));
  }
  await assert.rejects(() =>
    inspectBootstrap(() => {
      throw Error("403");
    }),
  );
});
