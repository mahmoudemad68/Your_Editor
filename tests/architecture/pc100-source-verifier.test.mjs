/** Synthetic metadata tests, never a real policy approval or service result. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  BASELINE_SHA,
  BASELINE_FILES,
  OWN_FILES,
  WORKFLOW,
  INTEGRATION,
  REPOSITORY_ID,
  verifySourceSnapshot,
  verifyTrustedEvidence,
  readTrustedEvidence,
} from "../../tools/test/pc100-source-verifier.mjs";
const H = "a".repeat(40),
  B = "b".repeat(40),
  M = "c".repeat(40),
  TH = "d".repeat(40),
  TB = "e".repeat(40),
  T0 = "f".repeat(40);
function fixture() {
  const entry = (path, sha) => ({ path, sha, type: "blob", mode: "100644" });
  const old = BASELINE_FILES.map((p) => entry(p, "1".repeat(40))),
    own = OWN_FILES.map((p) => entry(p, "2".repeat(40)));
  return {
    trustedSHA: B,
    pr: {
      number: 100,
      state: "open",
      draft: true,
      merged: false,
      merge_commit_sha: M,
      head: { sha: H, repo: { id: REPOSITORY_ID } },
      base: { sha: B, repo: { id: REPOSITORY_ID } },
    },
    main: { name: "main", protected: true, commit: { sha: B, commit: { tree: { sha: TB } } } },
    head: { sha: H, tree: { sha: TH } },
    merge: { sha: M, tree: { sha: TH }, parents: [{ sha: B }, { sha: H }] },
    baseline: { sha: BASELINE_SHA, tree: { sha: T0 } },
    baselineTree: { sha: T0, truncated: false, tree: old },
    headTree: { sha: TH, truncated: false, tree: globalThis.structuredClone([...old, ...own]) },
    trustedTree: { sha: TB, truncated: false, tree: own },
    upstream: {
      id: 10,
      repository: { id: REPOSITORY_ID },
      head_repository: { id: REPOSITORY_ID },
      event: "pull_request",
      path: INTEGRATION,
      head_sha: H,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      pull_requests: [{ number: 100, head: { sha: H }, base: { sha: B } }],
    },
  };
}
function evidence() {
  const f = fixture();
  return {
    f,
    context: { H, B, M, TH, TM: TH },
    decision: {
      ...verifySourceSnapshot(f),
      files: Object.fromEntries([...BASELINE_FILES, ...OWN_FILES].map((p) => [p, "4".repeat(64)])),
      profile: "seaweedfs-go-s-w-production-candidate-v1",
      K: "5".repeat(64),
      L: "6".repeat(64),
    },
    run: {
      id: 20,
      workflow_id: 80,
      path: WORKFLOW,
      event: "workflow_run",
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      repository: { id: REPOSITORY_ID },
      head_repository: { id: REPOSITORY_ID },
      check_suite_id: 40,
      head_sha: B,
    },
    check: {
      id: 30,
      app: { id: 15368 },
      check_suite: { id: 40 },
      head_sha: B,
      name: "PC100 trusted source verification",
      status: "completed",
      conclusion: "success",
    },
  };
}
test("trusted verifier independently compares frozen baseline and protected-default source", () => {
  const f = fixture(),
    v = verifySourceSnapshot(f);
  assert.equal(v.decision, "DEVELOPMENT_SOURCE_VERIFIED");
  assert.equal(v.release_authorized, false);
  assert.equal(v.H, H);
  assert.equal(v.B, B);
});
for (const [name, edit] of [
  ["wrong PR", (f) => f.pr.number++],
  ["non-draft PR", (f) => (f.pr.draft = false)],
  ["closed PR", (f) => (f.pr.state = "closed")],
  ["foreign repository", (f) => f.pr.head.repo.id++],
  ["unprotected default", (f) => (f.main.protected = false)],
  ["default drift", (f) => (f.main.commit.sha = H)],
  ["base drift", (f) => (f.pr.base.sha = H)],
  ["wrong head", (f) => (f.head.sha = M)],
  ["wrong merge", (f) => (f.merge.sha = H)],
  ["wrong parents", (f) => f.merge.parents.reverse()],
  ["unequal trees", (f) => (f.merge.tree.sha = TB)],
  ["truncated source", (f) => (f.headTree.truncated = true)],
  ["duplicate paths", (f) => f.headTree.tree.push(f.headTree.tree[0])],
  ["baseline tampering", (f) => (f.headTree.tree[0].sha = "3".repeat(40))],
  ["verifier self modification", (f) => (f.headTree.tree.at(-1).sha = "3".repeat(40))],
  ["unsafe symlink", (f) => (f.headTree.tree[0].mode = "120000")],
  ["submodule", (f) => (f.headTree.tree[0].type = "commit")],
  ["missing critical file", (f) => f.headTree.tree.shift()],
  ["unapproved baseline", (f) => (f.baseline.sha = H)],
  ["incomplete preflight", (f) => (f.upstream.status = "in_progress")],
  ["failed preflight", (f) => (f.upstream.conclusion = "failure")],
  ["wrong preflight workflow", (f) => (f.upstream.path = WORKFLOW)],
  ["wrong preflight attempt", (f) => (f.upstream.run_attempt = 2)],
  ["cross-head preflight", (f) => (f.upstream.head_sha = M)],
  ["foreign preflight", (f) => f.upstream.repository.id++],
])
  test(`trusted verifier rejects ${name}`, () => {
    const f = fixture();
    edit(f);
    assert.throws(() => verifySourceSnapshot(f));
  });
test("trusted evidence is development-only and binds actual independent run/check", () => {
  const x = evidence();
  const v = verifyTrustedEvidence(x.decision, x.run, x.check, x.context, 80);
  assert.equal(v.evidence.run, 20);
  assert.match(v.record_sha256, /^[a-f0-9]{64}$/);
});
for (const [name, edit] of [
  ["production claim", (x) => (x.decision.release_authorized = true)],
  ["forged approval", (x) => (x.decision.decision = "APPROVED")],
  ["cross-head", (x) => (x.decision.H = M)],
  ["cross-base", (x) => (x.decision.B = H)],
  ["wrong tree", (x) => (x.decision.TH = TB)],
  ["untrusted workflow source", (x) => (x.decision.trusted_workflow_sha = H)],
  ["PR-controlled workflow", (x) => (x.run.event = "pull_request")],
  ["wrong workflow ID", (x) => x.run.workflow_id++],
  ["run retry", (x) => (x.run.run_attempt = 2)],
  ["failed verifier", (x) => (x.run.conclusion = "failure")],
  ["wrong check app", (x) => x.check.app.id++],
  ["wrong check suite", (x) => x.check.check_suite.id++],
  ["skipped check", (x) => (x.check.conclusion = "skipped")],
  ["missing file hash", (x) => delete x.decision.files[BASELINE_FILES[0]]],
  ["extra file hash", (x) => (x.decision.files["private"] = "4".repeat(64))],
])
  test(`trusted evidence rejects ${name}`, () => {
    const x = evidence();
    edit(x);
    assert.throws(() => verifyTrustedEvidence(x.decision, x.run, x.check, x.context, 80));
  });
test("a verifier present only in a PR cannot authorize its own installation", async () => {
  const x = evidence();
  await assert.rejects(
    () =>
      readTrustedEvidence(x.context, async (route) => {
        if (route === "branches/main") return x.f.main;
        if (route === `git/commits/${B}`) return { tree: { sha: TB } };
        if (route === `git/trees/${TB}?recursive=1`) return { sha: TB, truncated: false, tree: [] };
        throw Error("Unexpected fixture read");
      }),
    /TRUSTED_VERIFIER_NOT_INSTALLED/,
  );
});

function clientFixture() {
  const x = evidence();
  const rows = {
    "branches/main": x.f.main,
    [`git/commits/${B}`]: { tree: { sha: TB } },
    [`git/trees/${TB}?recursive=1`]: x.f.trustedTree,
    "actions/workflows/pc100-source-verifier.yml": { id: 80, path: WORKFLOW },
    "actions/workflows/80/runs?event=workflow_run&per_page=100": {
      total_count: 1,
      workflow_runs: [x.run],
    },
    "actions/runs/20/attempts/1/jobs?per_page=100": {
      jobs: [
        {
          name: x.check.name,
          conclusion: "success",
          status: "completed",
          run_id: 20,
          run_attempt: 1,
          check_run_url: "https://api.github.com/repos/mahmoudemad68/Your_Editor/check-runs/30",
        },
      ],
    },
    "check-runs/30": x.check,
    "check-runs/30/annotations?per_page=100": [
      { title: "PC100 development source", message: JSON.stringify(x.decision) },
    ],
    "actions/runs/10": x.f.upstream,
    "pulls/100": x.f.pr,
  };
  return {
    x,
    rows,
    read: async (route) => {
      assert.ok(Object.hasOwn(rows, route), `Unexpected fixture read: ${route}`);
      return rows[route];
    },
  };
}
test("trusted client reads genuine check association and independently rechecks live identities", async () => {
  const f = clientFixture();
  const result = await readTrustedEvidence(f.x.context, f.read);
  assert.equal(result.evidence.check, 30);
  assert.equal(result.release_authorized, false);
});
for (const [name, edit] of [
  [
    "ambiguous annotations",
    (f) =>
      f.rows["check-runs/30/annotations?per_page=100"].push(
        f.rows["check-runs/30/annotations?per_page=100"][0],
      ),
  ],
  ["forged check app", (f) => f.x.check.app.id++],
  [
    "foreign check URL",
    (f) =>
      (f.rows["actions/runs/20/attempts/1/jobs?per_page=100"].jobs[0].check_run_url =
        "https://attacker.example/check-runs/30"),
  ],
  [
    "wrong job attempt",
    (f) => (f.rows["actions/runs/20/attempts/1/jobs?per_page=100"].jobs[0].run_attempt = 2),
  ],
  ["ordinary failed preflight", (f) => (f.x.f.upstream.conclusion = "failure")],
  ["live HEAD drift", (f) => (f.x.f.pr.head.sha = M)],
  [
    "incomplete run inventory",
    (f) => (f.rows["actions/workflows/80/runs?event=workflow_run&per_page=100"].total_count = 101),
  ],
  ["no annotations", (f) => (f.rows["check-runs/30/annotations?per_page=100"] = [])],
])
  test(`trusted client rejects ${name}`, async () => {
    const f = clientFixture();
    edit(f);
    await assert.rejects(() => readTrustedEvidence(f.x.context, f.read));
  });
test("trusted workflow never checks out a PR, executes its files, or requests write permissions", async () => {
  const w = await readFile(
    new URL("../../.github/workflows/pc100-source-verifier.yml", import.meta.url),
    "utf8",
  );
  assert.match(w, /workflow_run:/);
  assert.match(w, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.doesNotMatch(
    w,
    /pull_request_target|contents: write|actions: write|issues: write|upload-artifact|head.sha|download-artifact/,
  );
});
