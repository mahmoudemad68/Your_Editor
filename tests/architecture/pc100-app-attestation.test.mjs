/** MOCK GitHub transport; real ephemeral crypto. Never reads real App credentials. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { candidateFixture, blobSHA } from "./support/candidate-policy-fixture.mjs";
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
  CONTROL_PATHS,
  TRUST_CONFIG,
} from "../../tools/test/pc100-app-attestation.mjs";
const authority = generateKeyPairSync("ed25519");
const keyID = hash(authority.publicKey.export({ format: "der", type: "spki" }));
const now = 1800000000000;
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
  r.payload.observed_at = new Date().toISOString();
  r.payload.expires_at = new Date(Date.now() + 600000).toISOString();
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
  r.payload.observed_at = new Date().toISOString();
  r.payload.expires_at = new Date(Date.now() + 600000).toISOString();
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
