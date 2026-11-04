/** Synthetic metadata tests, never a real policy approval or service result. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  BASELINE_FILES,
  OWN_FILES,
  WORKFLOW,
  INTEGRATION,
  REPOSITORY_ID,
  verifySourceSnapshot,
  verifyTrustedEvidence,
  readTrustedEvidence,
  observeTrustedEvidence,
  sourceInventory,
  hash,
  canonical,
  completePages,
  verifyEvent,
} from "../../tools/test/pc100-source-verifier.mjs";
const H = "a".repeat(40),
  B = "b".repeat(40),
  M = "c".repeat(40),
  TH = "d".repeat(40),
  TB = TH,
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
      head: { sha: H, ref: "fix/ci-ffmpeg-seaweedfs-security", repo: { id: REPOSITORY_ID } },
      base: { sha: B, ref: "main", repo: { id: REPOSITORY_ID } },
    },
    main: { name: "main", protected: true, commit: { sha: B, commit: { tree: { sha: TB } } } },
    head: { sha: H, tree: { sha: TH } },
    merge: { sha: M, tree: { sha: TH }, parents: [{ sha: B }, { sha: H }] },
    baseline: { sha: B, tree: { sha: TB } },
    baselineTree: { sha: TB, truncated: false, tree: globalThis.structuredClone([...old, ...own]) },
    headTree: { sha: TH, truncated: false, tree: globalThis.structuredClone([...old, ...own]) },
    trustedTree: { sha: TB, truncated: false, tree: globalThis.structuredClone([...old, ...own]) },
    upstream: {
      id: 10,
      workflow_id: 99,
      repository: { id: REPOSITORY_ID },
      head_repository: { id: REPOSITORY_ID },
      event: "pull_request",
      head_branch: "fix/ci-ffmpeg-seaweedfs-security",
      path: INTEGRATION,
      head_sha: H,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      pull_requests: [
        {
          number: 100,
          head: { sha: H, ref: "fix/ci-ffmpeg-seaweedfs-security" },
          base: { sha: B, ref: "main" },
        },
      ],
    },
  };
}
function evidence() {
  const f = fixture();
  return {
    f,
    context: { H, B, M, TH, TM: TH },
    decision: verifySourceSnapshot(f),
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
  assert.equal(v.decision, "DEVELOPMENT_SOURCE_INTEGRITY_VERIFIED");
  assert.equal(v.release_authorized, false);
  assert.equal(v.H, H);
  assert.equal(v.B, B);
});
for (const [name, edit] of [
  ["wrong PR", (f) => f.pr.number++],
  ["malformed draft metadata", (f) => (f.pr.draft = "false")],
  ["closed PR", (f) => (f.pr.state = "closed")],
  ["foreign repository", (f) => f.pr.head.repo.id++],
  ["unprotected default", (f) => (f.main.protected = false)],
  ["default drift", (f) => (f.main.commit.sha = H)],
  ["base drift", (f) => (f.pr.base.sha = H)],
  ["wrong head", (f) => (f.head.sha = M)],
  ["wrong merge", (f) => (f.merge.sha = H)],
  ["wrong parents", (f) => f.merge.parents.reverse()],
  ["unequal trees", (f) => (f.merge.tree.sha = T0)],
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
  ["wrong tree", (x) => (x.decision.TH = T0)],
  ["untrusted workflow source", (x) => (x.decision.trusted_workflow_sha = H)],
  ["PR-controlled workflow", (x) => (x.run.event = "pull_request")],
  ["wrong workflow ID", (x) => x.run.workflow_id++],
  ["run retry", (x) => (x.run.run_attempt = 2)],
  ["failed verifier", (x) => (x.run.conclusion = "failure")],
  ["wrong check app", (x) => x.check.app.id++],
  ["wrong check suite", (x) => x.check.check_suite.id++],
  ["skipped check", (x) => (x.check.conclusion = "skipped")],
  ["missing file hash", (x) => delete x.decision.inventory_sha256],
  ["extra file hash", (x) => (x.decision.file_count = 20001)],
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

const runsKey = `actions/workflows/80/runs?event=workflow_run&head_sha=${B}&per_page=100&page=1`;
function clientFixture() {
  const x = evidence();
  const rows = {
    "branches/main": x.f.main,
    [`git/commits/${B}`]: { tree: { sha: TB } },
    [`git/trees/${TB}?recursive=1`]: x.f.trustedTree,
    "actions/workflows/pc100-source-verifier.yml": { id: 80, path: WORKFLOW },
    [runsKey]: {
      total_count: 1,
      workflow_runs: [x.run],
    },
    "actions/runs/20/attempts/1/jobs?per_page=100&page=1": {
      total_count: 1,
      jobs: [
        {
          id: 21,
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
    "check-runs/30/annotations?per_page=100&page=1": [
      { title: "PC100 development source", message: JSON.stringify(x.decision) },
    ],
    [`actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${H}&per_page=100&page=1`]:
      { total_count: 1, workflow_runs: [x.f.upstream] },
    "actions/runs/10": x.f.upstream,
    "actions/workflows/pc100-artifact-integration.yml": { id: 99, path: INTEGRATION },
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

function pendingFixture() {
  const f = clientFixture();
  f.rows[runsKey] = {
    total_count: 0,
    workflow_runs: [],
  };
  f.rows[
    `actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${H}&per_page=100&page=1`
  ] = { total_count: 1, workflow_runs: [f.x.f.upstream] };
  return f;
}
test("same-attempt read reconciliation permits a later completed trusted verdict, never a workflow retry", async () => {
  const f = pendingFixture();
  let now = 0,
    reads = 0;
  const result = await readTrustedEvidence(f.x.context, f.read, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      reads++;
      f.rows[runsKey] = {
        total_count: 1,
        workflow_runs: [f.x.run],
      };
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.evidence.attempt, 1);
});
test("pending verifier cannot exceed the fixed same-attempt read deadline", async () => {
  const f = pendingFixture();
  let now = 0,
    waits = 0;
  await assert.rejects(
    () =>
      readTrustedEvidence(f.x.context, f.read, {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          waits++;
        },
      }),
    /POLICY_EVIDENCE_DEADLINE/,
  );
  assert.equal(now, 120000);
  assert.equal(waits, 40);
});
test("failed artifact preflight is terminal and never enters pending polling", async () => {
  const f = pendingFixture();
  f.x.f.upstream.conclusion = "failure";
  await assert.rejects(
    () =>
      readTrustedEvidence(f.x.context, f.read, {
        now: () => 0,
        sleep: async () => assert.fail("must not wait"),
      }),
    /POLICY_PREFLIGHT_NOT_QUALIFIED/,
  );
});
test("live HEAD drift during same-attempt polling fails closed", async () => {
  const f = pendingFixture();
  let now = 0;
  await assert.rejects(
    () =>
      readTrustedEvidence(f.x.context, f.read, {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          f.x.f.pr.head.sha = M;
        },
      }),
    /POLICY_LIVE_DRIFT/,
  );
});
test("pending metadata is distinguished from ambiguous completed evidence", async () => {
  const f = pendingFixture();
  await assert.rejects(
    () => observeTrustedEvidence(f.x.context, f.read),
    /POLICY_EVIDENCE_PENDING/,
  );
});
test("a successful observation finishing after the absolute deadline never admits", async () => {
  const f = clientFixture();
  let now = 0;
  await assert.rejects(
    () =>
      readTrustedEvidence(
        f.x.context,
        async (route) => {
          const value = await f.read(route);
          if (route === "check-runs/30/annotations?per_page=100&page=1") now = 120001;
          return value;
        },
        { now: () => now, sleep: async () => assert.fail("must not wait") },
      ),
    /POLICY_EVIDENCE_DEADLINE/,
  );
});
for (const [name, edit] of [
  [
    "ambiguous annotations",
    (f) =>
      f.rows["check-runs/30/annotations?per_page=100&page=1"].push(
        f.rows["check-runs/30/annotations?per_page=100&page=1"][0],
      ),
  ],
  ["forged check app", (f) => f.x.check.app.id++],
  [
    "foreign check URL",
    (f) =>
      (f.rows["actions/runs/20/attempts/1/jobs?per_page=100&page=1"].jobs[0].check_run_url =
        "https://attacker.example/check-runs/30"),
  ],
  [
    "wrong job attempt",
    (f) => (f.rows["actions/runs/20/attempts/1/jobs?per_page=100&page=1"].jobs[0].run_attempt = 2),
  ],
  ["ordinary failed preflight", (f) => (f.x.f.upstream.conclusion = "failure")],
  ["live HEAD drift", (f) => (f.x.f.pr.head.sha = M)],
  ["incomplete run inventory", (f) => (f.rows[runsKey].total_count = 101)],
  ["no annotations", (f) => (f.rows["check-runs/30/annotations?per_page=100&page=1"] = [])],
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

test("B1 matching PR-authored hash inventory cannot replace protected-main policy", () => {
  const f = fixture();
  f.headTree.tree[0].sha = "9".repeat(40);
  f.baselineTree.tree[0].sha = "9".repeat(40);
  assert.throws(() => verifySourceSnapshot(f), /UNTRUSTED_BASELINE_REJECTED/);
});
test("N1 both run and check at the same wrong base remain rejected", () => {
  const x = evidence();
  x.run.head_sha = x.check.head_sha = H;
  assert.throws(
    () => verifyTrustedEvidence(x.decision, x.run, x.check, x.context, 80),
    /POLICY_VERIFIER_RUN_REJECTED/,
  );
});
test("N2 complete trusted evidence is found after the first hundred runs", async () => {
  const f = clientFixture();
  const older = Array.from({ length: 100 }, (_, i) => ({
    ...f.x.run,
    id: 1000 + i,
    conclusion: "failure",
  }));
  f.rows[runsKey] = { total_count: 101, workflow_runs: older };
  f.rows[runsKey.replace("&page=1", "&page=2")] = { total_count: 101, workflow_runs: [f.x.run] };
  const result = await readTrustedEvidence(f.x.context, f.read);
  assert.equal(result.evidence.run, 20);
});
for (const [name, edit] of [
  [
    "missing final page",
    (f) =>
      (f.rows[runsKey.replace("&page=1", "&page=2")] = { total_count: 101, workflow_runs: [] }),
  ],
  [
    "duplicate run on another page",
    (f) =>
      (f.rows[runsKey.replace("&page=1", "&page=2")].workflow_runs[0] =
        f.rows[runsKey].workflow_runs[0]),
  ],
  ["unstable total", (f) => (f.rows[runsKey.replace("&page=1", "&page=2")].total_count = 102)],
  ["wrong HEAD association", (f) => (f.rows[runsKey].workflow_runs[0].head_sha = H)],
])
  test(`N2 rejects ${name}`, async () => {
    const f = clientFixture();
    f.rows[runsKey] = {
      total_count: 101,
      workflow_runs: Array.from({ length: 100 }, (_, i) => ({
        ...f.x.run,
        id: 1000 + i,
        conclusion: "failure",
      })),
    };
    f.rows[runsKey.replace("&page=1", "&page=2")] = { total_count: 101, workflow_runs: [f.x.run] };
    edit(f);
    await assert.rejects(() => readTrustedEvidence(f.x.context, f.read));
  });
test("N2 matching decisions from two genuine runs are ambiguous, never first-match accepted", async () => {
  const f = clientFixture(),
    second = { ...f.x.run, id: 21, check_suite_id: 41 };
  f.rows[runsKey] = { total_count: 2, workflow_runs: [f.x.run, second] };
  f.rows["actions/runs/21/attempts/1/jobs?per_page=100&page=1"] = {
    total_count: 1,
    jobs: [
      {
        ...f.rows["actions/runs/20/attempts/1/jobs?per_page=100&page=1"].jobs[0],
        id: 22,
        run_id: 21,
        check_run_url: "https://api.github.com/repos/mahmoudemad68/Your_Editor/check-runs/31",
      },
    ],
  };
  f.rows["check-runs/31"] = { ...f.x.check, id: 31, check_suite: { id: 41 } };
  f.rows["check-runs/31/annotations?per_page=100&page=1"] =
    f.rows["check-runs/30/annotations?per_page=100&page=1"];
  await assert.rejects(
    () => readTrustedEvidence(f.x.context, f.read),
    /POLICY_EVIDENCE_MISSING_OR_AMBIGUOUS/,
  );
});
test("complete pagination rejects API errors without returning a partial inventory", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      completePages(
        async () => {
          if (calls++) throw Error("API fixture failure");
          return {
            total_count: 101,
            workflow_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
          };
        },
        "runs",
        "workflow_runs",
      ),
    /API fixture failure/,
  );
});
test("development evidence cannot acquire candidate profile or approval fields", () => {
  const x = evidence();
  x.decision.profile = "seaweedfs-go-s-w-production-candidate-v1";
  assert.throws(
    () => verifyTrustedEvidence(x.decision, x.run, x.check, x.context, 80),
    /POLICY_SCOPE_REJECTED/,
  );
});
test("complete source inventory and SHA256 are stable and preserve executable modes", () => {
  const f = fixture(),
    a = sourceInventory(f.trustedTree);
  f.trustedTree.tree.reverse();
  assert.equal(hash(canonical(a)), hash(canonical(sourceInventory(f.trustedTree))));
  f.trustedTree.tree[0].mode = "100755";
  assert.notEqual(hash(canonical(a)), hash(canonical(sourceInventory(f.trustedTree))));
});
test("bootstrap workflow runs independent tests without importing PR100-only tools", async () => {
  const w = await readFile(
    new URL("../../.github/workflows/pc100-verifier-tests.yml", import.meta.url),
    "utf8",
  );
  assert.match(w, /pull_request:/);
  assert.match(w, /ubuntu-24.04/);
  assert.match(w, /windows-2022/);
  assert.match(w, /pc100-source-verifier-adversarial\.test\.mjs/);
  assert.doesNotMatch(
    w,
    /load-qualified-storage|seaweedfs-security-build|actions: write|contents: write|workflow_run|pull_request_target/,
  );
});

test("N3 actual bootstrap entry logic uses only available trusted module and GitHub metadata", async () => {
  const f = fixture(),
    calls = [];
  const rows = {
    "": { id: REPOSITORY_ID, default_branch: "main" },
    "pulls/100": f.pr,
    "branches/main": f.main,
    [`actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${H}&per_page=100&page=1`]:
      { total_count: 1, workflow_runs: [f.upstream] },
    "actions/runs/10": f.upstream,
    "actions/workflows/pc100-artifact-integration.yml": { id: 99, path: INTEGRATION },
    [`git/commits/${B}`]: f.baseline,
    [`git/commits/${H}`]: f.head,
    [`git/commits/${M}`]: f.merge,
    [`git/trees/${TH}?recursive=1`]: f.trustedTree,
  };
  const result = await verifyEvent({ workflow_run: { id: 10 } }, B, async (route) => {
    calls.push(route);
    assert.ok(Object.hasOwn(rows, route), route);
    return rows[route];
  });
  assert.equal(result.candidate_admission_authorized, false);
  assert.equal(result.baseline, B);
  assert.ok(
    calls.every(
      (route) =>
        !route.includes("/zip") &&
        !route.includes("load-qualified-storage") &&
        !route.includes("security-build.lock"),
    ),
  );
});
test("complete natural repository inventories do not overflow GitHub annotation records", () => {
  const f = fixture();
  const additional = Array.from({ length: 2000 }, (_, i) => ({
    path: `fixtures/input-${i}.json`,
    type: "blob",
    mode: "100644",
    sha: "1".repeat(40),
  }));
  for (const t of [f.headTree, f.baselineTree, f.trustedTree]) t.tree.push(...additional);
  const record = verifySourceSnapshot(f);
  assert.equal(record.file_count, Object.keys(sourceInventory(f.headTree)).length);
  assert.ok(Buffer.byteLength(canonical(record)) < 8192);
});

test("N3 Ready is not approval and does not invalidate unchanged development integrity", () => {
  const f = fixture();
  f.pr.draft = false;
  const result = verifySourceSnapshot(f);
  assert.equal(result.decision, "DEVELOPMENT_SOURCE_INTEGRITY_VERIFIED");
  assert.equal(result.candidate_admission_authorized, false);
  assert.equal(result.release_authorized, false);
});
