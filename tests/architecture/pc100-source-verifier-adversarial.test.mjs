/** Reproductions of Independent QA103's probes; metadata only, never approval. */
import assert from "node:assert/strict";
import { test } from "node:test";
import process from "node:process";
const v = await import(process.env.PR103_MODULE || "../../tools/test/pc100-source-verifier.mjs");
const H = "a".repeat(40),
  B = "b".repeat(40),
  M = "c".repeat(40),
  T = "d".repeat(40);
const productionPaths = [
  "infra/seaweedfs/docker-entrypoint.sh",
  "infra/seaweedfs/apply-container-firewall.sh",
  "infra/seaweedfs/apply-host-isolation.sh",
  "infra/seaweedfs/ensure-storage-network.sh",
  "infra/seaweedfs/verify-trust-boundary.sh",
  "infra/seaweedfs/storage-network.env",
  "compose.yaml",
  "compose.dev.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];
function fixture() {
  const entries = [...new Set([...v.BASELINE_FILES, ...v.OWN_FILES, ...productionPaths])].map(
    (path) => ({ path, type: "blob", mode: "100644", sha: "1".repeat(40) }),
  );
  return {
    trustedSHA: B,
    pr: {
      number: 100,
      state: "open",
      draft: true,
      merged: false,
      head: { sha: H, repo: { id: v.REPOSITORY_ID } },
      base: { sha: B, repo: { id: v.REPOSITORY_ID } },
      merge_commit_sha: M,
    },
    main: { name: "main", protected: true, commit: { sha: B, commit: { tree: { sha: T } } } },
    head: { sha: H, tree: { sha: T } },
    merge: { sha: M, tree: { sha: T }, parents: [{ sha: B }, { sha: H }] },
    baseline: { sha: v.SOURCE_SCOPE ? B : v.BASELINE_SHA, tree: { sha: T } },
    baselineTree: { sha: T, truncated: false, tree: globalThis.structuredClone(entries) },
    headTree: { sha: T, truncated: false, tree: globalThis.structuredClone(entries) },
    trustedTree: { sha: T, truncated: false, tree: globalThis.structuredClone(entries) },
    upstream: {
      id: 10,
      repository: { id: v.REPOSITORY_ID },
      head_repository: { id: v.REPOSITORY_ID },
      event: "pull_request",
      path: v.INTEGRATION,
      head_sha: H,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      pull_requests: [{ number: 100, head: { sha: H }, base: { sha: B } }],
    },
  };
}
test("QA103 B1 PR100 cannot nominate its own commit or exact hashes as independently approved policy", () => {
  const f = fixture();
  f.baseline.sha = "298abcb83b7f3a3bab68f539c038c8378ea0d3ac";
  assert.throws(() => v.verifySourceSnapshot(f), /UNTRUSTED_BASELINE_REJECTED/);
});
test("QA103-1 production ENTRYPOINT and newly loaded firewall/configuration cannot evade source verification", () => {
  const f = fixture();
  f.headTree.tree.find((e) => e.path === productionPaths[0]).sha = "9".repeat(40);
  f.headTree.tree.push({
    path: "infra/seaweedfs/extra-firewall.env",
    type: "blob",
    mode: "100644",
    sha: "8".repeat(40),
  });
  assert.throws(() => v.verifySourceSnapshot(f), /UNTRUSTED_SOURCE_REJECTED/);
});
test("QA103-2 matching run/check at the SAME wrong commit cannot impersonate protected main", () => {
  const f = fixture(),
    decision = v.verifySourceSnapshot(f);
  if (!v.SOURCE_SCOPE)
    Object.assign(decision, {
      files: Object.fromEntries(
        [...v.BASELINE_FILES, ...v.OWN_FILES].map((p) => [p, "4".repeat(64)]),
      ),
      profile: "seaweedfs-go-s-w-production-candidate-v1",
      K: "5".repeat(64),
      L: "6".repeat(64),
    });
  const run = {
    id: 20,
    workflow_id: 80,
    path: v.WORKFLOW,
    event: "workflow_run",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    repository: { id: v.REPOSITORY_ID },
    head_repository: { id: v.REPOSITORY_ID },
    check_suite_id: 40,
    head_sha: "0".repeat(40),
  };
  const check = {
    id: 30,
    app: { id: 15368 },
    check_suite: { id: 40 },
    head_sha: run.head_sha,
    name: "PC100 trusted source verification",
    status: "completed",
    conclusion: "success",
  };
  assert.throws(
    () => v.verifyTrustedEvidence(decision, run, check, { H, B, M, TH: T, TM: T }, 80),
    /POLICY_VERIFIER_RUN_REJECTED/,
  );
});
test("QA103-3 101 entries paginate completely instead of failing on the 101st run", async () => {
  assert.equal(typeof v.completePages, "function");
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 })),
    calls = [];
  const actual = await v.completePages(
    async (route) => {
      calls.push(route);
      const p = Number(new URL("https://fixture.invalid/" + route).searchParams.get("page"));
      return { total_count: 101, workflow_runs: rows.slice((p - 1) * 100, p * 100) };
    },
    "actions/workflows/80/runs?head_sha=" + B,
    "workflow_runs",
  );
  assert.equal(actual.length, 101);
  assert.equal(calls.length, 2);
});
test("QA103-4 existing Supply security policy modification remains rejected", () => {
  const f = fixture();
  f.headTree.tree.find((e) => e.path === ".github/workflows/supply-chain.yml").sha = "9".repeat(40);
  assert.throws(() => v.verifySourceSnapshot(f));
});
test("QA103-5 verifier self-modification remains rejected", () => {
  const f = fixture();
  f.headTree.tree.find((e) => e.path === v.MODULE).sha = "9".repeat(40);
  assert.throws(() => v.verifySourceSnapshot(f));
});
test("QA103-6 executable permission changes are rejected even when bytes match", () => {
  const f = fixture();
  f.headTree.tree.find((e) => e.path === "infra/seaweedfs/build-weed.sh").mode = "100755";
  assert.throws(() => v.verifySourceSnapshot(f));
});
for (const path of productionPaths)
  test(`full closure protects ${path}`, () => {
    const f = fixture();
    f.headTree.tree.find((e) => e.path === path).sha = "9".repeat(40);
    assert.throws(() => v.verifySourceSnapshot(f), /UNTRUSTED_SOURCE_REJECTED/);
  });
for (const operation of ["add", "remove", "rename", "mode"])
  test(`full closure rejects ${operation} of a previously unknown dependency`, () => {
    const f = fixture(),
      e = {
        path: "apps/new-plugin/executable.mjs",
        sha: "8".repeat(40),
        mode: "100644",
        type: "blob",
      };
    if (operation === "add") f.headTree.tree.push(e);
    else {
      for (const t of [f.headTree, f.trustedTree, f.baselineTree]) t.tree.push({ ...e });
      const target = f.headTree.tree.at(-1);
      if (operation === "remove") f.headTree.tree.pop();
      else if (operation === "rename") target.path = "apps/renamed-plugin/executable.mjs";
      else target.mode = "100755";
    }
    assert.throws(() => v.verifySourceSnapshot(f), /UNTRUSTED_SOURCE_REJECTED/);
  });
test("development integrity evidence cannot become a candidate approval by adding fields", () => {
  const f = fixture(),
    d = v.verifySourceSnapshot(f);
  assert.equal(d.candidate_admission_authorized, false);
  assert.equal(d.release_authorized, false);
  assert.notEqual(d.schema, "pc100-development-policy-v1");
  assert.equal(Object.hasOwn(d, "profile"), false);
  assert.equal(Object.hasOwn(d, "K"), false);
});
