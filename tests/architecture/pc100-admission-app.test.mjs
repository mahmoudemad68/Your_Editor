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
  AppAPIError,
  assertExternalKeyPath,
  readExternalKeyFile,
  appJWT,
  installationClient,
  reconcileAppCheck,
  appRequest,
  reconcileAppCycle,
  validateAppRoute,
  validateAppJournal,
  openAppJournal,
  reconcileJournal,
  invalidateAppCheck,
  protectionReaderClient,
  probeProtectionReader,
  validateProtectionRoute,
} from "../../tools/test/pc100-admission-app.mjs";
import {
  APP_CHECK,
  validateAppConfig,
  validateEnforcementRules,
  observeCandidateAdmission,
  inspectProtectionVisibility,
} from "../../tools/test/pc100-candidate-policy.mjs";
import {
  candidateFixture,
  blobSHA,
  branchBypassFixture,
} from "./support/candidate-policy-fixture.mjs";
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
// These generated keys and tokens are hermetic test inputs, never live credentials.
const readerConfig = {
  schema: "pc100-protection-reader-v1",
  repository_id: 1395822921,
  app_id: 357911,
  installation_id: 23456,
  slug: "read-only-test-only",
};
const withReader = { ...config, protection_reader: readerConfig };
function protectionAPI(edit = () => {}) {
  const f = candidateFixture(),
    calls = [],
    permissions = { administration: "read", metadata: "read" };
  const rows = {
    "/app": { id: readerConfig.app_id, slug: readerConfig.slug, permissions },
    [`/app/installations/${readerConfig.installation_id}`]: {
      id: readerConfig.installation_id,
      app_id: readerConfig.app_id,
      app_slug: readerConfig.slug,
      repository_selection: "selected",
      suspended_at: null,
      permissions,
    },
    [`/app/installations/${readerConfig.installation_id}/access_tokens`]: {
      token: "hermetic-reader-token",
      expires_at: new Date(Date.now() + 3500000).toISOString(),
      permissions,
    },
    "/installation/repositories?per_page=100&page=1": {
      total_count: 1,
      repositories: [{ id: 1395822921, full_name: "mahmoudemad68/Your_Editor" }],
    },
  };
  edit(rows, f);
  const request = async (route, token, method = "GET", body, cap) => {
    calls.push({ route, token, method, body, cap });
    if (Object.hasOwn(rows, route)) return rows[route];
    if (route === "/graphql") {
      assert.equal(token, "hermetic-reader-token");
      assert.equal(method, "POST");
      return branchBypassFixture(f.context.B);
    }
    assert.equal(token, "hermetic-reader-token");
    assert.equal(method, "GET");
    return f.read(route.replace("/repos/mahmoudemad68/Your_Editor/", ""));
  };
  return { rows, f, calls, request };
}
test("read-only reader mints a repository-scoped token and probe grants no authority", async () => {
  const p = protectionAPI(),
    result = await probeProtectionReader(withReader, pem, p.request);
  assert.equal(result.outcome, "READ_ONLY_PROTECTION_VISIBILITY_OBSERVED");
  assert.equal(result.B, p.f.context.B);
  for (const k of ["candidate_admission_authorized", "release_authorized", "live_a6_enforced"])
    assert.equal(result[k], false);
  assert.equal(JSON.stringify(result).includes("hermetic-reader-token"), false);
  assert.equal(p.calls.filter((c) => c.method !== "GET" && c.route !== "/graphql").length, 1);
  const mint = p.calls.find((c) => c.method === "POST");
  assert.deepEqual(mint.body, {
    repository_ids: [1395822921],
    permissions: { administration: "read", metadata: "read" },
  });
  const jwt = JSON.parse(Buffer.from(mint.token.split(".")[1], "base64url"));
  assert.equal(jwt.iss, String(readerConfig.app_id));
  assert.ok(p.calls.every((c) => c.cap === 2 * 1024 ** 2));
});
for (const [label, edit] of [
  ["wrong App", (r) => r["/app"].id++],
  ["wrong slug", (r) => (r["/app"].slug = "other")],
  [
    "App write permission",
    (r) => (r["/app"].permissions = { administration: "write", metadata: "read" }),
  ],
  [
    "App extra read permission",
    (r) => (r["/app"].permissions = { administration: "read", metadata: "read", contents: "read" }),
  ],
  ["wrong installation", (r) => r[Object.keys(r)[1]].id++],
  ["wrong installation App", (r) => r[Object.keys(r)[1]].app_id++],
  ["all-repository installation", (r) => (r[Object.keys(r)[1]].repository_selection = "all")],
  ["suspended installation", (r) => (r[Object.keys(r)[1]].suspended_at = new Date().toISOString())],
  [
    "installation checks permission",
    (r) =>
      (r[Object.keys(r)[1]].permissions = {
        administration: "read",
        metadata: "read",
        checks: "write",
      }),
  ],
  ["expired token", (r) => (r[Object.keys(r)[2]].expires_at = new Date(0).toISOString())],
  [
    "overlong token lifetime",
    (r) => (r[Object.keys(r)[2]].expires_at = new Date(Date.now() + 7200000).toISOString()),
  ],
  [
    "token permission expansion",
    (r) => (r[Object.keys(r)[2]].permissions = { administration: "write", metadata: "read" }),
  ],
  [
    "token missing metadata",
    (r) => (r[Object.keys(r)[2]].permissions = { administration: "read" }),
  ],
  ["multiple repositories", (r) => (r[Object.keys(r)[3]].total_count = 2)],
  ["wrong repository ID", (r) => r[Object.keys(r)[3]].repositories[0].id++],
  [
    "wrong repository name",
    (r) => (r[Object.keys(r)[3]].repositories[0].full_name = "other/other"),
  ],
])
  test(`reader rejects ${label} without check publication`, async () => {
    const p = protectionAPI(edit);
    await assert.rejects(
      () => protectionReaderClient(withReader, pem, p.request),
      /PROTECTION_READER_/,
    );
    assert.equal(
      p.calls.some((c) => c.route.includes("check-runs")),
      false,
    );
  });
test("reader descriptor cannot alias the issuer, extend its schema or activate by PR assertion", async () => {
  for (const edit of [
    { app_id: config.app_id },
    { app_id: 15368 },
    { installation_id: config.installation_id },
    { repository_id: 1 },
    { slug: "../bad" },
    { approved: true },
  ])
    assert.throws(() =>
      validateAppConfig({ ...withReader, protection_reader: { ...readerConfig, ...edit } }),
    );
  await assert.rejects(
    () => protectionReaderClient(config, pem, async () => assert.fail("network")),
    /NOT_CONFIGURED/,
  );
  await assert.rejects(
    () => installationClient(withReader, pem, async () => assert.fail("network")),
    /READER_REQUIRED/,
  );
  await assert.rejects(
    () =>
      installationClient(
        withReader,
        pem,
        async () => assert.fail("network"),
        Object.assign(async () => {}, { config: readerConfig }),
      ),
    /BINDING_REJECTED/,
  );
});
test("actual issuer dispatch isolates private protection reads from check-writing credentials", async () => {
  const p = protectionAPI(),
    reader = await protectionReaderClient(withReader, pem, p.request),
    writes = [];
  const writer = async (route, token, method, body) => {
    writes.push({ route, token, method, body });
    if (route === "/app") return { id: config.app_id, slug: config.slug };
    if (route.endsWith("access_tokens"))
      return {
        token: "hermetic-writer-token",
        expires_at: new Date(Date.now() + 3500000).toISOString(),
        permissions: {
          contents: "read",
          pull_requests: "read",
          actions: "read",
          checks: "write",
          metadata: "read",
        },
      };
    if (route === "/installation/repositories")
      return { total_count: 1, repositories: [{ id: 1395822921 }] };
    assert.equal(token, "hermetic-writer-token");
    assert.ok(!/protection|rulesets|rules\/branches/.test(route));
    return { id: 123 };
  };
  const c = await installationClient(withReader, pem, writer, reader);
  await c("branches/main/protection");
  await c.trustedSourceRead("/repos/mahmoudemad68/Your_Editor/rulesets/77");
  await assert.rejects(() => c("rulesets"), /PROTECTION_READER_ROUTE_REJECTED/);
  await assert.rejects(
    () => c.trustedSourceRead("/repos/mahmoudemad68/Your_Editor/rulesets?per_page=100&page=1"),
    /PROTECTION_READER_ROUTE_REJECTED/,
  );
  await c("check-runs", "POST", { name: "synthetic" });
  assert.equal(writes.at(-1).route, "/repos/mahmoudemad68/Your_Editor/check-runs");
  assert.equal(
    writes.some((c) => /protection|rulesets/.test(c.route)),
    false,
  );
  assert.equal(
    p.calls.some((c) => c.route.includes("check-runs")),
    false,
  );
  const legacy = await installationClient(config, pem, writer);
  assert.throws(() => legacy("branches/main/protection"), /READER_REQUIRED/);
  assert.throws(
    () => legacy.trustedSourceRead("/repos/mahmoudemad68/Your_Editor/rulesets/77"),
    /READER_REQUIRED/,
  );
  assert.throws(() => legacy("rulesets"), /READER_REQUIRED/);
});
for (const route of [
  "https://evil.example/x",
  "../branches/main",
  "rulesets/%37%37",
  "rulesets/77/../88",
  "check-runs",
  "git/commits/" + "a".repeat(40),
  "rulesets",
  "branches/main?state=open",
  "rules/branches/main?per_page=100&page=41",
  "rules/branches/main?per_page=100&page=1&page=2",
  "rules/branches/main?per_page=100&page=1&token=secret",
])
  test(`reader rejects closed-route violation ${route}`, () =>
    assert.throws(() => validateProtectionRoute(route)));
test("reader rejects all writes and request bodies before credential dispatch", async () => {
  const p = protectionAPI(),
    read = await protectionReaderClient(withReader, pem, p.request),
    n = p.calls.length;
  for (const method of ["POST", "PATCH", "PUT", "DELETE"])
    await assert.rejects(() => read("rulesets/77", method, {}), /ROUTE_REJECTED/);
  await assert.rejects(() => read("branches/main", "GET", {}), /ROUTE_REJECTED/);
  assert.equal(p.calls.length, n);
});
test("reader expires after mint and cannot be rebound to another protected configuration", async () => {
  const p = protectionAPI(),
    read = await protectionReaderClient(withReader, pem, p.request);
  const changed = { ...withReader, protection_reader: { ...readerConfig, installation_id: 99999 } };
  await assert.rejects(
    () => installationClient(changed, pem, async () => assert.fail("network"), read),
    /BINDING_REJECTED/,
  );
  p.rows[`/app/installations/${readerConfig.installation_id}/access_tokens`].expires_at = new Date(
    0,
  ).toISOString();
  const before = p.calls.length;
  await assert.rejects(() => read("branches/main"), /TOKEN_EXPIRED/);
  assert.equal(p.calls.length, before);
});
test("real probe CLI rejects Actions/credential environment before key access", () => {
  const result = spawnSync(
    process.execPath,
    ["tools/test/pc100-admission-app.mjs", "--probe-protection", "missing-private-file"],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { GITHUB_ACTIONS: "false" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APP_PR_RUNNER_FORBIDDEN/);
  assert.doesNotMatch(result.stderr, /ENOENT|missing-private-file|private key/i);
});
for (const [label, edit] of [
  ["omitted bypass actors", (f) => delete f.rows["rulesets/77"].bypass_actors],
  [
    "nonempty bypass actors",
    (f) =>
      f.rows["rulesets/77"].bypass_actors.push({
        actor_id: 1,
        actor_type: "Integration",
        bypass_mode: "always",
      }),
  ],
  ["inactive ruleset", (f) => (f.rows["rulesets/77"].enforcement = "evaluate")],
  [
    "missing administration enforcement",
    (f) => delete f.rows["branches/main/protection"].enforce_admins,
  ],
])
  test(`visibility never substitutes success for ${label}`, async () => {
    const p = protectionAPI((_r, f) => edit(f));
    await assert.rejects(
      () => probeProtectionReader(withReader, pem, p.request),
      /CANDIDATE_PROTECTION_/,
    );
  });
test("probe rejects main drift and never issues a check", async () => {
  const p = protectionAPI(),
    base = p.request;
  let count = 0;
  p.request = async (...args) => {
    const result = await base(...args);
    if (args[0].endsWith("/branches/main") && ++count === 2)
      return { ...result, commit: { ...result.commit, sha: "9".repeat(40) } };
    return result;
  };
  await assert.rejects(
    () => probeProtectionReader(withReader, pem, p.request),
    /CANDIDATE_LIVE_DRIFT/,
  );
  assert.equal(
    p.calls.some((c) => c.route.includes("check-runs")),
    false,
  );
});
test("API failures, hidden fields and incomplete pagination remain visibility failures", async () => {
  for (const status of [401, 403, 404]) {
    const p = protectionAPI(),
      request = async (...args) => {
        if (args[0].endsWith("/protection")) throw Error(`API_${status}`);
        return p.request(...args);
      };
    await assert.rejects(
      () => probeProtectionReader(withReader, pem, request),
      new RegExp(`API_${status}`),
    );
  }
  const p = protectionAPI(),
    rules = p.f.rows["rules/branches/main"];
  await assert.rejects(
    () =>
      inspectProtectionVisibility(async (route) => {
        if (route.endsWith("page=1"))
          return Array.from({ length: 100 }, (_, i) => ({ ...rules[0], ruleset_id: i + 1 }));
        if (route.endsWith("page=2")) throw Error("INCOMPLETE_PAGE");
        return p.f.read(route);
      }),
    /INCOMPLETE_PAGE/,
  );
});
test("visibility inspects bypass actors of rulesets discovered on later pages", async () => {
  const p = protectionAPI(),
    first = p.f.rows["rules/branches/main"][0],
    seen = [];
  await assert.rejects(
    () =>
      inspectProtectionVisibility(async (route) => {
        if (route.endsWith("page=1"))
          return Array.from({ length: 100 }, (_, i) => ({ ...first, ruleset_id: i + 1 }));
        if (route.endsWith("page=2")) return [{ ...first, ruleset_id: 101 }];
        if (route.startsWith("rulesets/")) {
          const id = Number(route.split("/")[1]);
          seen.push(id);
          return {
            id,
            target: "branch",
            enforcement: "active",
            ...(id === 101 ? {} : { bypass_actors: [] }),
          };
        }
        return p.f.read(route);
      }),
    /CANDIDATE_PROTECTION_BYPASS/,
  );
  assert.equal(seen.length, 101);
  assert.equal(seen.at(-1), 101);
});
test("reader response transport enforces its actual two-MiB cap and redirect rejection", async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(" ".repeat(2 * 1024 ** 2 + 1));
    await assert.rejects(
      () => appRequest("/app", "synthetic", "GET", undefined, 2 * 1024 ** 2),
      /RESPONSE_TOO_LARGE/,
    );
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, "error");
      return new Response("", { status: 302, headers: { location: "https://evil.example" } });
    };
    await assert.rejects(
      () => appRequest("/app", "synthetic", "GET", undefined, 2 * 1024 ** 2),
      /APP_API_REJECTED/,
    );
  } finally {
    globalThis.fetch = saved;
  }
});
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
  f.rows["check-runs/143"].completed_at = new Date(Date.now() - 400000).toISOString();
  const writes = [];
  const read = async (route, method = "GET", body) => {
    if (method !== "GET") {
      writes.push({ route, method, body });
      const id = method === "POST" ? 143 : Number(route.split("/").at(-1));
      const prior = f.rows[`check-runs/${id}`] ?? f.rows["check-runs/143"];
      f.rows[`check-runs/${id}`] = { ...prior, ...body, id };
      for (const [route, page] of Object.entries(f.rows))
        if (route.startsWith("commits/") && page?.check_runs)
          page.check_runs = page.check_runs.map((c) =>
            c.id === 143 ? f.rows["check-runs/143"] : c,
          );
      await changes.afterWrite?.(body);
      return f.rows[`check-runs/${id}`];
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
  // Genuine unrelated fixture: its complete source is identical to protected
  // main, not an arbitrary head granted neutral by its PR number.
  f.rows[`git/commits/${pr.head.sha}`] = {
    sha: pr.head.sha,
    tree: { sha: f.snapshot.trustedTree.sha },
  };
  f.rows[
    `commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all&per_page=100&page=1`
  ] = { total_count: 0, check_runs: [] };
  return pr;
}

for (const kind of ["deleted fork", "retargeted PR"])
  test(`QA107 HIGH-1 ${kind} cannot abort healthy PR polling`, async () => {
    const f = candidateFixture();
    f.snapshot.pr.state = "closed";
    f.snapshot.pr.merged = true;
    const good = unrelated(f, 104),
      bad = unrelated(f, 900);
    bad.head = { ...bad.head, repo: kind === "deleted fork" ? null : { id: 424242 } };
    if (kind === "retargeted PR") bad.base = { ...bad.base, ref: "develop" };
    f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [good, bad];
    const c = client(f),
      tracked = new Map();
    const first = await reconcileAppCycle(c.read, config, tracked);
    assert.equal(first.find((x) => x.pr === 104).conclusion, "neutral");
    assert.equal(first.find((x) => x.pr === 900).outcome, "APP_PR_QUARANTINED");
    assert.ok(c.writes.every((w) => w.body.head_sha !== bad.head.sha));
    assert.equal(
      (await reconcileAppCycle(c.read, config, tracked)).find((x) => x.pr === 104).conclusion,
      "neutral",
    );
  });
test("N1 unchanged complete source receives authenticated neutral, never candidate admission", async () => {
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
    test(`N1 identical-source PR ${number} remains neutral after PR100 merged=${merged}`, async () => {
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
for (const edit of [(p) => (p.state = "closed")])
  test("S4 closed or merged candidate cannot mint a new positive", async () => {
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
    assert.equal(c.writes.length, 0);
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
  f.rows["check-runs/144"] = { ...f.rows["check-runs/143"], id: 144, head_sha: oldH };
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

test("N4 same-H fork alias uses independently verified canonical source, never neutral", async () => {
  const f = candidateFixture();
  f.rows["pulls/104"] = { ...f.snapshot.pr, number: 104 };
  const c = client(f);
  const r = await reconcileAppCheck(c.read, config, undefined, 104);
  assert.equal(r.conclusion, "success");
  assert.equal(r.pr, 100);
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

test("S5 every effective-rule page is inspected, including a later bypass ruleset", async () => {
  const f = candidateFixture();
  f.rows["rules/branches/main"].push(
    ...Array.from({ length: 99 }, (_, i) => ({
      type: "deletion",
      ruleset_id: 77,
      source_index: i,
    })),
  );
  f.rows["rules/branches/main?per_page=100&page=2"] = [{ type: "deletion", ruleset_id: 78 }];
  f.rows["rulesets/78"] = {
    id: 78,
    enforcement: "active",
    target: "branch",
    bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 1, bypass_mode: "always" }],
  };
  const c = client(f);
  const result = await reconcileAppCheck(c.read, config);
  assert.equal(result.conclusion, "failure");
  assert.equal(result.outcome, "CANDIDATE_PROTECTION_BYPASS");
});
test("S5 missing next rule page is never treated as complete enforcement", async () => {
  const f = candidateFixture();
  f.rows["rules/branches/main"].push(
    ...Array.from({ length: 99 }, (_, i) => ({
      type: "deletion",
      ruleset_id: 77,
      source_index: i,
    })),
  );
  const c = client(f);
  assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "failure");
  assert.ok(c.writes.every((w) => w.body.conclusion !== "success"));
});

for (const [label, change] of [
  [
    "entrypoint",
    (t) => {
      t.tree.find((e) => e.path.endsWith("docker-entrypoint.sh")).sha = "9".repeat(40);
    },
  ],
  [
    "addition",
    (t) =>
      t.tree.push({
        path: "unexpected/new-policy.data",
        mode: "100644",
        type: "blob",
        sha: "9".repeat(40),
        size: 1,
      }),
  ],
  [
    "mode",
    (t) => {
      t.tree[0].mode = "100755";
    },
  ],
  ["deletion", (t) => t.tree.pop()],
  [
    "rename",
    (t) => {
      t.tree[0].path = "renamed/policy";
    },
  ],
  [
    "symlink",
    (t) => {
      t.tree[0].mode = "120000";
    },
  ],
  [
    "gitlink",
    (t) => {
      t.tree[0].type = "commit";
      t.tree[0].mode = "160000";
    },
  ],
  [
    "truncated tree",
    (t) => {
      t.truncated = true;
    },
  ],
])
  test(`N1 changed-number source cannot gain neutral with unreviewed ${label}`, async () => {
    const f = candidateFixture(),
      p = unrelated(f, 200);
    const tree = globalThis.structuredClone(f.snapshot.trustedTree);
    tree.sha = "8".repeat(40);
    change(tree);
    f.rows[`git/commits/${p.head.sha}`].tree.sha = tree.sha;
    f.rows[`git/trees/${tree.sha}?recursive=1`] = tree;
    const c = client(f),
      result = await reconcileAppCheck(c.read, config, undefined, 200);
    assert.equal(result.conclusion, "failure");
    assert.ok(c.writes.every((w) => !["neutral", "success"].includes(w.body.conclusion)));
  });

test("N3 reviewed unchanged candidate remains admitted after Draft to Ready without release authority", async () => {
  const f = candidateFixture(),
    c = client(f);
  assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "success");
  f.snapshot.pr.draft = false;
  assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "success");
  assert.equal(JSON.parse(c.writes.at(-1).body.output.summary).release_authorized, false);
  f.rows["rulesets/77"].bypass_actors = [{ actor_id: 1 }];
  assert.equal((await reconcileAppCheck(c.read, config)).conclusion, "failure");
});

test("N6 stable polling has zero verdict writes, with same-conclusion bounded refresh", async () => {
  const f = candidateFixture(),
    c = client(f);
  await reconcileAppCheck(c.read, config);
  const writes = c.writes.length;
  await reconcileAppCheck(c.read, config);
  assert.equal(c.writes.length, writes);
  f.rows["check-runs/143"].completed_at = new Date(Date.now() - 400000).toISOString();
  await reconcileAppCheck(c.read, config);
  assert.equal(c.writes.length, writes + 1);
  assert.ok(c.writes.every((w) => w.body.conclusion === "success"));
});

test("N6 merged candidate ends lifecycle without new failure/check spam", async () => {
  const f = candidateFixture(),
    c = client(f);
  f.snapshot.pr.state = "closed";
  f.snapshot.pr.merged = true;
  for (let i = 0; i < 3; i++)
    assert.equal((await reconcileAppCheck(c.read, config)).outcome, "APP_MERGED_TERMINAL");
  assert.equal(c.writes.length, 0);
});

test("N4 complete same-H fork group evaluates one canonical verdict per stable cycle", async () => {
  const f = candidateFixture(),
    c = client(f),
    tracked = new Map();
  f.rows["pulls/500"] = globalThis.structuredClone(f.snapshot.pr);
  f.rows["pulls/500"].number = 500;
  f.rows["pulls/500"].head.repo.id = 1234;
  f.rows["pulls/500"].merge_commit_sha = "9".repeat(40);
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [f.rows["pulls/500"], f.snapshot.pr];
  const first = await reconcileAppCycle(c.read, config, tracked);
  assert.equal(first.filter((x) => x.conclusion === "success").length, 2);
  const count = c.writes.length;
  await reconcileAppCycle(c.read, config, tracked);
  assert.equal(c.writes.length, count);
  assert.ok(c.writes.every((w) => w.body.conclusion === "success"));
});

function journalContext(f) {
  return {
    repository_id: 1395822921,
    pr: 100,
    H: f.context.H,
    B: f.context.B,
    M: f.context.M,
    head_repository_id: 1395822921,
    state: "open",
    draft: true,
    merged: false,
  };
}
function journalValue(entries = []) {
  return {
    schema: "pc100-app-journal-v1",
    repository_id: 1395822921,
    app_id: config.app_id,
    installation_id: config.installation_id,
    entries,
  };
}
for (const [name, edit] of [
  ["other app", (v) => v.app_id++],
  ["other repository", (v) => v.repository_id++],
  ["extra field", (v) => (v.approved = true)],
  ["duplicate", (v) => v.entries.push(v.entries[0])],
  ["bad SHA", (v) => (v.entries[0].H = "invalid")],
  ["injected context", (v) => (v.entries[0].check = 1)],
])
  test(`N5 durable tracking rejects ${name}`, () => {
    const value = journalValue([journalContext(candidateFixture())]);
    edit(value);
    assert.throws(() => validateAppJournal(value, config), /APP_JOURNAL_REJECTED/);
  });
test("N5 failed write-ahead tracking prevents check publication", async () => {
  const f = candidateFixture(),
    c = client(f);
  await assert.rejects(
    () =>
      reconcileAppCheck(c.read, config, undefined, 100, {
        record: async () => {
          throw Error("APP_JOURNAL_BUSY");
        },
      }),
    /APP_JOURNAL_BUSY/,
  );
  assert.equal(c.writes.length, 0);
});
test("N5 restart reconciles journaled old head after in-memory tracking is lost", async () => {
  const f = candidateFixture(),
    c = client(f),
    prior = journalContext(f),
    removed = [];
  f.snapshot.pr.head.sha = "9".repeat(40);
  const journal = { entries: () => [prior], remove: async (x) => removed.push(x) };
  await reconcileJournal(c.read, config, journal);
  assert.equal(c.writes.length, 1);
  assert.equal(c.writes[0].body.conclusion, "failure");
  assert.equal(c.writes[0].body.output.summary, "APP_RESTART_REVALIDATION_REQUIRED");
  assert.deepEqual(removed, [prior]);
});
test("N5 orderly shutdown revokes current positives; merged history remains terminal", async () => {
  const f = candidateFixture(),
    c = client(f),
    prior = journalContext(f),
    removed = [];
  const journal = { entries: () => [prior], remove: async (x) => removed.push(x) };
  await reconcileJournal(c.read, config, journal, true);
  assert.equal(c.writes[0].body.conclusion, "failure");
  f.snapshot.pr.state = "closed";
  f.snapshot.pr.merged = true;
  c.writes.length = 0;
  await reconcileJournal(c.read, config, journal, true);
  assert.equal(c.writes.length, 0);
  assert.equal(removed.length, 2);
});
test("N5 API outage cannot claim revocation or discard tracking", async () => {
  const prior = journalContext(candidateFixture());
  let removed = false;
  await assert.rejects(
    () =>
      reconcileJournal(
        async () => {
          throw Error("APP_API_REJECTED");
        },
        config,
        {
          entries: () => [prior],
          remove: async () => {
            removed = true;
          },
        },
      ),
    /APP_API_REJECTED/,
  );
  assert.equal(removed, false);
});
test(
  "N5 Linux actual atomic journal persists heads across reopen and rejects unsafe links",
  { skip: process.platform !== "linux" },
  async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "app-journal-"))),
      file = path.join(dir, "heads.json");
    try {
      const context = journalContext(candidateFixture()),
        first = await openAppJournal(file, config);
      await first.record(context);
      const second = await openAppJournal(file, config);
      assert.deepEqual(second.entries(), [context]);
      await second.remove(context);
      assert.deepEqual((await openAppJournal(file, config)).entries(), []);
      await chmod(file, 0o644);
      await assert.rejects(() => openAppJournal(file, config), /APP_JOURNAL_PERMISSIONS_REJECTED/);
      await chmod(file, 0o600);
      const alias = path.join(dir, "alias");
      await link(file, alias);
      await assert.rejects(() => openAppJournal(file, config), /APP_JOURNAL_PERMISSIONS_REJECTED/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("N5 revocation can proceed when PR metadata fails but check APIs remain available", async () => {
  const f = candidateFixture(),
    c = client(f),
    prior = journalContext(f),
    removed = [];
  const read = async (route, method, body) => {
    if (route.startsWith("pulls/")) throw Error("APP_API_REJECTED");
    return c.read(route, method, body);
  };
  await reconcileJournal(
    read,
    config,
    { entries: () => [prior], remove: async (x) => removed.push(x) },
    true,
  );
  assert.equal(c.writes.length, 1);
  assert.equal(c.writes[0].body.conclusion, "failure");
  assert.deepEqual(removed, [prior]);
});

for (const [name, result] of [
  ["wrong id", { id: 2, status: "completed", conclusion: "failure", head_sha: "a".repeat(40) }],
  [
    "unchanged positive",
    { id: 1, status: "completed", conclusion: "success", head_sha: "a".repeat(40) },
  ],
  ["wrong head", { id: 1, status: "completed", conclusion: "failure", head_sha: "9".repeat(40) }],
])
  test(`N6 unverifiable ${name} cannot count as remote revocation`, async () => {
    await assert.rejects(
      () =>
        invalidateAppCheck(
          async (_route, method = "GET") =>
            method === "GET"
              ? {
                  id: 1,
                  name: APP_CHECK,
                  status: "completed",
                  conclusion: "success",
                  head_sha: "a".repeat(40),
                }
              : result,
          { check: 1, H: "a".repeat(40) },
        ),
      /APP_REVOCATION_UNCONFIRMED/,
    );
  });

test("N4 a closed deleted fork cannot revoke the canonical same-H check", async () => {
  const f = candidateFixture(),
    c = client(f),
    tracked = new Map();
  const alias = globalThis.structuredClone(f.snapshot.pr);
  alias.number = 500;
  alias.head.repo.id = 1234;
  f.rows["pulls/500"] = alias;
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [f.snapshot.pr, alias];
  await reconcileAppCycle(c.read, config, tracked);
  const count = c.writes.length;
  alias.state = "closed";
  alias.head.repo = null;
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [f.snapshot.pr];
  const result = await reconcileAppCycle(c.read, config, tracked);
  assert.equal(result.find((x) => x.pr === 100).conclusion, "success");
  assert.equal(c.writes.length, count);
  assert.equal(tracked.has(500), false);
});

test("N4 an open PR with missing head repository remains untrusted", async () => {
  const f = candidateFixture(),
    c = client(f);
  f.snapshot.pr.head.repo = null;
  await assert.rejects(() => reconcileAppCheck(c.read, config), /APP_LIVE_DRIFT/);
  assert.equal(c.writes.length, 0);
});

test("N6 journal and same-H aliases revoke a failed cycle only once", async () => {
  const f = candidateFixture(),
    c = client(f),
    context = journalContext(f);
  let entries = [context];
  const journal = {
    entries: () => entries,
    remove: async () => {
      entries = [];
    },
  };
  const tracked = new Map([100, 500].map((pr) => [pr, { ...context, pr, check: 143 }]));
  const read = async (route, method, body) => {
    if (route.startsWith("pulls?")) throw Error("APP_API_REJECTED");
    return c.read(route, method, body);
  };
  await assert.rejects(() => reconcileAppCycle(read, config, tracked, journal), /APP_API_REJECTED/);
  assert.equal(c.writes.length, 1);
  assert.equal(c.writes[0].body.conclusion, "failure");
});

test("N6 a verified existing failure is not rewritten for another revocation reason", async () => {
  const f = candidateFixture(),
    c = client(f),
    item = { check: 143, H: f.context.H };
  await invalidateAppCheck(c.read, item, "FIRST_FAILURE");
  await invalidateAppCheck(c.read, item, "SECOND_FAILURE");
  assert.equal(c.writes.length, 1);
});

// Independent multi-head API model: IDs never alias between fixture writes.
function quarantineWorld() {
  const f = candidateFixture();
  f.snapshot.pr.state = "closed";
  f.snapshot.pr.merged = true;
  const good = unrelated(f, 104),
    bad = unrelated(f, 900),
    writes = [];
  let next = 200;
  f.rows["pulls?state=open&base=main&per_page=100&page=1"] = [good, bad];
  const read = async (route, method = "GET", body) => {
    if (method !== "GET") {
      const id = method === "POST" ? next++ : Number(route.split("/").at(-1));
      const value = {
        ...f.rows[`check-runs/${id}`],
        ...body,
        id,
        app: { id: config.app_id, slug: config.slug },
      };
      f.rows[`check-runs/${id}`] = value;
      writes.push({ route, body });
      const page = `commits/${value.head_sha}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all&per_page=100&page=1`;
      f.rows[page] = { total_count: 1, check_runs: [value] };
      return value;
    }
    if (route.startsWith("commits/") && !Object.hasOwn(f.rows, route)) throw new AppAPIError(404);
    return f.read(route);
  };
  return { f, good, bad, read, writes };
}
for (const kind of [
  "deleted fork",
  "retarget",
  "null list row",
  "wrong ID",
  "duplicate ID",
  "detail wrong ID",
  "head mutation",
])
  test(`QA107 HIGH-1 independent lifecycle isolates ${kind} through restart`, async () => {
    const w = quarantineWorld(),
      tracked = new Map();
    await reconcileAppCycle(w.read, config, tracked);
    const goodCheck = tracked.get(104).check;
    if (kind === "deleted fork") w.bad.head.repo = null;
    if (kind === "retarget") w.bad.base = { ...w.bad.base, ref: "develop" };
    if (kind === "null list row")
      w.f.rows["pulls?state=open&base=main&per_page=100&page=1"].push(null);
    if (kind === "wrong ID")
      w.f.rows["pulls?state=open&base=main&per_page=100&page=1"].push({ number: "900" });
    if (kind === "duplicate ID")
      w.f.rows["pulls?state=open&base=main&per_page=100&page=1"].push({ ...w.bad });
    if (kind === "detail wrong ID") w.f.rows["pulls/900"] = { ...w.bad, number: 901 };
    if (kind === "head mutation") w.bad.head = { ...w.bad.head, sha: "e".repeat(40), repo: null };
    const out = await reconcileAppCycle(w.read, config, tracked);
    assert.equal(out.find((r) => r.pr === 104).conclusion, "neutral");
    assert.equal(w.f.rows[`check-runs/${goodCheck}`].conclusion, "neutral");
    assert.ok(out.some((r) => r.outcome === "APP_PR_QUARANTINED"));
    assert.equal(
      (await reconcileAppCycle(w.read, config, new Map())).find((r) => r.pr === 104).conclusion,
      "neutral",
    );
  });
test("QA107 HIGH-1 deleted/retargeted journal entry only invalidates its own head", async () => {
  const w = quarantineWorld(),
    tracked = new Map();
  await reconcileAppCycle(w.read, config, tracked);
  const entries = [104, 900].map((n) => {
    const {
      check: _check,
      conclusion: _conclusion,
      outcome: _outcome,
      terminal: _terminal,
      ...c
    } = tracked.get(n);
    return c;
  });
  let values = entries;
  const journal = {
    entries: () => values,
    remove: async (c) => {
      values = values.filter((v) => v.pr !== c.pr);
    },
    record: async () => {},
  };
  w.bad.head.repo = null;
  const goodCheck = tracked.get(104).check;
  await reconcileAppCycle(w.read, config, tracked, journal);
  assert.equal(w.f.rows[`check-runs/${goodCheck}`].conclusion, "neutral");
  assert.equal(
    values.some((v) => v.pr === 900),
    false,
  );
});
test("QA107 HIGH-1 journal mutation failure remains global fail-closed, not a PR quarantine", async () => {
  const w = quarantineWorld(),
    tracked = new Map();
  await reconcileAppCycle(w.read, config, tracked);
  const journal = {
    entries: () => [],
    record: async () => {
      throw Error("APP_JOURNAL_BUSY");
    },
    remove: async () => {},
  };
  await assert.rejects(
    () => reconcileAppCycle(w.read, config, tracked, journal),
    /APP_JOURNAL_BUSY/,
  );
  assert.ok(
    [...tracked.values()].every((c) => w.f.rows[`check-runs/${c.check}`].conclusion === "failure"),
  );
});
test("QA107 BLOCKER-1 Reader-only GraphQL delegation has fixed query and no writer fallback", async () => {
  const p = protectionAPI(),
    client = await protectionReaderClient(withReader, pem, p.request);
  const result = await client.branchProtectionGraphQL();
  assert.equal(result.data.repository.databaseId, 1395822921);
  const calls = p.calls.filter((c) => c.route === "/graphql");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, "hermetic-reader-token");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.query.includes("mutation"), false);
  assert.deepEqual(Object.keys(calls[0].body), ["query"]);
  await assert.rejects(
    () => client("/graphql", "POST", { query: "mutation { evil }" }),
    /ROUTE_REJECTED/,
  );
});

test("QA107 HIGH-1 reboot quarantines existing malformed-head positives without in-memory state", async () => {
  const w = quarantineWorld(),
    tracked = new Map();
  await reconcileAppCycle(w.read, config, tracked);
  const badCheck = tracked.get(900).check,
    goodCheck = tracked.get(104).check;
  w.bad.head.repo = null;
  await reconcileAppCycle(w.read, config, new Map());
  assert.equal(w.f.rows[`check-runs/${badCheck}`].conclusion, "failure");
  assert.equal(w.f.rows[`check-runs/${goodCheck}`].conclusion, "neutral");
});

for (const status of [401, 403, 429, 500])
  test(`QA107 HIGH-1 HTTP ${status} remains global, not a missing-head quarantine`, async () => {
    const w = quarantineWorld(),
      tracked = new Map();
    await reconcileAppCycle(w.read, config, tracked);
    w.bad.head.repo = null;
    const read = async (route, ...args) => {
      if (route.startsWith(`commits/${w.bad.head.sha}/`)) throw new AppAPIError(status);
      return w.read(route, ...args);
    };
    await assert.rejects(() => reconcileAppCycle(read, config, tracked), /APP_API_REJECTED/);
  });
