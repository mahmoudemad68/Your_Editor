/** Hermetic App API/crypto tests. Never an installation or security-policy approval. */
import { test } from "node:test";
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
  assert.equal(JSON.parse(c.writes[0].body.output.summary).release_authorized, false);
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
