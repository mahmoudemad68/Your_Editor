/** Hermetic App API/crypto tests. Never an installation or security-policy approval. */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import path from "node:path";
import { mkdtemp, writeFile, chmod, symlink, link, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import {
  assertExternalHost,
  assertExternalKeyPath,
  readExternalKeyFile,
  appJWT,
  installationClient,
  reconcileAppCheck,
  appRequest,
  reconcileAppCycle,
  validateAppRoute,
} from "../../tools/test/pc100-admission-app.mjs";
import {
  APP_CHECK,
  validateAppConfig,
  validateEnforcementRules,
  observeCandidateAdmission,
} from "../../tools/test/pc100-candidate-policy.mjs";
import { candidateFixture, blobSHA } from "./support/candidate-policy-fixture.mjs";
const config = {
  schema: "pc100-independent-app-v1",
  repository_id: 1395822921,
  app_id: 246810,
  installation_id: 12345,
  slug: "independent-test-only",
  check_name: APP_CHECK,
};
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = key.privateKey.export({ format: "pem", type: "pkcs8" });
test(
  "Linux key-file guard checks real permissions and rejects symbolic/hard links (non-key marker only)",
  { skip: process.platform !== "linux" },
  async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "app-file-guard-"))),
      file = path.join(dir, "marker");
    try {
      await writeFile(file, "synthetic-not-a-key", { mode: 0o600 });
      assert.equal((await readExternalKeyFile(file)).toString(), "synthetic-not-a-key");
      await chmod(file, 0o644);
      await assert.rejects(() => readExternalKeyFile(file), /APP_KEY_PERMISSIONS_REJECTED/);
      await chmod(file, 0o600);
      const symbolic = path.join(dir, "symbolic");
      await symlink(file, symbolic);
      await assert.rejects(() => readExternalKeyFile(symbolic), /APP_KEY_PERMISSIONS_REJECTED/);
      const hard = path.join(dir, "hard");
      await link(file, hard);
      await assert.rejects(() => readExternalKeyFile(file), /APP_KEY_PERMISSIONS_REJECTED/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test("private keys cannot be read from a checkout, including dot-dot-prefixed children", () => {
  const checkout = path.resolve(import.meta.dirname, "../..");
  for (const file of [
    checkout,
    path.join(checkout, "key.pem"),
    path.join(checkout, "..keys/key.pem"),
    "relative-key.pem",
  ])
    assert.throws(() => assertExternalKeyPath(file, checkout), /APP_KEY_INSIDE_REPOSITORY/);
  assertExternalKeyPath(path.join(path.dirname(checkout), "external-private/key.pem"), checkout);
});
test("App JWT is genuine RS256, short lived and never an installation credential", () => {
  const token = appJWT(config, pem, 1800000000000),
    [h, p, s] = token.split(".");
  assert.ok(
    verify("RSA-SHA256", Buffer.from(h + "." + p), key.publicKey, Buffer.from(s, "base64url")),
  );
  const payload = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(payload.iss, "246810");
  assert.equal(payload.exp - payload.iat, 570);
});
for (const name of [
  "GITHUB_ACTIONS",
  "GITHUB_TOKEN",
  "GITHUB_ENV",
  "ACTIONS_RUNTIME_TOKEN",
  "RUNNER_ENVIRONMENT",
  "GH_TOKEN",
  "NODE_OPTIONS",
])
  test(`external App rejects PR/credential environment ${name} even when false`, () =>
    assert.throws(() => assertExternalHost({ [name]: "false" }), /APP_PR_RUNNER_FORBIDDEN/));
test("unconfigured or shared Actions App cannot become authority", () => {
  assertExternalHost({ PATH: "trusted" });
  for (const c of [
    { ...config, app_id: null },
    { ...config, app_id: 15368 },
    { ...config, repository_id: 1 },
  ])
    assert.throws(() => validateAppConfig(c));
  for (const id of [undefined, 15368, config.app_id + 1])
    assert.throws(() =>
      validateEnforcementRules(
        [
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: APP_CHECK, integration_id: id }],
            },
          },
        ],
        config,
      ),
    );
});
function client(f, changes = {}) {
  const writes = [];
  const read = async (route, method = "GET", body) => {
    if (method !== "GET") {
      writes.push({ route, method, body });
      const prior = f.rows["check-runs/143"];
      f.rows["check-runs/143"] = { ...prior, ...body };
      await changes.afterWrite?.(body);
      return f.rows["check-runs/143"];
    }
    return f.read(route);
  };
  return { read, writes };
}
test("real policy evaluator issues dedicated exact-H check, never production release", async () => {
  const f = candidateFixture(),
    c = client(f);
  const outcome = await reconcileAppCheck(c.read, config);
  assert.equal(outcome.conclusion, "success");
  assert.equal(outcome.H, f.context.H);
  assert.equal(JSON.parse(c.writes.at(-1).body.output.summary).release_authorized, false);
  assert.equal((await observeCandidateAdmission(f.context, c.read)).enforcement.app, config.app_id);
});
for (const [label, edit] of [
  [
    "missing policy",
    (f) => {
      const bytes = Buffer.from(JSON.stringify({ ...f.registry, policies: [] }) + "\n");
      const row = f.snapshot.trustedTree.tree.find(
        (e) => e.path === "infra/seaweedfs/candidate-policy.json",
      );
      row.sha = blobSHA(bytes);
      row.size = bytes.length;
      f.rows[`git/blobs/${row.sha}`] = {
        sha: row.sha,
        size: bytes.length,
        encoding: "base64",
        content: bytes.toString("base64"),
      };
    },
  ],
  ["failed latest upstream", (f) => (f.upstream.conclusion = "failure")],
  [
    "non-independent expected issuer",
    (f) =>
      (f.rows["rules/branches/main"][0].parameters.required_status_checks[0].integration_id =
        15368),
  ],
])
  test(`App cannot grant success with ${label}`, async () => {
    const f = candidateFixture();
    edit(f);
    const c = client(f);
    const result = await reconcileAppCheck(c.read, config);
    assert.equal(result.conclusion, "failure");
    assert.ok(c.writes.every((w) => w.body.conclusion !== "success"));
  });
test("head race during App write immediately invalidates success", async () => {
  const f = candidateFixture();
  let first = true;
  const c = client(f, {
    afterWrite: () => {
      if (first) {
        first = false;
        f.snapshot.pr.head.sha = "9".repeat(40);
      }
    },
  });
  await assert.rejects(() => reconcileAppCheck(c.read, config), /APP_LIVE_DRIFT/);
  assert.equal(c.writes.at(-1).body.conclusion, "failure");
});
test("malformed live identity is rejected before any check write", async () => {
  for (const value of [null, "", "x".repeat(40)]) {
    const f = candidateFixture();
    f.snapshot.pr.head.sha = value;
    const c = client(f);
    await assert.rejects(() => reconcileAppCheck(c.read, config), /APP_LIVE_DRIFT/);
    assert.equal(c.writes.length, 0);
  }
});
test("PR omitting its own workflow cannot remove independently required App check", async () => {
  const f = candidateFixture();
  delete f.rows["actions/workflows/pc100-required-admission.yml"];
  assert.equal((await observeCandidateAdmission(f.context, f.read)).enforcement.app, config.app_id);
  f.rows["check-runs/143"].app.id = 15368;
  await assert.rejects(() => observeCandidateAdmission(f.context, f.read));
});
for (const operation of ["remove", "replace"])
  test(`PR ${operation} of its workflow cannot self-authorize`, async () => {
    const f = candidateFixture(),
      e = f.snapshot.targetTree.tree.find(
        (e) => e.path === ".github/workflows/pc100-required-admission.yml",
      );
    if (operation === "remove")
      f.snapshot.targetTree.tree.splice(f.snapshot.targetTree.tree.indexOf(e), 1);
    else e.sha = "9".repeat(40);
    const c = client(f);
    assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "failure");
  });
test("App authentication requests only one repository and rejects token permission expansion", async () => {
  for (const extra of [false, true]) {
    const calls = [],
      request = async (route, _token, method, body) => {
        calls.push({ route, method, body });
        if (route === "/app") return { id: config.app_id, slug: config.slug };
        if (route.includes("access_tokens"))
          return {
            token: "synthetic-installation-token",
            expires_at: new Date(Date.now() + 3500000).toISOString(),
            permissions: {
              contents: "read",
              pull_requests: "read",
              actions: "read",
              checks: "write",
              metadata: "read",
              ...(extra ? { administration: "write" } : {}),
            },
          };
        return { total_count: 1, repositories: [{ id: 1395822921 }] };
      };
    if (extra)
      await assert.rejects(
        () => installationClient(config, pem, request),
        /APP_TOKEN_SCOPE_REJECTED/,
      );
    else assert.equal(typeof (await installationClient(config, pem, request)), "function");
    assert.deepEqual(calls[1].body.repository_ids, [1395822921]);
  }
});
test("App HTTP transport is fixed-origin bounded and does not follow redirects", async () => {
  const saved = globalThis.fetch;
  let options;
  globalThis.fetch = async (url, o) => {
    assert.ok(url.startsWith("https://api.github.com/"));
    options = o;
    return new Response("", { status: 302 });
  };
  try {
    await assert.rejects(() => appRequest("/app", "test-token"), /APP_API_REJECTED/);
    assert.equal(options.redirect, "error");
    await assert.rejects(
      () => appRequest("https://evil.example/app", "test-token"),
      /APP_ROUTE_REJECTED/,
    );
  } finally {
    globalThis.fetch = saved;
  }
});

test("S5 encoded traversal is rejected before any network or credential use", async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error("network must not run");
  };
  try {
    for (const route of [
      "/repos/mahmoudemad68/Your_Editor/%2e%2e/other",
      "/repos/mahmoudemad68/Your_Editor/%252e%252e/other",
      "/repos/mahmoudemad68/Your_Editor/pulls%2f100",
      "/repos/mahmoudemad68/Your_Editor/pulls/100#fragment",
      "/repos/mahmoudemad68/Your_Editor/pulls/100?unexpected=1",
    ])
      await assert.rejects(() => appRequest(route, "synthetic"), /APP_ROUTE_REJECTED/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test("S5 external host rejects loader, proxy and unknown credential variables", () => {
  for (const name of [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "HTTPS_PROXY",
    "https_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "ARBITRARY_SECRET",
  ])
    assert.throws(() => assertExternalHost({ [name]: "false" }));
});

function unrelated(f, number) {
  const pr = {
    ...f.snapshot.pr,
    number,
    draft: false,
    merged: false,
    state: "open",
    head: { ...f.snapshot.pr.head, sha: String(number).padStart(40, "0") },
  };
  f.rows[`pulls/${number}`] = pr;
  f.rows[
    `commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all&per_page=100&page=1`
  ] = { total_count: 0, check_runs: [] };
  return pr;
}
test("S1 unrelated registry PR receives authenticated neutral, never candidate admission", async () => {
  const f = candidateFixture();
  unrelated(f, 104);
  const c = client(f);
  const result = await reconcileAppCheck(
    c.read,
    config,
    () => {
      throw Error("must not authorize");
    },
    104,
  );
  assert.equal(result.conclusion, "neutral");
  const decision = JSON.parse(c.writes.at(-1).body.output.summary);
  assert.equal(decision.pr, 104);
  assert.equal(decision.candidate_admission_authorized, false);
  assert.equal(decision.release_authorized, false);
});

for (const number of [1, 99, 101, 104, 200])
  for (const merged of [false, true])
    test(`S1 PR ${number} (registry/Dependabot) remains neutral after PR100 merged=${merged}`, async () => {
      const f = candidateFixture();
      f.snapshot.pr.merged = merged;
      f.snapshot.pr.state = merged ? "closed" : "open";
      const p = unrelated(f, number),
        c = client(f);
      const result = await reconcileAppCheck(
        c.read,
        config,
        () => assert.fail("must not authorize"),
        number,
      );
      assert.equal(result.conclusion, "neutral");
      const body = c.writes.at(-1).body;
      assert.equal(body.name, APP_CHECK);
      assert.equal(body.head_sha, p.head.sha);
      const d = JSON.parse(body.output.summary);
      assert.equal(d.pr, number);
      assert.equal(d.candidate_admission_authorized, false);
      assert.equal(d.release_authorized, false);
    });
for (const edit of [
  (p) => (p.number = 100),
  (p) => (p.base.ref = "untrusted"),
  (p) => (p.base.repo.id = 1),
])
  test("S1 unrelated PR cannot spoof number or repository", async () => {
    const f = candidateFixture();
    f.rows["pulls/104"] = globalThis.structuredClone(unrelated(f, 104));
    edit(f.rows["pulls/104"]);
    const c = client(f);
    await assert.rejects(() => reconcileAppCheck(c.read, config, undefined, 104), /APP_LIVE_DRIFT/);
    assert.equal(c.writes.length, 0);
  });
for (const conclusion of ["neutral", "skipped"])
  test(`S1 GitHub-acceptable ${conclusion} is never accepted as candidate authority`, async () => {
    const f = candidateFixture();
    f.rows["check-runs/143"].conclusion = conclusion;
    await assert.rejects(
      () => observeCandidateAdmission(f.context, f.read),
      /CANDIDATE_REQUIRED_CHECK_DRIFT/,
    );
  });
for (const edit of [
  (p) => (p.state = "closed"),
  (p) => (p.draft = false),
  (p) => {
    p.merged = true;
    p.state = "closed";
  },
])
  test("S4 close/undraft/merge invalidates old positive before further evaluation", async () => {
    const f = candidateFixture();
    edit(f.snapshot.pr);
    const c = client(f);
    assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "failure");
    assert.equal(c.writes[0].body.conclusion, "failure");
    assert.ok(c.writes.every((w) => w.body.conclusion !== "success"));
  });
test("S4 API/policy failure cannot preserve previous successful check", async () => {
  const f = candidateFixture(),
    c = client(f);
  let called = false;
  const r = await reconcileAppCheck(c.read, config, async () => {
    called = true;
    assert.equal(c.writes[0].body.conclusion, "failure");
    throw Error("POLICY_REVOKED");
  });
  assert.equal(called, true);
  assert.equal(r.conclusion, "failure");
});
test("S4 policy revocation between decision and check publication revokes success", async () => {
  const f = candidateFixture(),
    c = client(f);
  let n = 0;
  await assert.rejects(
    () =>
      reconcileAppCheck(c.read, config, async () => ({
        ...f.decision,
        registry_sha256: (++n === 1 ? "1" : "2").repeat(64),
      })),
    /APP_POLICY_REVOKED/,
  );
  assert.equal(c.writes.at(-1).body.conclusion, "failure");
  assert.equal(n, 2);
});
for (const field of ["sha", "merge_commit_sha"])
  test(`S4 ${field} race after write invalidates the check`, async () => {
    const f = candidateFixture();
    let n = 0;
    const c = client(f, {
      afterWrite: (b) => {
        if (b.conclusion === "success" && !n++) {
          if (field === "sha") f.snapshot.pr.base.sha = "9".repeat(40);
          else f.snapshot.pr.merge_commit_sha = "9".repeat(40);
        }
      },
    });
    await assert.rejects(() => reconcileAppCheck(c.read, config), /APP_LIVE_DRIFT/);
    assert.equal(c.writes.at(-1).body.conclusion, "failure");
  });
test("S4 a tracked old-head check is invalidated before reconciling a new head", async () => {
  const f = candidateFixture();
  const oldH = "9".repeat(40);
  const tracked = new Map([[104, { check: 144, H: oldH, B: f.context.B, M: f.context.M }]]);
  unrelated(f, 104);
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [f.rows["pulls/104"]];
  const c = client(f);
  const out = await reconcileAppCycle(c.read, config, tracked);
  const revoked = c.writes.findIndex((w) => w.route === "check-runs/144");
  const accepted = c.writes.findIndex((w) => w.body.conclusion === "neutral");
  assert.ok(revoked >= 0 && accepted > revoked);
  assert.equal(c.writes[revoked].body.conclusion, "failure");
  assert.equal(out.find((x) => x.pr === 104).conclusion, "neutral");
});
for (const edit of [
  (f) =>
    (f.rows["rulesets/77"].bypass_actors = [
      { actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]),
  (f) => delete f.rows["rulesets/77"].bypass_actors,
  (f) => (f.rows["branches/main/protection"].enforce_admins.enabled = false),
  (f) =>
    (f.rows["branches/main/protection"].required_pull_request_reviews = {
      required_approving_review_count: 1,
      bypass_pull_request_allowances: { users: [{ id: 1 }], teams: [], apps: [] },
    }),
])
  test("S5 bypass or unverifiable protection never yields App authorization", async () => {
    const f = candidateFixture();
    edit(f);
    const c = client(f);
    assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "failure");
    assert.ok(c.writes.every((w) => w.body.conclusion !== "success"));
  });
test("S5 App read routes and queries are closed; writes limited to tokens/checks", () => {
  for (const r of [
    "/app",
    "/installation/repositories",
    "/repos/mahmoudemad68/Your_Editor/branches/main/protection",
    "/repos/mahmoudemad68/Your_Editor/pulls?state=open&base=main&per_page=100&page=1",
  ])
    validateAppRoute(r);
  for (const [r, m] of [
    ["/repos/mahmoudemad68/Your_Editor/issues/1", "GET"],
    ["/repos/mahmoudemad68/Your_Editor/pulls/100", "PATCH"],
    ["/app?x=1", "GET"],
    ["/repos/mahmoudemad68/Your_Editor/pulls?state=open&state=closed", "GET"],
  ])
    assert.throws(() => validateAppRoute(r, m), /APP_ROUTE_REJECTED/);
});

test("S1 same-H unrelated PR can never overwrite candidate check with neutral", async () => {
  const f = candidateFixture();
  f.rows["pulls/104"] = { ...f.snapshot.pr, number: 104 };
  const c = client(f);
  const r = await reconcileAppCheck(c.read, config, undefined, 104);
  assert.equal(r.conclusion, "failure");
  assert.equal(r.outcome, "APP_HEAD_SHARED_WITH_CANDIDATE");
  assert.ok(c.writes.every((w) => w.body.conclusion !== "neutral"));
});
test("S5 actual CLI rejects unsafe host environment before any key-file access", () => {
  const r = spawnSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../../tools/test/pc100-admission-app.mjs"),
      "--once",
      "/nonexistent-key-never-read",
    ],
    {
      env: { PATH: process.env.PATH, HTTPS_PROXY: "private-marker-must-not-leak" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /APP_HOST_ENV_REJECTED/);
  assert.doesNotMatch(r.stderr, /private-marker|ENOENT|nonexistent-key/);
});

test("S5 independent context cannot waive original CI/Supply or review requirements", async () => {
  for (const edit of [
    (f) => f.rows["rules/branches/main"][0].parameters.required_status_checks.pop(),
    (f) =>
      (f.rows[
        "branches/main/protection"
      ].required_pull_request_reviews.required_approving_review_count = 0),
    (f) => (f.rows["branches/main/protection"].required_status_checks.strict = false),
  ]) {
    const f = candidateFixture();
    edit(f);
    const c = client(f);
    assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "failure");
  }
});
test("S4 expired positive is never current candidate evidence", async () => {
  const f = candidateFixture();
  f.rows["check-runs/143"].completed_at = new Date(Date.now() - 601000).toISOString();
  await assert.rejects(
    () => observeCandidateAdmission(f.context, f.read),
    /CANDIDATE_APP_EVIDENCE_EXPIRED/,
  );
});

test("S1 actual GitHub list shape lacks merged; authoritative detail is fetched before neutral", async () => {
  const f = candidateFixture(),
    p = unrelated(f, 104),
    listed = { ...p, merged_at: null };
  delete listed.merged;
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [listed];
  const c = client(f),
    out = await reconcileAppCycle(c.read, config);
  assert.equal(out.find((r) => r.pr === 104).conclusion, "neutral");
});
