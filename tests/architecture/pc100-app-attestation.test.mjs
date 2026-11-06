/** MOCK GitHub transport; real ephemeral crypto. Never reads real App credentials. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  candidateFixture,
  blobSHA,
  branchBypassFixture,
  supplyJobsFixture,
} from "./support/candidate-policy-fixture.mjs";
import { canonical, hash, sourceInventory } from "../../tools/test/pc100-source-verifier.mjs";
import {
  reconcileAppCheck,
  authorizeOrdinarySource,
} from "../../tools/test/pc100-admission-app.mjs";
import { observeAuthenticatedCandidateAdmission } from "../../tools/test/pc100-candidate-policy.mjs";
import {
  readAppTrust,
  verifySourceAuthorization,
  createConsumerAttestation,
  verifyConsumerAttestation,
  decodeAuthorityJSON,
  collectProtectionAttestation,
  collectProtectionEvidence,
  controlPlanePath,
  isVerifiedConsumerEvidence,
  CONTROL_PATHS,
  TRUST_CONFIG,
} from "../../tools/test/pc100-app-attestation.mjs";
const authority = generateKeyPairSync("ed25519");
const keyID = hash(authority.publicKey.export({ format: "der", type: "spki" }));
const now = 1800000000000;
// Literal field omission observed by independent QA. This is a replay fixture,
// not proof that the read-only Reader App can access the GraphQL alternative.
const omittedLegacyProtection = () => ({
  enforce_admins: { enabled: true },
  required_status_checks: { strict: true },
  required_pull_request_reviews: {
    url: "https://api.github.com/repos/mahmoudemad68/Your_Editor/branches/main/protection/required_pull_request_reviews",
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
    required_approving_review_count: 1,
  },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
});

function fixture({ enabled = true, sourceAuthority = true, revoked = false } = {}) {
  const seed = candidateFixture(),
    content = { ...seed.content };
  for (const p of CONTROL_PATHS) content[p] ??= Buffer.from(`synthetic:${p}`);
  const app = {
    schema: "pc100-independent-app-v1",
    repository_id: 1395822921,
    app_id: 246810,
    installation_id: 12345,
    slug: "independent-test-only",
    check_name: "PC100 independent security admission",
    consumer_attestation: enabled,
    protection_reader: {
      schema: "pc100-protection-reader-v1",
      repository_id: 1395822921,
      app_id: 357911,
      installation_id: 23456,
      slug: "reader-synthetic-only",
    },
  };
  content[TRUST_CONFIG] = Buffer.from(
    canonical({
      schema: "pc100-app-trust-v1",
      repository_id: 1395822921,
      consumer_attestation_enabled: enabled,
      source_authority: sourceAuthority
        ? {
            algorithm: "Ed25519",
            key_id: keyID,
            public_key: authority.publicKey.export({ format: "pem", type: "spki" }),
          }
        : null,
      revoked_authorizations: revoked ? ["9".repeat(64)] : [],
    }) + "\n",
  );
  const f = candidateFixture({ fileBytes: content, appConfig: app });
  f.app = app;
  f.full = { repository_id: 1395822921, pr: 100, ...f.context, TB: f.snapshot.trustedTree.sha };
  f.rows["actions/workflows/99"] = { id: 99, path: f.upstream.path };
  f.rows["branches/main/protection"].required_pull_request_reviews.bypass_pull_request_allowances =
    { users: [], teams: [], apps: [] };
  f.routes = [];
  const read = f.read;
  f.read = async (route, ...rest) => {
    f.routes.push(route);
    return read(route, ...rest);
  };
  return f;
}
function ordinary(f) {
  f.snapshot.targetTree.tree.push({
    path: "docs/ordinary-change.md",
    type: "blob",
    mode: "100644",
    sha: "8".repeat(40),
    size: 1,
  });
  const pr = { ...globalThis.structuredClone(f.snapshot.pr), number: 104 };
  f.rows["pulls/104"] = pr;
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [
    { number: 104, head: { sha: pr.head.sha } },
  ];
  f.snapshot.pr.state = "closed";
  f.snapshot.pr.merged = true;
  const context = {
    repository_id: 1395822921,
    pr: 104,
    H: pr.head.sha,
    B: pr.base.sha,
    M: pr.merge_commit_sha,
    head_repository_id: 1395822921,
    state: "open",
    draft: true,
    merged: false,
  };
  f.rows[
    `commits/${context.H}/check-runs?check_name=${encodeURIComponent(f.app.check_name)}&filter=all&per_page=100&page=1`
  ] = { total_count: 0, check_runs: [] };
  return context;
}
function signedReview(f, anchors, c, edit = () => {}) {
  const payload = {
    schema: "pc100-source-change-authorization-v1",
    repository_id: 1395822921,
    pr: c.pr,
    H: c.H,
    B: c.B,
    TH: f.snapshot.targetTree.sha,
    TB: anchors.TB,
    M: c.M,
    TM: f.snapshot.targetTree.sha,
    source_inventory_sha256: hash(canonical(sourceInventory(f.snapshot.targetTree))),
    policy_sha256: anchors.policy_sha256,
    observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 600000).toISOString(),
    nonce: "9".repeat(64),
    scope: "ordinary-source-change",
    candidate_admission_authorized: false,
    release_authorized: false,
  };
  edit(payload);
  return {
    schema: "pc100-source-authorization-envelope-v1",
    payload,
    signature: sign(null, Buffer.from(canonical(payload)), authority.privateKey).toString(
      "base64url",
    ),
  };
}
async function consumerFixture({ emptyRegistry = false } = {}) {
  const f = fixture();
  if (emptyRegistry) {
    const bytes = Buffer.from(canonical({ ...f.registry, policies: [] }) + "\n"),
      sha = blobSHA(bytes);
    for (const tree of [f.snapshot.trustedTree, f.snapshot.targetTree, f.snapshot.reviewedTree])
      Object.assign(
        tree.tree.find((e) => e.path === "infra/seaweedfs/candidate-policy.json"),
        { sha, size: bytes.length },
      );
    f.rows[`git/blobs/${sha}`] = {
      sha,
      encoding: "base64",
      content: bytes.toString("base64"),
      size: bytes.length,
    };
  }
  f.rows["actions/runs/131"] = {
    ...globalThis.structuredClone(f.upstream),
    id: 131,
    workflow_id: 98,
    path: ".github/workflows/supply-chain.yml",
  };
  f.rows["actions/workflows/98"] = { id: 98, path: ".github/workflows/supply-chain.yml" };
  supplyJobsFixture(f, f.rows["actions/runs/131"]);
  const anchors = await readAppTrust(f.read, f.context.B);
  const r = globalThis.structuredClone(
    await createConsumerAttestation(
      f.read,
      anchors,
      f.full,
      f.decision,
      {
        preflight: { id: 130, attempt: 1, workflow_id: 99 },
        supply: { id: 131, attempt: 1, workflow_id: 98 },
      },
      ["preflight"],
      now,
    ),
  );
  const check = f.rows["check-runs/143"];
  check.output = { title: "PC100 consumer attestation", summary: canonical(r) + "\n" };
  check.external_id = hash(canonical(r));
  check.completed_at = new Date(now).toISOString();
  f.record = r;
  f.anchors = anchors;
  f.publicRead = async (route) => {
    assert.ok(
      !route.includes("/protection") && !route.startsWith("rulesets/"),
      "private N2 API reached by Actions consumer",
    );
    return f.read(route);
  };
  return f;
}
function replaceRecord(f, edit) {
  edit(f.record);
  f.record.protection_sha256 = hash(canonical(f.record.protection));
  const c = f.rows["check-runs/143"];
  c.output.summary = canonical(f.record) + "\n";
  c.external_id = hash(canonical(f.record));
}

test("QA107 BLOCKER-1 literal omitted REST field accepts only corroborated Reader GraphQL", async () => {
  const f = fixture();
  f.rows["branches/main/protection"] = omittedLegacyProtection();
  f.read.branchProtectionGraphQL = async () => branchBypassFixture(f.context.B);
  const result = await collectProtectionAttestation(f.read, f.app);
  assert.equal(result.branch_bypass.source, "reader-graphql-corroboration-v1");
  assert.equal(result.branch_bypass.B, f.context.B);
  assert.equal(result.bypass_visible, true);
});
test("synthetic independent Ed25519 source review binds complete path/mode/blob tree", async () => {
  const f = fixture(),
    c = ordinary(f),
    a = await readAppTrust(f.read, c.B),
    signed = signedReview(f, a, c);
  const result = verifySourceAuthorization(signed, a, c, f.snapshot.targetTree, now);
  assert.equal(result.decision, "AUTHORIZED_SOURCE_CHANGE");
  const live = signedReview(f, a, c);
  f.read.sourceAuthorization = async () => Buffer.from(canonical(live) + "\n");
  // Use current synthetic time for the real controller path, not a frozen old timestamp.
  const delta = Date.now() - now;
  live.payload.observed_at = new Date(now + delta).toISOString();
  live.payload.expires_at = new Date(now + delta + 600000).toISOString();
  live.signature = sign(null, Buffer.from(canonical(live.payload)), authority.privateKey).toString(
    "base64url",
  );
  const decision = await authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree);
  assert.equal(decision.decision, "AUTHORIZED_SOURCE_CHANGE");
});
for (const field of [
  "repository_id",
  "pr",
  "H",
  "B",
  "TH",
  "TB",
  "M",
  "TM",
  "policy_sha256",
  "source_inventory_sha256",
  "nonce",
  "scope",
  "candidate_admission_authorized",
  "release_authorized",
])
  test(`source review rejects correctly signed but wrong ${field}`, async () => {
    const f = fixture(),
      c = ordinary(f),
      a = await readAppTrust(f.read, c.B);
    const r = signedReview(
      f,
      a,
      c,
      (p) =>
        (p[field] =
          typeof p[field] === "boolean"
            ? true
            : typeof p[field] === "number"
              ? 999
              : "0".repeat(40)),
    );
    assert.throws(() => verifySourceAuthorization(r, a, c, f.snapshot.targetTree, now));
  });
for (const path of [
  "docs/readme.md",
  "pnpm-lock.yaml",
  "infra/seaweedfs/candidate-app.json",
  "infra/seaweedfs/candidate-policy.json",
  ".github/dependabot.yml",
  "new/executable.sh",
])
  test(`independent source review cannot ignore ${path}`, async () => {
    const f = fixture(),
      c = ordinary(f),
      a = await readAppTrust(f.read, c.B),
      r = signedReview(f, a, c);
    f.snapshot.targetTree.tree.push({
      path,
      type: "blob",
      mode: "100755",
      sha: "9".repeat(40),
      size: 1,
    });
    assert.throws(() => verifySourceAuthorization(r, a, c, f.snapshot.targetTree, now));
  });
test("signature made by the PR itself never authorizes its own source", async () => {
  const f = fixture(),
    c = ordinary(f),
    a = await readAppTrust(f.read, c.B),
    r = signedReview(f, a, c),
    attacker = generateKeyPairSync("ed25519");
  r.signature = sign(null, Buffer.from(canonical(r.payload)), attacker.privateKey).toString(
    "base64url",
  );
  assert.throws(() => verifySourceAuthorization(r, a, c, f.snapshot.targetTree, now), /SIGNATURE/);
  assert.throws(
    () => verifySourceAuthorization(r, { ...a }, c, f.snapshot.targetTree, now),
    /NOT_CONFIGURED/,
  );
});
for (const label of [
  "mode",
  "removed",
  "renamed",
  "expired",
  "future",
  "revoked",
  "missing authority",
  "alternate PR",
  "fork alias",
])
  test(`source authorization rejects ${label}`, async () => {
    const f = fixture({
        sourceAuthority: label !== "missing authority",
        revoked: label === "revoked",
      }),
      c = ordinary(f),
      a = await readAppTrust(f.read, c.B),
      r = signedReview(f, a, c);
    if (label === "mode") f.snapshot.targetTree.tree[0].mode = "100755";
    if (label === "removed") f.snapshot.targetTree.tree.pop();
    if (label === "renamed") f.snapshot.targetTree.tree[0].path = "renamed.txt";
    if (label === "alternate PR") c.pr = 105;
    if (label === "fork alias") {
      c.head_repository_id = 999;
      await assert.rejects(
        () => authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree),
        /ALIAS/,
      );
      return;
    }
    assert.throws(() =>
      verifySourceAuthorization(
        r,
        a,
        c,
        f.snapshot.targetTree,
        label === "expired" ? now + 600001 : label === "future" ? now - 30001 : now,
      ),
    );
  });
test("multiple PR aliases at the same H cannot borrow an ordinary review", async () => {
  const f = fixture(),
    c = ordinary(f);
  f.rows["pulls?state=open&base=main&per_page=100&page=1"].push({
    number: 105,
    head: { sha: c.H },
  });
  await assert.rejects(
    () => authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree),
    /ALIAS/,
  );
});
test("changed source stays failure without an independent authorization provider", async () => {
  const f = fixture(),
    c = ordinary(f),
    writes = [];
  const read = async (route, method, body) => {
    if (method) {
      writes.push(body);
      return { ...body, id: 999, app: { id: f.app.app_id, slug: f.app.slug } };
    }
    return f.read(route);
  };
  const r = await reconcileAppCheck(read, f.app, undefined, c.pr);
  assert.equal(r.conclusion, "failure");
  assert.equal(r.outcome, "APP_UNREVIEWED_SOURCE");
  assert.ok(writes.every((w) => w.conclusion === "failure"));
});
test("actual controller publishes authorized changed source as success, never neutral/candidate", async () => {
  const f = fixture({ enabled: false }),
    c = ordinary(f),
    anchors = await readAppTrust(f.read, c.B),
    r = signedReview(f, anchors, c);
  const observed = Date.now();
  r.payload.observed_at = new Date(observed).toISOString();
  r.payload.expires_at = new Date(observed + 600000).toISOString();
  r.signature = sign(null, Buffer.from(canonical(r.payload)), authority.privateKey).toString(
    "base64url",
  );
  let published;
  const read = async (route, method, body) => {
    if (method) {
      published = { ...published, ...body, id: 999, app: { id: f.app.app_id, slug: f.app.slug } };
      return published;
    }
    return f.read(route);
  };
  read.sourceAuthorization = async () => Buffer.from(canonical(r) + "\n");
  const result = await reconcileAppCheck(read, f.app, undefined, c.pr);
  assert.equal(result.conclusion, "success");
  const record = JSON.parse(published.output.summary);
  assert.equal(record.schema, "pc100-authorized-source-change-v1");
  assert.equal(record.decision, "AUTHORIZED_SOURCE_CHANGE");
  assert.equal(record.candidate_admission_authorized, false);
  assert.equal(record.release_authorized, false);
});
test("consumer failures never echo an injected token or malformed JSON excerpt", async () => {
  const canary = "SYNTHETIC_PRIVATE_CREDENTIAL";
  assert.throws(
    () => decodeAuthorityJSON(Buffer.from(canary)),
    (error) => !String(error).includes(canary),
  );
  const f = await consumerFixture();
  await assert.rejects(
    () =>
      verifyConsumerAttestation(
        async () => {
          throw Error(canary);
        },
        f.full,
        { now },
      ),
    (error) =>
      error.message === "ATTESTATION_OPERATION_REJECTED" && !String(error).includes(canary),
  );
});
test("source review and record revocation after check publication invalidates success", async () => {
  const f = fixture({ enabled: false }),
    c = ordinary(f),
    anchors = await readAppTrust(f.read, c.B),
    r = signedReview(f, anchors, c);
  const observed = Date.now();
  r.payload.observed_at = new Date(observed).toISOString();
  r.payload.expires_at = new Date(observed + 600000).toISOString();
  r.signature = sign(null, Buffer.from(canonical(r.payload)), authority.privateKey).toString(
    "base64url",
  );
  let published,
    calls = 0;
  const writes = [];
  const read = async (route, method, body) => {
    if (method) {
      writes.push(body);
      published = { ...published, ...body, id: 999, app: { id: f.app.app_id, slug: f.app.slug } };
      return published;
    }
    if (route === "check-runs/999") return published;
    return f.read(route);
  };
  read.sourceAuthorization = async () => {
    if (++calls > 1) throw Error("SOURCE_RECORD_REVOKED");
    return Buffer.from(canonical(r) + "\n");
  };
  await assert.rejects(
    () => reconcileAppCheck(read, f.app, undefined, c.pr),
    /SOURCE_RECORD_REVOKED/,
  );
  assert.equal(writes[0].conclusion, "success");
  assert.equal(writes.at(-1).conclusion, "failure");
});
test("disabled consumer feature fails before attempting any private protection API", async () => {
  const f = fixture({ enabled: false });
  await assert.rejects(() => verifyConsumerAttestation(f.read, f.full, { now }), /DISABLED/);
  assert.ok(f.routes.every((r) => !r.includes("/protection") && !r.startsWith("rulesets/")));
});
test("genuine synthetic App proof is verified using public contents/actions reads only", async () => {
  const f = await consumerFixture();
  f.routes.length = 0;
  const result = await verifyConsumerAttestation(f.publicRead, f.full, { now });
  assert.equal(result.source_evidence_verified, true);
  assert.equal(
    result.candidate_admission_authorized,
    false,
    "attestation alone is not candidate policy admission",
  );
  assert.equal(result.release_authorized, false);
  assert.ok(f.routes.every((r) => !r.includes("/protection") && !r.startsWith("rulesets/")));
});
test("versioned candidate consumer validates real policy engine without private N2 access", async () => {
  const f = await consumerFixture();
  f.routes.length = 0;
  const result = await observeAuthenticatedCandidateAdmission(f.context, f.publicRead, { now });
  assert.equal(result.candidate_admission_authorized, true);
  assert.equal(result.release_authorized, false);
  assert.ok(f.routes.every((r) => !r.includes("/protection") && !r.startsWith("rulesets/")));
});
for (const field of ["H", "B", "M", "TH", "TB", "TM", "pr", "repository_id"])
  test(`consumer rejects signed-App record with wrong ${field}`, async () => {
    const f = await consumerFixture();
    replaceRecord(
      f,
      (r) =>
        (r.context = {
          ...r.context,
          [field]: typeof r.context[field] === "number" ? 42 : "0".repeat(40),
        }),
    );
    await assert.rejects(() => verifyConsumerAttestation(f.publicRead, f.full, { now }));
  });
for (const label of [
  "Actions App",
  "reader App",
  "wrong installation",
  "wrong slug",
  "wrong suite",
  "wrong repository",
  "wrong same-name check",
  "neutral",
  "skipped",
  "duplicate",
  "missing",
  "secret field",
  "malformed JSON",
  "duplicate keys",
  "expiry",
  "clock skew",
  "missing bypass",
  "nonempty bypass",
  "incomplete rulesets",
  "policy drift",
  "control mode",
  "control blob",
  "missing control",
  "cross run",
  "cross attempt",
  "failed upstream",
  "incomplete upstream",
  "release authority",
  "ordinary scope",
  "revocation",
])
  test(`consumer fails closed: ${label}`, async () => {
    const f = await consumerFixture(),
      c = f.rows["check-runs/143"],
      list =
        f.rows[
          `commits/${f.full.H}/check-runs?check_name=${encodeURIComponent(f.app.check_name)}&filter=all&per_page=100&page=1`
        ];
    if (label === "Actions App") c.app.id = 15368;
    if (label === "reader App") c.app.id = f.app.protection_reader.app_id;
    if (label === "wrong installation") replaceRecord(f, (r) => r.issuer.installation_id++);
    if (label === "wrong slug") c.app.slug = "forged";
    if (label === "wrong suite") f.rows["check-suites/141"].head_sha = "0".repeat(40);
    if (label === "wrong repository") f.rows["check-suites/141"].repository.id = 42;
    if (label === "wrong same-name check") c.name = "same but untrusted";
    if (["neutral", "skipped"].includes(label)) c.conclusion = label;
    if (label === "duplicate") {
      list.total_count = 2;
      list.check_runs.push({ ...c, id: 144 });
    }
    if (label === "missing") {
      list.total_count = 0;
      list.check_runs = [];
    }
    if (label === "secret field")
      replaceRecord(f, (r) => (r.GITHUB_TOKEN = "synthetic-forbidden-credential"));
    if (label === "malformed JSON") c.output.summary = "{";
    if (label === "duplicate keys")
      c.output.summary = c.output.summary.replace('"scope":', '"scope":"forged","scope":');
    if (label === "expiry")
      replaceRecord(f, (r) => (r.expires_at = new Date(now - 1).toISOString()));
    if (label === "clock skew")
      replaceRecord(f, (r) => (r.observed_at = new Date(now + 30001).toISOString()));
    if (label === "missing bypass") replaceRecord(f, (r) => delete r.protection.bypass_visible);
    if (label === "nonempty bypass")
      replaceRecord(f, (r) => r.protection.rulesets[0].bypass_actors.push({ actor_id: 42 }));
    if (label === "incomplete rulesets") replaceRecord(f, (r) => (r.protection.rulesets = []));
    if (label === "policy drift") replaceRecord(f, (r) => (r.policy_sha256 = "0".repeat(64)));
    if (label === "control mode")
      replaceRecord(f, (r) => (r.control_source[TRUST_CONFIG].mode = "100755"));
    if (label === "control blob")
      replaceRecord(f, (r) => (r.control_source[TRUST_CONFIG].blob_sha1 = "0".repeat(40)));
    if (label === "missing control") replaceRecord(f, (r) => delete r.control_source[TRUST_CONFIG]);
    if (label === "cross run") replaceRecord(f, (r) => (r.runs.preflight.id = 999));
    if (label === "cross attempt") replaceRecord(f, (r) => (r.runs.preflight.attempt = 2));
    if (label === "failed upstream") f.upstream.conclusion = "failure";
    if (label === "incomplete upstream") f.upstream.status = "in_progress";
    if (label === "release authority") replaceRecord(f, (r) => (r.release_authorized = true));
    if (label === "ordinary scope") replaceRecord(f, (r) => (r.scope = "ordinary-source-change"));
    let n = 0;
    const read = async (route) => {
      if (label === "revocation" && route === "check-runs/143" && ++n === 2)
        return { ...c, conclusion: "failure" };
      return f.publicRead(route);
    };
    await assert.rejects(() => verifyConsumerAttestation(read, f.full, { now }));
  });
test("empty registry cannot admit candidate even with authentic App evidence", async () => {
  const f = await consumerFixture({ emptyRegistry: true });
  await assert.rejects(
    () => observeAuthenticatedCandidateAdmission(f.context, f.publicRead, { now }),
    /CANDIDATE_POLICY_NOT_REVIEWED/,
  );
});
test("anchor and verified-receipt objects cannot be mutated into authority", async () => {
  const f = await consumerFixture();
  assert.throws(() => (f.anchors.trust.source_authority.public_key = "attacker"), TypeError);
  const result = await verifyConsumerAttestation(f.publicRead, f.full, { now });
  assert.throws(() => (result.attestation.context.pr = 105), TypeError);
  assert.throws(() => (result.candidate_admission_authorized = true), TypeError);
});
test("issuer offline cannot leave consumable ten-minute-old positive", async () => {
  const f = await consumerFixture();
  await assert.rejects(
    () => verifyConsumerAttestation(f.publicRead, f.full, { now: now + 600001 }),
    /EXPIRED/,
  );
});
test("safe JSON rejects duplicate keys, trailing bytes and malformed UTF8", () => {
  for (const bytes of [
    Buffer.from('{"a":1,"a":2}\n'),
    Buffer.from("{}\nsecret"),
    Buffer.from([0xff]),
  ])
    assert.throws(() => decodeAuthorityJSON(bytes));
});
test("service template is restricted, clean-environment and never auto-updates source", async () => {
  const text = await readFile(
    new URL("../../infra/seaweedfs/pc100-admission.service", import.meta.url),
    "utf8",
  );
  for (const line of [
    "User=pc100",
    "Group=pc100",
    "UMask=0077",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "KillMode=control-group",
    "/usr/bin/env -i",
    "Restart=on-failure",
  ])
    assert.ok(text.includes(line));
  assert.ok(!/git pull|EnvironmentFile|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|User=root/.test(text));
  assert.match(text, /--watch.*issuer\.pem.*reader\.pem/);
});
test(
  "Linux env-i launch excludes caller credentials and systemd/agent variables",
  { skip: process.platform !== "linux" },
  () => {
    const result = spawnSync(
      "/usr/bin/env",
      [
        "-i",
        "PATH=/usr/bin:/bin",
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))",
      ],
      {
        env: {
          ...process.env,
          GITHUB_TOKEN: "synthetic-never-inherited",
          NODE_OPTIONS: "--no-warnings",
          INVOCATION_ID: "synthetic",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), ["PATH"]);
    assert.equal(result.stderr, "");
  },
);

for (const field of [
  "schema",
  "context",
  "scope",
  "authorization",
  "issuer",
  "reader",
  "control_source",
  "policy_sha256",
  "protection",
  "protection_sha256",
  "runs",
  "observed_at",
  "expires_at",
  "candidate_admission_authorized",
  "release_authorized",
]) {
  test(`consumer rejects missing required field ${field}`, async () => {
    const f = await consumerFixture();
    const r = globalThis.structuredClone(f.record);
    delete r[field];
    const c = f.rows["check-runs/143"];
    c.output.summary = canonical(r) + "\n";
    c.external_id = hash(canonical(r));
    await assert.rejects(() => verifyConsumerAttestation(f.publicRead, f.full, { now }));
  });
}
for (const label of [
  "head",
  "base",
  "merge",
  "public expected App",
  "strict policy",
  "nested secret",
]) {
  test(`consumer rejects live ${label} drift`, async () => {
    const f = await consumerFixture();
    if (label === "head") f.snapshot.pr.head.sha = "0".repeat(40);
    if (label === "base") f.snapshot.main.commit.sha = "0".repeat(40);
    if (label === "merge") f.snapshot.pr.merge_commit_sha = "0".repeat(40);
    if (label === "public expected App")
      f.rows["rules/branches/main"][0].parameters.required_status_checks[0].integration_id = 15368;
    if (label === "strict policy")
      f.rows["rules/branches/main"][0].parameters.strict_required_status_checks_policy = false;
    if (label === "nested secret")
      replaceRecord(f, (r) => (r.authorization.token = "synthetic-private-token"));
    await assert.rejects(() => verifyConsumerAttestation(f.publicRead, f.full, { now }));
  });
}
test("source-only proof cannot reach candidate consumer admission before entire Supply success", async () => {
  const f = await consumerFixture();
  replaceRecord(f, (r) => delete r.runs.supply);
  const proof = await verifyConsumerAttestation(f.publicRead, f.full, { now });
  assert.equal(proof.candidate_admission_authorized, false);
  await assert.rejects(
    () => observeAuthenticatedCandidateAdmission(f.context, f.publicRead, { now }),
    /RUN_ROLES/,
  );
});
test("new consumer cannot silently use stale upstream after a run-attempt change", async () => {
  const f = await consumerFixture();
  let reads = 0;
  const read = async (route) => {
    if (route === "actions/runs/131" && ++reads > 1) return { ...f.rows[route], run_attempt: 2 };
    return f.publicRead(route);
  };
  await assert.rejects(() => verifyConsumerAttestation(read, f.full, { now }), /RUN_REJECTED/);
});
test("unexpected context data cannot be reflected into authenticated evidence", async () => {
  const f = await consumerFixture();
  const hostile = { ...f.full, GITHUB_TOKEN: "SYNTHETIC_PRIVATE_CREDENTIAL" };
  await assert.rejects(
    () => verifyConsumerAttestation(f.publicRead, hostile, { now }),
    (error) =>
      error.message === "ATTESTATION_FIELDS_REJECTED" &&
      !String(error).includes("SYNTHETIC_PRIVATE_CREDENTIAL"),
  );
  await assert.rejects(
    () =>
      createConsumerAttestation(
        f.read,
        f.anchors,
        hostile,
        f.decision,
        { preflight: { id: 130, attempt: 1, workflow_id: 99 } },
        ["preflight"],
        now,
      ),
    /FIELDS_REJECTED/,
  );
});

test("App publication never reflects an uppercase credential-shaped SDK exception", async () => {
  const f = fixture(),
    writes = [];
  const read = async (route, method, body) => {
    if (method) {
      writes.push(body);
      return { ...body, id: 999, app: { id: f.app.app_id, slug: f.app.slug } };
    }
    return f.read(route);
  };
  const canary = "SYNTHETIC_PRIVATE_CREDENTIAL";
  const result = await reconcileAppCheck(read, f.app, async () => {
    throw Error(canary);
  });
  assert.equal(result.conclusion, "failure");
  assert.equal(result.outcome, "APP_OPERATION_FAILED");
  assert.ok(writes.every((w) => !JSON.stringify(w).includes(canary)));
});
for (const mode of ["missing actors", "nonempty actors", "missing allowances", "reader outage"]) {
  test(`ordinary authorized source still fails closed on ${mode}`, async () => {
    const f = fixture({ enabled: false }),
      c = ordinary(f);
    if (mode === "missing actors") delete f.rows["rulesets/77"].bypass_actors;
    if (mode === "nonempty actors") f.rows["rulesets/77"].bypass_actors.push({ actor_id: 42 });
    if (mode === "missing allowances")
      delete f.rows["branches/main/protection"].required_pull_request_reviews
        .bypass_pull_request_allowances;
    const read = async (route) => {
      if (mode === "reader outage" && route === "branches/main/protection")
        throw Error("SYNTHETIC_READER_UNAVAILABLE");
      return f.read(route);
    };
    let records = 0;
    read.sourceAuthorization = async () => {
      records++;
      return Buffer.from("must not reach the review record");
    };
    await assert.rejects(
      () => authorizeOrdinarySource(read, f.app, c, f.snapshot.targetTree),
      /BYPASS|PROTECTION_UNVERIFIABLE|READER_UNAVAILABLE/,
    );
    assert.equal(records, 0);
  });
}
test("ordinary source pre-install check does not depend on already requiring itself", async () => {
  const f = fixture({ enabled: false }),
    c = ordinary(f),
    anchors = await readAppTrust(f.read, c.B),
    review = signedReview(f, anchors, c);
  f.rows["rules/branches/main"][0].parameters.required_status_checks = f.rows[
    "rules/branches/main"
  ][0].parameters.required_status_checks.filter((r) => r.context !== f.app.check_name);
  const observed = Date.now();
  review.payload.observed_at = new Date(observed).toISOString();
  review.payload.expires_at = new Date(observed + 600000).toISOString();
  review.signature = sign(
    null,
    Buffer.from(canonical(review.payload)),
    authority.privateKey,
  ).toString("base64url");
  f.read.sourceAuthorization = async () => Buffer.from(canonical(review) + "\n");
  const result = await authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree);
  assert.equal(result.decision, "AUTHORIZED_SOURCE_CHANGE");
});
for (const mode of [
  "job token only",
  "missing job token",
  "403 no fallback",
  "malicious SDK failure",
]) {
  test(`consumer credential isolation: ${mode}`, () => {
    const moduleURL = new URL("../../tools/test/pc100-candidate-policy.mjs", import.meta.url).href;
    const code = `import assert from 'node:assert/strict';
      import {readConsumerMetadata} from ${JSON.stringify(moduleURL)};
      let calls=0;
      globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer synthetic-job-token');${mode === "malicious SDK failure" ? "throw Error('SYNTHETIC_OWNER_CREDENTIAL');" : ""}return new Response('{"ok":true}',{status:${mode === "403 no fallback" ? 403 : 200}});};
      ${mode === "missing job token" ? "await assert.rejects(()=>readConsumerMetadata('branches/main'),/CONSUMER_TOKEN_REQUIRED/);assert.equal(calls,0);" : ["403 no fallback", "malicious SDK failure"].includes(mode) ? "await assert.rejects(()=>readConsumerMetadata('branches/main'),/CANDIDATE_CONSUMER_METADATA_UNAVAILABLE/);assert.equal(calls,1);" : "assert.deepEqual(await readConsumerMetadata('branches/main'),{ok:true});assert.equal(calls,1);"}
      process.stdout.write('ISOLATED_PASS');`;
    const env = {
      PATH: process.env.PATH,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      PC100_METADATA_TOKEN: "synthetic-shadow-token",
      GH_TOKEN: "synthetic-owner-token",
      ...(mode === "missing job token" ? {} : { GITHUB_TOKEN: "synthetic-job-token" }),
    };
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "ISOLATED_PASS");
    assert.equal(result.stderr, "");
  });
}

// QA107 adversarial replays. These are synthetic transport results (MOCK_READY),
// never proof of the Reader App's real GraphQL/Admin-Read capability.
const bypassMutations = [
  [
    "nonempty",
    (d) => {
      const c = d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances;
      c.totalCount = 1;
      c.nodes = [{ id: "ALLOW_1" }];
      c.edges = [{ cursor: "c1", node: { id: "ALLOW_1" } }];
      c.pageInfo = {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: "c1",
        endCursor: "c1",
      };
    },
  ],
  [
    "missing bypass",
    (d) => delete d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances,
  ],
  [
    "null bypass",
    (d) => (d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances = null),
  ],
  [
    "null count",
    (d) =>
      (d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances.totalCount =
        null),
  ],
  [
    "missing nodes",
    (d) =>
      delete d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances.nodes,
  ],
  [
    "missing edges",
    (d) =>
      delete d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances.edges,
  ],
  ["partial errors", (d) => (d.errors = [{ message: "SYNTHETIC_PRIVATE_CANARY" }])],
  ["null errors", (d) => (d.errors = null)],
  ["missing data", (d) => delete d.data],
  ["wrong repository", (d) => d.data.repository.databaseId++],
  ["wrong node repository", (d) => (d.data.repository.id = "R_OTHER")],
  ["wrong name", (d) => (d.data.repository.nameWithOwner = "other/repo")],
  ["wrong branch", (d) => (d.data.repository.ref.name = "develop")],
  ["wrong prefix", (d) => (d.data.repository.ref.prefix = "refs/tags/")],
  ["wrong target", (d) => (d.data.repository.ref.target.oid = "f".repeat(40))],
  ["wrong rule", (d) => (d.data.repository.ref.branchProtectionRule.id = "BPR_OTHER")],
  ["wrong rule pattern", (d) => (d.data.repository.ref.branchProtectionRule.pattern = "develop")],
  [
    "unrelated empty rule",
    (d) =>
      (d.data.repository.branchProtectionRules.nodes[0].matchingRefs.nodes[0].name = "develop"),
  ],
  ["over-limit rules", (d) => (d.data.repository.branchProtectionRules.totalCount = 101)],
  ["next rules page", (d) => (d.data.repository.branchProtectionRules.pageInfo.hasNextPage = true)],
  [
    "next bypass page",
    (d) =>
      (d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances.pageInfo.hasNextPage = true),
  ],
  [
    "partial ref page",
    (d) =>
      (d.data.repository.branchProtectionRules.nodes[0].matchingRefs.pageInfo.hasNextPage = true),
  ],
  [
    "missing pageInfo",
    (d) =>
      delete d.data.repository.branchProtectionRules.nodes[0].bypassPullRequestAllowances.pageInfo,
  ],
  [
    "mismatched edge",
    (d) => (d.data.repository.branchProtectionRules.edges[0].node.id = "BPR_OTHER"),
  ],
  [
    "mismatched cursor",
    (d) => (d.data.repository.branchProtectionRules.pageInfo.endCursor = "wrong"),
  ],
  [
    "ambiguous rules",
    (d) => {
      const c = d.data.repository.branchProtectionRules,
        r = globalThis.structuredClone(c.nodes[0]);
      r.id = "BPR_SECOND";
      r.databaseId++;
      c.nodes.push(r);
      c.edges.push({ cursor: "cursor1", node: { id: r.id } });
      c.totalCount++;
      c.pageInfo.endCursor = "cursor1";
    },
  ],
];
for (const [label, edit] of bypassMutations)
  test(`QA107 BLOCKER-1 GraphQL rejects ${label}`, async () => {
    const f = fixture(),
      data = branchBypassFixture(f.context.B);
    f.rows["branches/main/protection"] = omittedLegacyProtection();
    edit(data);
    f.read.branchProtectionGraphQL = async () => data;
    await assert.rejects(
      () => collectProtectionEvidence(f.read),
      (e) => !e.message.includes("SYNTHETIC_PRIVATE_CANARY"),
    );
  });
for (const label of [
  "no Reader capability",
  "Reader incapable",
  "REST null",
  "REST nonempty",
  "missing ruleset actors",
  "ruleset drift",
  "base drift",
  "GraphQL drift",
])
  test(`QA107 BLOCKER-1 shared predicate rejects ${label}`, async () => {
    const f = fixture();
    f.rows["branches/main/protection"] = omittedLegacyProtection();
    f.read.branchProtectionGraphQL = async () => branchBypassFixture(f.context.B);
    if (label === "no Reader capability") delete f.read.branchProtectionGraphQL;
    if (label === "Reader incapable")
      f.read.branchProtectionGraphQL = async () => {
        throw Error("SYNTHETIC_PRIVATE_CANARY");
      };
    if (label === "REST null")
      f.rows[
        "branches/main/protection"
      ].required_pull_request_reviews.bypass_pull_request_allowances = null;
    if (label === "REST nonempty")
      f.rows[
        "branches/main/protection"
      ].required_pull_request_reviews.bypass_pull_request_allowances = {
        users: [{ id: 1 }],
        teams: [],
        apps: [],
      };
    if (label === "missing ruleset actors") delete f.rows["rulesets/77"].bypass_actors;
    let calls = 0;
    const read = async (route) => {
      const value = await f.read(route);
      if (label === "base drift" && route === "branches/main" && ++calls === 2)
        return { ...value, commit: { sha: "f".repeat(40) } };
      if (label === "ruleset drift" && route === "rulesets/77" && ++calls === 2)
        return { ...value, bypass_actors: [{ actor_id: 1 }] };
      return value;
    };
    read.branchProtectionGraphQL = f.read.branchProtectionGraphQL;
    if (label === "GraphQL drift")
      read.branchProtectionGraphQL = async () => {
        const d = branchBypassFixture(f.context.B);
        if (++calls === 2) d.data.repository.ref.target.oid = "f".repeat(40);
        return d;
      };
    await assert.rejects(
      () => collectProtectionEvidence(read),
      (e) => !e.message.includes("SYNTHETIC_PRIVATE_CANARY"),
    );
  });
test("QA107 BLOCKER-1 probe/ordinary/collector use the same missing-field predicate", async () => {
  const f = fixture(),
    c = ordinary(f),
    a = await readAppTrust(f.read, c.B),
    at = Date.now(),
    r = signedReview(f, a, c);
  r.payload.observed_at = new Date(at).toISOString();
  r.payload.expires_at = new Date(at + 600000).toISOString();
  r.signature = sign(null, Buffer.from(canonical(r.payload)), authority.privateKey).toString(
    "base64url",
  );
  f.read.sourceAuthorization = async () => Buffer.from(canonical(r) + "\n");
  f.rows["branches/main/protection"] = omittedLegacyProtection();
  await assert.rejects(
    () => authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree, at),
    /BYPASS/,
  );
  f.read.branchProtectionGraphQL = async () => branchBypassFixture(c.B);
  assert.equal(
    (await authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree, at)).decision,
    "AUTHORIZED_SOURCE_CHANGE",
  );
  assert.equal((await collectProtectionAttestation(f.read, f.app)).branch_bypass.B, c.B);
});
for (const p of [
  TRUST_CONFIG,
  "tools/test/pc100-admission-app.mjs",
  "tools/new-controller.mjs",
  "infra/seaweedfs/candidate-app.json",
  "infra/seaweedfs/candidate-policy.json",
  ".github/workflows/new.yml",
  ".github/CODEOWNERS",
  "pnpm-lock.yaml",
  "package.json",
  "apps/api/package.json",
  "apps/api/Dockerfile",
  "compose.yml",
  "docs/operations/pc100-independent-app.md",
  "tests/architecture/new.test.mjs",
])
  test(`QA107 HIGH-2 valid ordinary key cannot authorize control path ${p}`, async () => {
    const f = fixture(),
      c = ordinary(f),
      a = await readAppTrust(f.read, c.B),
      tree = f.snapshot.targetTree;
    const row = tree.tree.find((e) => e.path === p);
    if (row) row.sha = "1".repeat(40);
    else tree.tree.push({ path: p, type: "blob", mode: "100644", sha: "1".repeat(40), size: 1 });
    const r = signedReview(f, a, c);
    assert.throws(
      () => verifySourceAuthorization(r, a, c, tree, now),
      /SOURCE_CONTROL_CHANGE_REQUIRES_INDEPENDENT_REVIEW/,
    );
  });
for (const edit of [
  (t) => (t.tree.find((e) => e.path === TRUST_CONFIG).mode = "100755"),
  (t) =>
    t.tree.splice(
      t.tree.findIndex((e) => e.path === TRUST_CONFIG),
      1,
    ),
  (t) => (t.tree.find((e) => e.path === TRUST_CONFIG).path = "docs/renamed-trust.md"),
])
  test("QA107 HIGH-2 control mode/removal/rename cannot borrow ordinary signature", async () => {
    const f = fixture(),
      c = ordinary(f),
      a = await readAppTrust(f.read, c.B);
    edit(f.snapshot.targetTree);
    assert.throws(
      () => verifySourceAuthorization(signedReview(f, a, c), a, c, f.snapshot.targetTree, now),
      /INDEPENDENT_REVIEW/,
    );
  });
for (const label of ["null merge", "new merge", "wrong parents", "wrong TM", "wrong H tree"])
  test(`QA107 MED-3 signed ordinary source rejects ${label}`, async () => {
    const f = fixture(),
      c = ordinary(f),
      a = await readAppTrust(f.read, c.B),
      at = Date.now(),
      r = signedReview(f, a, c);
    r.payload.observed_at = new Date(at).toISOString();
    r.payload.expires_at = new Date(at + 600000).toISOString();
    r.signature = sign(null, Buffer.from(canonical(r.payload)), authority.privateKey).toString(
      "base64url",
    );
    f.read.sourceAuthorization = async () => Buffer.from(canonical(r) + "\n");
    if (label === "null merge") c.M = f.rows["pulls/104"].merge_commit_sha = null;
    if (label === "new merge") f.rows["pulls/104"].merge_commit_sha = "f".repeat(40);
    if (label === "wrong parents") f.snapshot.merge.parents.reverse();
    if (label === "wrong TM") f.snapshot.merge.tree.sha = "f".repeat(40);
    if (label === "wrong H tree") f.snapshot.head.tree.sha = "f".repeat(40);
    await assert.rejects(() =>
      authorizeOrdinarySource(f.read, f.app, c, f.snapshot.targetTree, at),
    );
  });
test("QA107 LOW-2 noncanonical signature alias cannot create a second authorization digest", async () => {
  const f = fixture(),
    c = ordinary(f),
    a = await readAppTrust(f.read, c.B),
    r = signedReview(f, a, c);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    last = chars.indexOf(r.signature.at(-1));
  const alias = { ...r, signature: r.signature.slice(0, -1) + chars[last + 1] };
  assert.deepEqual(
    Buffer.from(alias.signature, "base64url"),
    Buffer.from(r.signature, "base64url"),
  );
  assert.throws(
    () => verifySourceAuthorization(alias, a, c, f.snapshot.targetTree, now),
    /REJECTED/,
  );
  assert.equal(
    verifySourceAuthorization(r, a, c, f.snapshot.targetTree, now).authorization_sha256,
    hash(canonical(r)),
  );
});
for (const [label, edit] of [
  ["missing image", (f, j) => j.jobs.splice(2, 1)],
  [
    "skipped image",
    (f, j) => {
      j.jobs[2].conclusion = "skipped";
    },
  ],
  [
    "failed dependencies",
    (f, j) => {
      j.jobs[1].conclusion = "failure";
    },
  ],
  [
    "failed aggregate",
    (f, j) => {
      j.jobs.find((j) => j.name === "supply-chain-security").conclusion = "failure";
    },
  ],
  [
    "extra image",
    (f, j) => {
      j.jobs.push({ ...j.jobs[2], id: 999, name: "image extra" });
      j.total_count++;
    },
  ],
  [
    "attempt2",
    (f) => {
      f.record.runs.supply.attempt = 2;
      f.rows["actions/runs/131"].run_attempt = 2;
    },
  ],
  [
    "cross run",
    (f, j) => {
      j.jobs[2].run_id = 999;
    },
  ],
  [
    "cross attempt",
    (f, j) => {
      j.jobs[2].run_attempt = 2;
    },
  ],
  [
    "forged check",
    (f) => {
      f.rows["check-runs/11002"].app.id++;
    },
  ],
  [
    "wrong suite",
    (f) => {
      f.rows["check-suites/9000"].head_sha = "f".repeat(40);
    },
  ],
  [
    "missing page",
    (f, j) => {
      j.total_count = 101;
    },
  ],
  [
    "duplicate job",
    (f, j) => {
      j.jobs[3] = j.jobs[2];
    },
  ],
  [
    "cross artifact URL",
    (f, j) => {
      j.jobs[2].check_run_url = "https://evil.invalid/check-runs/1";
    },
  ],
  [
    "release activated",
    (f, j) => {
      j.jobs[14].conclusion = "success";
    },
  ],
])
  test(`QA107 MED-4 entire Supply rejects ${label}`, async () => {
    const f = await consumerFixture(),
      j = f.rows["actions/runs/131/attempts/1/jobs?per_page=100&page=1"];
    replaceRecord(f, () => edit(f, j));
    await assert.rejects(() => verifyConsumerAttestation(f.publicRead, f.full, { now }));
  });
test("QA107 MED-4 complete bounded job pagination and late attempt race", async () => {
  const f = await consumerFixture(),
    j = f.rows["actions/runs/131/attempts/1/jobs?per_page=100&page=1"];
  // Artificial page split smaller than requested must fail closed, not miss rows.
  j.jobs = j.jobs.slice(0, 2);
  await assert.rejects(() => verifyConsumerAttestation(f.publicRead, f.full, { now }));
  const g = await consumerFixture();
  let n = 0;
  const read = async (route) => {
    const d = await g.publicRead(route);
    if (route === "actions/runs/131" && ++n === 2) return { ...d, run_attempt: 2 };
    return d;
  };
  await assert.rejects(() => verifyConsumerAttestation(read, g.full, { now }));
});
for (const [label, edit] of [["key ID", (r) => (r.source_authority.key_id = "f".repeat(64))]])
  test(`QA107 MED-7 trusted root rejects ${label} mutant`, async () => {
    const f = fixture(),
      entry = f.snapshot.trustedTree.tree.find((e) => e.path === TRUST_CONFIG),
      d = JSON.parse(f.content[TRUST_CONFIG]);
    edit(d);
    const raw = Buffer.from(canonical(d) + "\n"),
      sha = blobSHA(raw);
    entry.sha = sha;
    entry.size = raw.length;
    f.rows[`git/blobs/${sha}`] = {
      sha,
      encoding: "base64",
      size: raw.length,
      content: raw.toString("base64"),
    };
    await assert.rejects(() => readAppTrust(f.read, f.context.B), /AUTHORITY/);
  });
for (const [label, edit] of [
  [
    "bypass visible",
    (f) =>
      replaceRecord(f, (r) => {
        r.protection.bypass_visible = false;
      }),
  ],
  [
    "ten minute window",
    (f) =>
      replaceRecord(f, (r) => {
        r.expires_at = new Date(now + 600001).toISOString();
      }),
  ],
  [
    "external ID",
    (f) => {
      f.rows["check-runs/143"].external_id = "f".repeat(64);
    },
  ],
  [
    "suite integration",
    (f) => {
      f.rows["check-suites/141"].app.id++;
    },
  ],
  [
    "TH TM",
    (f) => {
      f.snapshot.merge.tree.sha = "f".repeat(40);
    },
  ],
  [
    "merge parents",
    (f) => {
      f.snapshot.merge.parents.reverse();
    },
  ],
  [
    "branch proof B",
    (f) =>
      replaceRecord(f, (r) => {
        r.protection.branch_bypass.B = "f".repeat(40);
      }),
  ],
])
  test(`QA107 MED-7 actual consumer rejects ${label} mutant`, async () => {
    const f = await consumerFixture();
    edit(f);
    await assert.rejects(() => verifyConsumerAttestation(f.publicRead, f.full, { now }));
  });
test("QA107 MED-7 caller-created verified-proof objects cannot cross capability gate", async () => {
  const f = await consumerFixture(),
    proof = await verifyConsumerAttestation(f.publicRead, f.full, { now });
  assert.equal(isVerifiedConsumerEvidence({ ...proof }, f.full), false);
  assert.equal(isVerifiedConsumerEvidence(proof, { ...f.full, M: "f".repeat(40) }), false);
  assert.equal(isVerifiedConsumerEvidence(proof, f.full), true);
  assert.equal(controlPlanePath("docs/readme.md", "100644"), false);
});

for (const canary of [
  "SYNTHETIC_PRIVATE_CREDENTIAL_UPPERCASE",
  "private synthetic exception content",
])
  test("QA107 LOW-6 actual policy CLI never prints arbitrary exception messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pc100-safe-error-"));
    try {
      const event = path.join(dir, "event.json");
      await writeFile(event, "{}");
      const mod = new URL("../../tools/test/pc100-candidate-policy.mjs", import.meta.url);
      const script = `process.argv=[process.execPath,${JSON.stringify(path.join(process.cwd(), "tools/test/pc100-candidate-policy.mjs"))}];
     JSON.parse=()=>{throw Error(${JSON.stringify(canary)})};await import(${JSON.stringify(mod.href)});`;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 10000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GITHUB_EVENT_PATH: event,
          GITHUB_EVENT_NAME: "workflow_run",
          TRUSTED_WORKFLOW_SHA: "b".repeat(40),
        },
      });
      assert.equal(run.status, 1);
      assert.equal((run.stdout + run.stderr).includes(canary), false);
      assert.match(run.stderr, /CANDIDATE_OPERATION_REJECTED/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test(
  "QA107 Linux root-owned documented checkout starts under real systemd confinement",
  { skip: process.platform !== "linux" },
  async () => {
    const source = path.resolve(import.meta.dirname, "../.."),
      node = process.execPath;
    // No keys, App API or service activation: a disposable transient unit executes
    // ONLY the real checkout/public-record verification helpers, then is collected.
    const script = `
 import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod,symlink,rm} from "node:fs/promises";
 import {execFileSync,spawnSync} from "node:child_process";
 import path from "node:path";
 const base=await mkdtemp("/run/pc100-synthetic-");
 try {
  await chmod(base,0o755);const repo=base+"/reviewed-main",cfg=base+"/gitconfig",pub=base+"/reviews";
  await mkdir(repo+"/tools/test",{recursive:true,mode:0o755});await mkdir(pub,{mode:0o755});
  for(const p of ["pc100-admission-app.mjs","pc100-app-attestation.mjs","pc100-source-verifier.mjs","pc100-candidate-policy.mjs"])
   await copyFile(${JSON.stringify(source)}+"/tools/test/"+p,repo+"/tools/test/"+p);
  await copyFile(${JSON.stringify(node)},base+"/node");await chmod(base+"/node",0o755);
  const git=(...a)=>execFileSync("git",a,{cwd:repo,env:{PATH:"/usr/bin:/bin",HOME:base},encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  git("init","-q");git("config","user.name","synthetic");git("config","user.email","synthetic@example.invalid");
  git("add","tools");git("commit","-qm","synthetic checkout");const B=git("rev-parse","HEAD").trim();
  await writeFile(cfg,"[safe]\n\tdirectory = "+repo+"\n",{mode:0o644});
  await writeFile(cfg+"-bad","[safe]\n\tdirectory = *\n",{mode:0o644});
  await symlink(repo,base+"/alias");
  const context={H:B,B,M:"c".repeat(40),pr:104};
  const filename=pub+"/"+B+"-"+B+"-"+context.M+"-104.source-review.json";
  await writeFile(filename,"public-synthetic-record",{mode:0o644});
  const driver=base+"/driver.mjs";
  await writeFile(driver,'import assert from "node:assert/strict";import {writeFile} from "node:fs/promises";'+
   'import {verifyReviewedCheckout,readRootOwnedSourceReview} from '+JSON.stringify(repo+"/tools/test/pc100-admission-app.mjs")+';'+
   'await verifyReviewedCheckout('+JSON.stringify(B)+','+JSON.stringify(repo)+','+JSON.stringify(cfg)+');'+
   'await assert.rejects(()=>verifyReviewedCheckout('+JSON.stringify(B)+','+JSON.stringify(repo)+','+JSON.stringify(cfg+"-bad")+'),/GIT_CONFIG_REJECTED/);'+
   'await assert.rejects(()=>verifyReviewedCheckout('+JSON.stringify(B)+','+JSON.stringify(base+"/alias")+','+JSON.stringify(cfg)+'),/OWNERSHIP_REJECTED/);'+
   'await assert.rejects(()=>writeFile('+JSON.stringify(cfg)+',"alter"));'+
   'assert.equal((await readRootOwnedSourceReview('+JSON.stringify(context)+','+JSON.stringify(pub)+')).toString(),"public-synthetic-record");'+
   'console.log("ROOT_READONLY_SYSTEMD_STARTUP_PASS");',{mode:0o644});
  const unit=await readFile(${JSON.stringify(source)}+"/infra/seaweedfs/pc100-admission.service","utf8");
  const keys=["NoNewPrivileges","PrivateTmp","PrivateDevices","ProtectSystem","ProtectHome","ProtectClock","ProtectKernelLogs","ProtectKernelTunables","ProtectKernelModules","ProtectControlGroups","RestrictSUIDSGID","RestrictAddressFamilies","CapabilityBoundingSet","RestrictNamespaces","LockPersonality","RestrictRealtime","SystemCallArchitectures","UMask","KillMode"];
  const props=unit.split(/\r?\n/).filter(l=>keys.includes(l.split("=")[0])).flatMap(l=>["--property",l]);
  const args=["--quiet","--wait","--pipe","--collect","--unit",path.basename(base),"--property","User=nobody","--property","Group=nogroup","--property","PrivateNetwork=yes","--property","TimeoutStartSec=15",...props,"/usr/bin/env","-i","HOME="+base,"PATH=/usr/bin:/bin","USER=nobody",base+"/node",driver];
  const r=spawnSync("systemd-run",args,{encoding:"utf8",timeout:20000,env:{PATH:"/usr/bin:/bin"}});
  if(r.status!==0 || !r.stdout.includes("ROOT_READONLY_SYSTEMD_STARTUP_PASS")){console.error("SYNTHETIC_SYSTEMD_FAILED",r.status,r.signal,r.stderr);process.exitCode=1;}
  else console.log("ROOT_READONLY_SYSTEMD_STARTUP_PASS");
 } finally {
  if(!base.startsWith("/run/pc100-synthetic-"))throw Error("UNSAFE_TEST_CLEANUP");
  await rm(base,{recursive:true,force:true});
 }`;
    const run = spawnSync("sudo", ["-n", node, "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 28000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(run.status, 0, `Synthetic systemd startup failed: ${run.stderr}`);
    assert.match(run.stdout, /ROOT_READONLY_SYSTEMD_STARTUP_PASS/);
  },
);

test("QA107 MED-7 valid signature cannot bypass anchored-object capability", async () => {
  const f = fixture(),
    c = ordinary(f),
    a = await readAppTrust(f.read, c.B),
    r = signedReview(f, a, c);
  assert.throws(
    () => verifySourceAuthorization(r, { ...a }, c, f.snapshot.targetTree, now),
    /NOT_CONFIGURED/,
  );
});
test("QA107 MED-7 unsigned ordinary documentation blob drift is independently rejected", async () => {
  const f = fixture(),
    c = ordinary(f),
    a = await readAppTrust(f.read, c.B),
    r = signedReview(f, a, c);
  f.snapshot.targetTree.tree.find((e) => e.path === "docs/ordinary-change.md").sha = "1".repeat(40);
  assert.throws(() => verifySourceAuthorization(r, a, c, f.snapshot.targetTree, now), /DRIFT/);
});
test("QA107 MED-7 internally consistent but unequal head/merge trees reject", async () => {
  const f = await consumerFixture();
  f.full.TM = "f".repeat(40);
  f.snapshot.merge.tree.sha = f.full.TM;
  replaceRecord(f, (r) => {
    r.context.TM = f.full.TM;
    r.authorization.TM = f.full.TM;
  });
  await assert.rejects(
    () => verifyConsumerAttestation(f.publicRead, f.full, { now }),
    /TREE_DRIFT/,
  );
});
