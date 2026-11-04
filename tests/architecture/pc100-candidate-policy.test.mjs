import { spawnSync, execFileSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import os from "node:os";
/** Hermetic software controls. Synthetic records confer no real approval. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { candidateFixture, blobSHA } from "./support/candidate-policy-fixture.mjs";
import {
  evaluateCandidatePolicy,
  readGitSourceBytes,
  verifyCandidateRecord,
  observeCandidateAdmission,
  readCandidateAdmission,
  readPolicyJSON,
  REGISTRY,
  LOCK,
  CANDIDATE_SCHEMA,
  verifyCandidateEvent,
  validateEnforcementRules,
  REQUIRED_WORKFLOW,
  verifyRequiredAdmission,
  validatePRWorkflowEnvironment,
  withoutQualificationCredentials,
} from "../../tools/test/pc100-candidate-policy.mjs";
import { selectUpstreamRun, canonical, hash } from "../../tools/test/pc100-source-verifier.mjs";

test("candidate admission is distinct from development integrity and production release", async () => {
  const f = candidateFixture(),
    v = await readCandidateAdmission(f.context, f.read);
  assert.equal(v.schema, CANDIDATE_SCHEMA);
  assert.equal(v.candidate_admission_authorized, true);
  assert.equal(v.release_authorized, false);
  assert.equal(v.evidence_check_id, 124);
  assert.equal(v.files[REGISTRY], hash(f.registryBytes));
});
for (const [name, edit] of [
  ["unprotected main", (f) => (f.snapshot.main.protected = false)],
  [
    "PR-controlled registry",
    (f) => (f.snapshot.targetTree.tree.find((e) => e.path === REGISTRY).sha = "9".repeat(40)),
  ],
  ["unreviewed baseline", (f) => (f.snapshot.reviewed.sha = "9".repeat(40))],
  ["missing security file", (f) => f.snapshot.targetTree.tree.pop()],
  [
    "added executable",
    (f) =>
      f.snapshot.targetTree.tree.push({
        path: "new/execution.mjs",
        mode: "100755",
        type: "blob",
        sha: "9".repeat(40),
        size: 1,
      }),
  ],
  [
    "entrypoint",
    (f) =>
      (f.snapshot.targetTree.tree.find(
        (e) => e.path === "infra/seaweedfs/docker-entrypoint.sh",
      ).sha = "9".repeat(40)),
  ],
  [
    "firewall",
    (f) =>
      (f.snapshot.targetTree.tree.find(
        (e) => e.path === "infra/seaweedfs/apply-container-firewall.sh",
      ).sha = "9".repeat(40)),
  ],
  [
    "network",
    (f) =>
      (f.snapshot.targetTree.tree.find(
        (e) => e.path === "infra/seaweedfs/storage-network.env",
      ).sha = "9".repeat(40)),
  ],
  ["executable mode", (f) => (f.snapshot.targetTree.tree[0].mode = "100755")],
  ["changed HEAD", (f) => (f.snapshot.pr.head.sha = "9".repeat(40))],
  ["changed base", (f) => (f.snapshot.pr.base.sha = "9".repeat(40))],
  ["changed merge", (f) => (f.snapshot.pr.merge_commit_sha = "9".repeat(40))],
  ["wrong tree", (f) => (f.snapshot.merge.tree.sha = "9".repeat(40))],
  ["reversed merge parents", (f) => f.snapshot.merge.parents.reverse()],
  ["policy inventory digest", (f) => (f.entry.inventory_sha256 = "9".repeat(64))],
  ["reviewed policy duplicates", (f) => f.registry.policies.push(f.entry)],
  ["production authorization", (f) => (f.entry.release_authorized = true)],
])
  test(`candidate policy rejects ${name}`, () => {
    const f = candidateFixture();
    edit(f);
    assert.throws(() => evaluateCandidatePolicy(f.snapshot));
  });
test("a PR registry entry cannot supply authority absent protected-main installation", async () => {
  const f = candidateFixture();
  f.snapshot.trustedTree.tree = f.snapshot.trustedTree.tree.filter((e) => e.path !== REGISTRY);
  await assert.rejects(
    () => observeCandidateAdmission(f.context, f.read),
    /CANDIDATE_POLICY_NOT_INSTALLED/,
  );
});
test("the shipped registry contains no authorizations", async () => {
  const bytes = await readFile(
    new URL("../../infra/seaweedfs/candidate-policy.json", import.meta.url),
  );
  // Git's Windows checkout converts LF to CRLF. Only this checkout fixture is
  // reconstructed as Git text; runtime always authenticates raw API blob bytes.
  assert.deepEqual(
    readPolicyJSON(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))).policies,
    [],
  );
});
test("runtime registry parsing never normalizes unauthenticated checkout line endings", () => {
  const text = JSON.stringify({ schema: "fixture", policies: [] }, null, 2) + "\n";
  assert.throws(
    () => readPolicyJSON(Buffer.from(text.replace(/\n/g, "\r\n"))),
    /CANDIDATE_JSON_NONCANONICAL/,
  );
});
for (const field of ["decision", "schema", "scope", "candidate_admission_authorized"])
  test(`development-only ${field} cannot authorize a candidate`, () => {
    const f = candidateFixture(),
      r = {
        ...f.decision,
        [field]:
          field === "candidate_admission_authorized"
            ? false
            : field === "schema"
              ? "pc100-development-integrity-v2"
              : "DEVELOPMENT_SOURCE_INTEGRITY_VERIFIED",
      };
    assert.throws(() =>
      verifyCandidateRecord(
        r,
        f.result.decision,
        f.run,
        f.check,
        f.rows["actions/workflows/pc100-candidate-admission.yml"],
      ),
    );
  });
for (const [name, edit] of [
  ["wrong app", (f) => f.check.app.id++],
  ["wrong check suite", (f) => f.check.check_suite.id++],
  ["wrong check HEAD", (f) => (f.check.head_sha = f.context.H)],
  ["same wrong run/check HEAD", (f) => (f.run.head_sha = f.check.head_sha = f.context.H)],
  ["wrong repository", (f) => f.run.repository.id++],
  ["wrong workflow", (f) => f.run.workflow_id++],
  ["cross-attempt", (f) => (f.run.run_attempt = 2)],
  ["failed workflow", (f) => (f.run.conclusion = "failure")],
  ["wrong policy digest", (f) => (f.decision.policy_sha256 = "9".repeat(64))],
  ["wrong inventory", (f) => (f.decision.inventory_sha256 = "9".repeat(64))],
  ["stale source", (f) => (f.decision.H = "9".repeat(40))],
  ["wrong lock", (f) => (f.decision.L = "9".repeat(64))],
])
  test(`candidate evidence rejects ${name}`, () => {
    const f = candidateFixture();
    edit(f);
    assert.throws(() =>
      verifyCandidateRecord(
        f.decision,
        f.result.decision,
        f.run,
        f.check,
        f.rows["actions/workflows/pc100-candidate-admission.yml"],
      ),
    );
  });
test("missing or duplicate evidence cannot be accepted", async () => {
  const f = candidateFixture();
  f.rows["check-runs/124/annotations?per_page=100&page=1"].push(
    f.rows["check-runs/124/annotations?per_page=100&page=1"][0],
  );
  await assert.rejects(
    () => observeCandidateAdmission(f.context, f.read),
    /CANDIDATE_EVIDENCE_MISSING_OR_AMBIGUOUS|POLICY_PAGE_DUPLICATE/,
  );
});
test("source lock and dependency hashes are immutable", () => {
  const f = candidateFixture();
  f.snapshot.lockBytes = Buffer.from("{}\n");
  assert.throws(() => evaluateCandidatePolicy(f.snapshot), /CANDIDATE_LOCK_DRIFT/);
});
test("scanner changes cannot be approved by a PR-provided matching inventory", () => {
  const f = candidateFixture();
  f.snapshot.targetTree.tree.find((e) => e.path === ".gitleaksignore").sha = "9".repeat(40);
  assert.throws(() => evaluateCandidatePolicy(f.snapshot));
});
test("registry rejects duplicate keys, invalid UTF8 and noncanonical JSON", () => {
  for (const raw of ['{"policies":[],"policies":[]}\n', ' {"x":1}\n', Buffer.from([0xff])])
    assert.throws(() => readPolicyJSON(Buffer.from(raw)));
});
test("registry permits normal formatted JSON without changing policy meaning", () => {
  const f = candidateFixture();
  assert.equal(
    canonical(readPolicyJSON(Buffer.from(JSON.stringify(f.registry, null, 2) + "\n"))),
    canonical(f.registry),
  );
});
test("real trusted workflow is read-only and never checks out or executes candidate code", async () => {
  const w = await readFile(
    new URL("../../.github/workflows/pc100-candidate-admission.yml", import.meta.url),
    "utf8",
  );
  assert.match(w, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.doesNotMatch(
    w,
    /pull_request_target|contents: write|actions: write|head.sha|upload-artifact|docker|load-qualified-storage/,
  );
});
test("missing candidate evidence has a bounded same-attempt deadline, not a workflow retry", async () => {
  const f = candidateFixture(),
    key = `actions/workflows/80/runs?event=workflow_run&head_sha=${f.context.B}&per_page=100&page=1`;
  f.rows[key] = { total_count: 0, workflow_runs: [] };
  let now = 0;
  await assert.rejects(
    () =>
      readCandidateAdmission(f.context, f.read, {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    /CANDIDATE_EVIDENCE_DEADLINE/,
  );
  assert.equal(now, 120000);
});

function refreshRegistry(f) {
  f.entry.inventory_sha256 = hash(canonical(f.entry.files));
  f.registryBytes = Buffer.from(canonical(f.registry) + "\n");
  f.snapshot.registryBytes = f.registryBytes;
  f.snapshot.requestedInventory = f.entry.inventory_sha256;
  for (const t of [f.snapshot.trustedTree, f.snapshot.targetTree]) {
    const e = t.tree.find((e) => e.path === REGISTRY);
    e.sha = blobSHA(f.registryBytes);
    e.size = f.registryBytes.length;
  }
}
function reviewedChange(f, p, bytes) {
  f.entry.files[p] = {
    git_blob_sha1: blobSHA(bytes),
    sha256: hash(bytes),
    mode: "100644",
    bytes: bytes.length,
  };
  for (const t of [f.snapshot.targetTree, f.snapshot.reviewedTree]) {
    const e = t.tree.find((e) => e.path === p);
    e.sha = blobSHA(bytes);
    e.size = bytes.length;
  }
  refreshRegistry(f);
}
test("even a matching reviewed manifest cannot relax protected scanner suppressions", () => {
  const f = candidateFixture();
  reviewedChange(f, ".gitleaksignore", Buffer.from("synthetic malicious suppression"));
  assert.throws(() => evaluateCandidatePolicy(f.snapshot), /CANDIDATE_SCANNER_POLICY_DRIFT/);
});
for (const [name, mutate] of [
  [
    "Go-jose downgrade",
    (l) => {
      l.modules["github.com/go-jose/go-jose/v4"].version = "v4.1.5";
      l.build.production_contract.modules["github.com/go-jose/go-jose/v4"].version = "v4.1.5";
    },
  ],
  [
    "Brotli downgrade",
    (l) => {
      l.modules["github.com/andybalholm/brotli"].version = "v1.2.6";
      l.build.production_contract.modules["github.com/andybalholm/brotli"].version = "v1.2.6";
    },
  ],
  [
    "unreviewed compiler",
    (l) => {
      l.toolchain.amd64_digest = "sha256:" + "9".repeat(64);
      l.build.production_contract.compiler.amd64_digest = l.toolchain.amd64_digest;
    },
  ],
  [
    "changed source archive",
    (l) => {
      l.source.sha256 = "9".repeat(64);
      l.build.production_contract.source.sha256 = l.source.sha256;
    },
  ],
  [
    "scanner downgrade",
    (l) => {
      l.scanners.trivy = "0.74.0";
      l.build.production_contract.scanners.trivy = "0.74.0";
    },
  ],
  [
    "budget increase",
    (l) => {
      l.limits.candidate_bytes++;
      l.build.production_contract.limits.candidate_bytes++;
    },
  ],
])
  test(`pinned candidate constraints reject ${name} despite consistent replacement hashes`, () => {
    const f = candidateFixture(),
      lock = JSON.parse(f.snapshot.lockBytes.toString());
    mutate(lock);
    lock.build.production_contract_sha256 = hash(canonical(lock.build.production_contract));
    const bytes = Buffer.from(JSON.stringify(lock) + "\n");
    f.snapshot.lockBytes = bytes;
    f.entry.K = lock.build.production_contract_sha256;
    f.entry.L = hash(bytes);
    reviewedChange(f, LOCK, bytes);
    assert.throws(() => evaluateCandidatePolicy(f.snapshot));
  });
test("missing check-suite identity cannot masquerade as two matching undefined identities", () => {
  const f = candidateFixture();
  delete f.run.check_suite_id;
  delete f.check.check_suite;
  assert.throws(() =>
    verifyCandidateRecord(
      f.decision,
      f.result.decision,
      f.run,
      f.check,
      f.rows["actions/workflows/pc100-candidate-admission.yml"],
    ),
  );
});
test("authenticated registry blob corruption is rejected before policy selection", async () => {
  const f = candidateFixture(),
    key = `git/blobs/${blobSHA(f.registryBytes)}`;
  f.rows[key].content = Buffer.from("{}\n").toString("base64");
  await assert.rejects(
    () => observeCandidateAdmission(f.context, f.read),
    /CANDIDATE_BLOB_DIGEST_MISMATCH/,
  );
});
test("an absent policy cannot be synthesized from the PR-provided source map", async () => {
  const f = candidateFixture();
  f.snapshot.registry.policies = [];
  const bytes = Buffer.from(canonical(f.registry) + "\n");
  const e = f.snapshot.trustedTree.tree.find((e) => e.path === REGISTRY);
  e.sha = blobSHA(bytes);
  e.size = bytes.length;
  f.rows[`git/blobs/${e.sha}`] = {
    sha: e.sha,
    size: bytes.length,
    encoding: "base64",
    content: bytes.toString("base64"),
  };
  await assert.rejects(
    () => observeCandidateAdmission(f.context, f.read),
    /CANDIDATE_POLICY_NOT_REVIEWED/,
  );
});
test("candidate source failure and policy denial are not eligible producer prerequisites", async () => {
  const f = candidateFixture();
  f.upstream.conclusion = "failure";
  await assert.rejects(
    () =>
      readCandidateAdmission(f.context, f.read, {
        now: () => 0,
        sleep: async () => assert.fail("ordinary failure must not wait"),
      }),
    /CANDIDATE_PREFLIGHT_REJECTED/,
  );
});

test("candidate metadata credentials cannot enter app/browser child environment", () => {
  const original = {
    ...process.env,
    GITHUB_TOKEN: "private-fixture",
    GH_TOKEN: "private-fixture",
    PC100_METADATA_TOKEN: "private-fixture",
    ACTIONS_RUNTIME_TOKEN: "private-fixture",
    ACTIONS_RESULTS_URL: "private-fixture",
    INPUT_GITHUB_TOKEN: "private-fixture",
    DATABASE_URL: "app-db",
    APP_SETTING: "safe",
  };
  const env = withoutQualificationCredentials(original);
  assert.equal(original.GITHUB_TOKEN, "private-fixture");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `const keys=Object.keys(process.env).filter(k=>/^(GITHUB_TOKEN|GH_TOKEN|PC100_METADATA_TOKEN|ACTIONS_.*|INPUT_GITHUB[-_]TOKEN)$/i.test(k));if(keys.length||process.env.APP_SETTING!=='safe')process.exit(1);`,
    ],
    { env, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(env.DATABASE_URL, "app-db");
});

// Independent QA register A-1..A-7. Synthetic metadata confers no authority.
for (const [name, edit] of [
  [
    "sibling PR association",
    (f) => f.upstream.pull_requests.unshift({ ...f.upstream.pull_requests[0], number: 101 }),
  ],
  ["wrong source branch", (f) => (f.upstream.head_branch = "attacker-sibling")],
  ["wrong base branch", (f) => (f.upstream.pull_requests[0].base.ref = "release")],
  ["fork upstream", (f) => f.upstream.head_repository.id++],
])
  test(`A-1 genuine preflight rejects ${name}`, async () => {
    const f = candidateFixture();
    edit(f);
    await assert.rejects(() =>
      verifyCandidateEvent({ workflow_run: { id: 130 } }, f.context.B, f.read),
    );
  });
test("A-2 every exported per-file SHA256 must authenticate actual Git bytes", async () => {
  const f = candidateFixture();
  f.entry.files["infra/seaweedfs/docker-entrypoint.sh"].sha256 = "0".repeat(64);
  refreshRegistry(f);
  assert.throws(() => evaluateCandidatePolicy(f.snapshot), /CANDIDATE_SOURCE_SHA256_MISMATCH/);
});
for (const key of [
  "scope",
  "release_authorized",
  "decision",
  "candidate_admission_authorized",
  "repository_id",
  "__proto__",
])
  test(`A-3 context rejects injected ${key}`, () => {
    const f = candidateFixture();
    Object.defineProperty(f.snapshot.context, key, { value: true, enumerable: true });
    assert.throws(() => evaluateCandidatePolicy(f.snapshot), /CANDIDATE_FIELDS_REJECTED/);
  });
test("A-4 duplicate lock keys fail despite recomputed digest", () => {
  const f = candidateFixture(),
    text = f.snapshot.lockBytes
      .toString()
      .replace('"go_version":"go1.26.10"', '"go_version":"go1.20.0","go_version":"go1.26.10"');
  assert.notEqual(text, f.snapshot.lockBytes.toString());
  const bytes = Buffer.from(text);
  f.snapshot.lockBytes = bytes;
  f.entry.L = hash(bytes);
  reviewedChange(f, LOCK, bytes);
  assert.throws(() => evaluateCandidatePolicy(f.snapshot), /CANDIDATE_JSON_NONCANONICAL/);
});
test("A-5 stale merge evidence does not poison current evidence selection", async () => {
  const f = candidateFixture(),
    key = `actions/workflows/80/runs?event=workflow_run&head_sha=${f.context.B}&per_page=100&page=1`,
    old = { ...f.run, id: 122 };
  f.rows[key] = { total_count: 2, workflow_runs: [old, f.run] };
  f.rows["actions/runs/122/attempts/1/jobs?per_page=100&page=1"] = {
    total_count: 1,
    jobs: [
      {
        ...f.rows["actions/runs/123/attempts/1/jobs?per_page=100&page=1"].jobs[0],
        id: 127,
        run_id: 122,
        check_run_url: "https://api.github.com/repos/mahmoudemad68/Your_Editor/check-runs/121",
      },
    ],
  };
  f.rows["check-runs/121"] = { ...f.check, id: 121 };
  f.rows["check-runs/121/annotations?per_page=100&page=1"] = [
    {
      title: "PC100 candidate admission",
      message: canonical({ ...f.decision, M: "9".repeat(40) }),
    },
  ];
  assert.equal((await observeCandidateAdmission(f.context, f.read)).evidence_run_id, 123);
});
for (const rules of [
  [],
  [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }],
  [
    {
      type: "workflows",
      parameters: {
        workflows: [{ repository_id: 1, path: REQUIRED_WORKFLOW, ref: "refs/heads/main" }],
      },
    },
  ],
])
  test("A-6 PR-controlled required statuses cannot replace a protected required workflow", () =>
    assert.throws(
      () =>
        validateEnforcementRules(rules, {
          schema: "pc100-independent-app-v1",
          repository_id: 1395822921,
          app_id: 246810,
          installation_id: 12345,
          slug: "independent-test-only",
          check_name: "PC100 independent security admission",
        }),
      /CANDIDATE_ENFORCEMENT_NOT_INSTALLED/,
    ));
for (const edit of [
  (f) => (f.rows["check-runs/143"].head_sha = f.context.B),
  (f) => f.rows["check-runs/143"].app.id++,
  (f) => (f.rows["check-runs/143"].conclusion = "failure"),
  (f) => (f.rows["rules/branches/main"] = []),
])
  test("A-6 exact H independent required check cannot be forged or omitted", async () => {
    const f = candidateFixture();
    edit(f);
    await assert.rejects(() => observeCandidateAdmission(f.context, f.read));
  });
test("A-6 honest exact H required check and protected rules are both necessary", async () => {
  const f = candidateFixture(),
    result = await observeCandidateAdmission(f.context, f.read);
  assert.equal(result.enforcement.check, 143);
  assert.equal(result.enforcement.app, 246810);
});
test("A-6 untrusted PR workflow source cannot execute as required trusted verifier", async () => {
  const f = candidateFixture();
  await assert.rejects(
    () =>
      verifyRequiredAdmission(
        { pull_request: f.snapshot.pr },
        f.context.B,
        {
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_WORKFLOW_SHA: f.context.H,
          GITHUB_REPOSITORY: "mahmoudemad68/Your_Editor",
        },
        f.read,
      ),
    /CANDIDATE_REQUIRED_WORKFLOW_UNTRUSTED/,
  );
});
test("A-7 strict child allowlist excludes credentials and Actions/shell control files", () => {
  const bad = Object.fromEntries(
    [
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_OUTPUT",
      "GITHUB_STATE",
      "GITHUB_STEP_SUMMARY",
      "BASH_ENV",
      "ENV",
      "GITHUB_PAT",
      "NPM_TOKEN",
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "PYTHONPATH",
      "ARBITRARY_SECRET",
    ].map((k) => [k, "private"]),
  );
  const env = withoutQualificationCredentials({
    ...bad,
    PATH: "runtime",
    HOME: "home",
    DATABASE_URL: "app-db",
    API_BASE_URL: "http://localhost",
    GRADUATION_DEMO_URL: "http://localhost",
  });
  for (const k of Object.keys(bad)) assert.equal(Object.hasOwn(env, k), false, k);
  assert.equal(env.API_BASE_URL, "http://localhost");
  assert.equal(env.DATABASE_URL, "app-db");
  assert.equal(env.PATH, "runtime");
});

test("A-5 unrelated same-named sibling runs cannot poison a valid native selection", async () => {
  const f = candidateFixture(),
    key = `actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${f.context.H}&per_page=100&page=1`;
  f.rows[key] = {
    total_count: 2,
    workflow_runs: [{ ...f.upstream, id: 999, head_branch: "attacker-sibling" }, f.upstream],
  };
  assert.equal((await selectUpstreamRun(f.read, f.snapshot.pr)).id, 130);
});

test("A-7/B-4 actual child cannot poison Actions command files through inherited environment", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pc100-env-isolation-")),
    paths = {};
  try {
    for (const key of ["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT"]) {
      paths[key] = path.join(dir, key);
      await writeFile(paths[key], "unchanged");
    }
    const env = withoutQualificationCredentials({
      ...process.env,
      ...paths,
      BASH_ENV: path.join(dir, "hook"),
      NPM_TOKEN: "private-fixture",
    });
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');for(const k of ['GITHUB_ENV','GITHUB_PATH','GITHUB_OUTPUT'])if(process.env[k])fs.appendFileSync(process.env[k],'POISON=1');if(process.env.NPM_TOKEN||process.env.BASH_ENV)process.exit(1);`,
      ],
      { env, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(r.status, 0, r.stderr);
    for (const p of Object.values(paths)) assert.equal(await readFile(p, "utf8"), "unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function requiredEnvironment(f) {
  return {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "mahmoudemad68/Your_Editor",
    GITHUB_WORKFLOW_SHA: f.context.M,
    GITHUB_WORKFLOW_REF: "mahmoudemad68/Your_Editor/" + REQUIRED_WORKFLOW + "@refs/pull/100/merge",
    GITHUB_RUN_ID: "140",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: f.context.M,
  };
}
test("A-6 actual required entry waits for concurrent preflight completion in the same attempt", async () => {
  const f = candidateFixture();
  f.upstream.status = "in_progress";
  f.upstream.conclusion = null;
  let now = 0,
    sleeps = 0;
  const result = await verifyRequiredAdmission(
    { pull_request: f.snapshot.pr },
    f.context.B,
    requiredEnvironment(f),
    f.read,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        sleeps++;
        f.upstream.status = "completed";
        f.upstream.conclusion = "success";
      },
    },
  );
  assert.equal(sleeps, 1);
  assert.equal(result.upstream_run, 130);
  assert.equal(result.release_authorized, false);
});
test("A-6 actual required entry bounds concurrent preflight waiting", async () => {
  const f = candidateFixture();
  f.upstream.status = "in_progress";
  f.upstream.conclusion = null;
  let now = 0;
  await assert.rejects(
    () =>
      verifyRequiredAdmission(
        { pull_request: f.snapshot.pr },
        f.context.B,
        requiredEnvironment(f),
        f.read,
        {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
      ),
    /CANDIDATE_PREFLIGHT_DEADLINE/,
  );
  assert.equal(now, 120000);
});
for (const conclusion of ["failure", "cancelled", "timed_out"])
  test(`A-6 actual required entry never retries ordinary ${conclusion}`, async () => {
    const f = candidateFixture();
    f.upstream.conclusion = conclusion;
    let sleeps = 0;
    await assert.rejects(
      () =>
        verifyRequiredAdmission(
          { pull_request: f.snapshot.pr },
          f.context.B,
          requiredEnvironment(f),
          f.read,
          {
            now: () => 0,
            sleep: async () => {
              sleeps++;
            },
          },
        ),
      /CANDIDATE_PREFLIGHT_REJECTED/,
    );
    assert.equal(sleeps, 0);
  });

test("A-2 actual complete Git-object batch authenticates every file without per-blob REST calls", () => {
  const git = (args, input) =>
    execFileSync("git", ["--no-replace-objects", ...args], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      input,
      maxBuffer: 132 * 1024 ** 2,
    });
  const H = git(["rev-parse", "HEAD"]).toString().trim();
  const rows = git(["ls-tree", "-r", "-z", H])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("\t"),
        [mode, type, id] = line.slice(0, at).split(" ");
      assert.equal(type, "blob");
      return { mode, id, p: line.slice(at + 1) };
    });
  const raw = git(["cat-file", "--batch"], rows.map((e) => e.id).join("\n") + "\n"),
    files = {};
  let at = 0;
  for (const row of rows) {
    const end = raw.indexOf(10, at),
      n = Number(raw.subarray(at, end).toString().split(" ")[2]),
      bytes = raw.subarray(end + 1, end + 1 + n);
    files[row.p] = { mode: row.mode, git_blob_sha1: row.id, bytes: n, sha256: hash(bytes) };
    at = end + 2 + n;
  }
  const result = readGitSourceBytes(H, files);
  assert.equal(Object.keys(result).length, rows.length);
  assert.ok(rows.length > 1000);
  for (const [p, e] of Object.entries(files)) assert.equal(hash(result[p]), e.sha256);
  const first = Object.keys(files)[0];
  files[first].sha256 = "0".repeat(64);
  assert.throws(() => readGitSourceBytes(H, files), /CANDIDATE_SOURCE_SHA256_MISMATCH/);
});

test("S2 native PR semantics bind workflow source to M while checkout is B", () => {
  const f = candidateFixture(),
    env = requiredEnvironment(f);
  assert.equal(
    validatePRWorkflowEnvironment({ pull_request: f.snapshot.pr }, f.context.B, env).M,
    f.context.M,
  );
  for (const edit of [
    (e) => (e.GITHUB_WORKFLOW_SHA = f.context.B),
    (e) => (e.GITHUB_WORKFLOW_SHA = f.context.H),
    (e) => (e.GITHUB_SHA = f.context.H),
    (e) =>
      (e.GITHUB_WORKFLOW_REF =
        "mahmoudemad68/Your_Editor/" + REQUIRED_WORKFLOW + "@refs/heads/main"),
    (e) => (e.GITHUB_REPOSITORY = "attacker/repo"),
  ]) {
    const bad = { ...env };
    edit(bad);
    assert.throws(
      () => validatePRWorkflowEnvironment({ pull_request: f.snapshot.pr }, f.context.B, bad),
      /CANDIDATE_REQUIRED_WORKFLOW_UNTRUSTED/,
    );
  }
});
