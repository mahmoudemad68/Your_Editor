/** Hermetic software controls. Synthetic records confer no real approval. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { candidateFixture, blobSHA } from "./support/candidate-policy-fixture.mjs";
import {
  evaluateCandidatePolicy,
  verifyCandidateRecord,
  observeCandidateAdmission,
  readCandidateAdmission,
  readPolicyJSON,
  REGISTRY,
  LOCK,
  CANDIDATE_SCHEMA,
} from "../../tools/test/pc100-candidate-policy.mjs";
import { canonical, hash } from "../../tools/test/pc100-source-verifier.mjs";

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
