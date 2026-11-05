/** Executes the committed runner preflight and parses its real workflow.
 * No release, token, network, package installation or general expression evaluator.
 * The closed model implements the string comparisons/conjunction/status functions
 * used here, including GitHub's case-INSENSITIVE string equality. Unsupported
 * syntax fails instead of being silently approximated. js-yaml is already locked
 * as an ESLint dependency; this adds no package or lockfile changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
const { load } = createRequire(import.meta.resolve("eslint"))("js-yaml");
const root = path.resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const source = read(".github/workflows/supply-chain.yml"),
  workflow = load(source);
const auth = "release-authorization";
const stepNames = [
  "Preserve scanned production image for main publication",
  "Upload scanned image",
];
const clone = (v) => globalThis.structuredClone(v);
const needsList = (job) =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
const lookup = (ctx, key) => key.split(".").reduce((o, k) => o?.[k], ctx) ?? "";
function expression(input, ctx) {
  if (input === undefined) return true;
  const s = String(input)
    .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1")
    .trim();
  return s.split(/\s*&&\s*/).every((c) => {
    if (c === "true" || c === "false") return c === "true";
    if (c === "!cancelled()") return !ctx.cancelled;
    if (c === "success()") return ctx.success !== false;
    if (c === "always()") return true;
    const m = /^([A-Za-z_][\w.-]*)\s*(==|!=)\s*'([^']*)'$/.exec(c);
    assert.ok(m, `unsupported runner expression: ${c}`);
    const actual = lookup(ctx, m[1]);
    assert.equal(typeof actual, "string", "these workflow contexts must be runner strings");
    const equal = actual.toLowerCase() === m[3].toLowerCase();
    return m[2] === "==" ? equal : !equal;
  });
}
function jobRuns(w, id, ctx) {
  const job = w.jobs[id];
  const explicitStatus = /\b(?:cancelled|always|success|failure)\(/.test(String(job.if));
  return (
    (explicitStatus || needsList(job).every((n) => ctx.needs[n]?.result === "success")) &&
    expression(job.if, ctx)
  );
}
function preflight(w, input, options = {}) {
  const guard = w.jobs[auth]?.steps.find((s) => s.id === "guard");
  assert.ok(guard, "missing release preflight");
  const dir = mkdtempSync(path.join(tmpdir(), "release-guard-")),
    out = path.join(dir, "output");
  try {
    const env = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      GITHUB_OUTPUT: out,
      GITHUB_EVENT_NAME: input.event,
      GITHUB_REF: input.ref,
    };
    for (const [key, expr] of Object.entries(guard.env)) {
      const match = /^\$\{\{ vars\.([A-Z_]+) \}\}$/.exec(expr);
      assert.ok(match, "preflight accepts only raw repository variables");
      if (input[match[1]] !== undefined) env[key] = input[match[1]];
    }
    if (options.noOutput) delete env.GITHUB_OUTPUT;
    const result = spawnSync(process.execPath, ["--input-type=commonjs"], {
      input: guard.run,
      env,
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    if (options.noOutput) {
      assert.notEqual(result.status, 0);
      return {};
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", "do not print raw configuration");
    const bytes = existsSync(out) ? readFileSync(out, "utf8") : "";
    assert.match(bytes, /^authorized=[01]\nstaging_authorized=[01]\n$/);
    return Object.fromEntries(
      bytes
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const normal = {
  event: "push",
  ref: "refs/heads/main",
  RELEASE_HOLD: "false",
  RELEASE_PUBLICATION_ENABLED: "true",
  STAGING_CD_ENABLED: "true",
};
function context(input, outputs, authResult = "success") {
  return {
    github: { event_name: input.event, ref: input.ref },
    vars: input,
    matrix: { service: "api" },
    cancelled: false,
    success: true,
    needs: Object.fromEntries(
      [auth, "dependencies", "images", "supply-chain-security", "publish", "release"].map((n) => [
        n,
        { result: n === auth ? authResult : "success", outputs: n === auth ? outputs : {} },
      ]),
    ),
  };
}
function surfaces(w, ctx) {
  return [
    ...stepNames.map((name) => {
      const s = w.jobs.images.steps.find((s) => s.name === name);
      assert.ok(s, `missing original surface ${name}`);
      return ctx.success && jobRuns(w, "images", ctx) && expression(s.if, ctx);
    }),
    ...["publish", "release", "staging"].map((id) => jobRuns(w, id, ctx)),
  ];
}
function validateContract(w) {
  const a = w.jobs[auth];
  assert.ok(a, "preflight missing");
  assert.deepEqual(a.permissions, {});
  assert.equal(a["runs-on"], "ubuntu-24.04");
  assert.ok(a["timeout-minutes"] <= 2);
  assert.deepEqual(needsList(a), []);
  assert.deepEqual(a.outputs, {
    authorized: "${{ steps.guard.outputs.authorized }}",
    staging_authorized: "${{ steps.guard.outputs.staging_authorized }}",
  });
  assert.equal(a.steps.length, 1);
  assert.equal(a.steps[0].shell, "node {0}");
  assert.equal(a.steps[0].uses, undefined);
  assert.deepEqual(a.steps[0].env, {
    RELEASE_HOLD: "${{ vars.RELEASE_HOLD }}",
    RELEASE_PUBLICATION_ENABLED: "${{ vars.RELEASE_PUBLICATION_ENABLED }}",
    STAGING_CD_ENABLED: "${{ vars.STAGING_CD_ENABLED }}",
  });
  assert.deepEqual(needsList(w.jobs.images), [auth]);
  assert.equal(w.jobs.images.if, "${{ !cancelled() }}");
  assert.deepEqual(needsList(w.jobs.dependencies), []);
  assert.deepEqual(needsList(w.jobs["supply-chain-security"]), ["dependencies", "images"]);
  assert.deepEqual(needsList(w.jobs.publish), [
    auth,
    "dependencies",
    "images",
    "supply-chain-security",
  ]);
  assert.deepEqual(needsList(w.jobs.release), [auth, "publish"]);
  assert.deepEqual(needsList(w.jobs.staging), [auth, "release"]);
  for (const condition of [
    ...stepNames.map((n) => w.jobs.images.steps.find((s) => s.name === n).if),
    ...["publish", "release", "staging"].map((n) => w.jobs[n].if),
  ]) {
    assert.match(condition, /needs\.release-authorization\.outputs\.authorized == '1'/);
    assert.match(condition, /needs\.release-authorization\.result == 'success'/);
    assert.doesNotMatch(
      condition,
      /always\(|\|\||vars\.RELEASE_HOLD|vars\.RELEASE_PUBLICATION_ENABLED/,
    );
  }
  assert.match(w.jobs.staging.if, /vars\.STAGING_CD_ENABLED == 'true'/);
  assert.match(
    w.jobs.staging.if,
    /needs\.release-authorization\.outputs\.staging_authorized == '1'/,
  );
}
test("committed workflow has closed authorization, explicit dependencies, all five gates", () =>
  validateContract(workflow));
test("closed runner model preserves GitHub case-insensitive comparison and needs/status semantics", () => {
  assert.equal(
    expression("vars.RELEASE_HOLD == 'false'", { vars: { RELEASE_HOLD: "FALSE" } }),
    true,
  );
  assert.equal(
    expression("github.ref == 'refs/heads/main'", { github: { ref: "refs/heads/MAIN" } }),
    true,
  );
  assert.throws(() => expression("unknown(1)", {}));
});
const denied = [
  ["missing hold", { RELEASE_HOLD: undefined }],
  ["missing publication flag", { RELEASE_PUBLICATION_ENABLED: undefined }],
  ["empty", { RELEASE_HOLD: "", RELEASE_PUBLICATION_ENABLED: "" }],
  ["active hold", { RELEASE_HOLD: "true" }],
  ["disabled", { RELEASE_PUBLICATION_ENABLED: "false" }],
  ["uppercase", { RELEASE_HOLD: "FALSE", RELEASE_PUBLICATION_ENABLED: "TRUE" }],
  ["title case", { RELEASE_HOLD: "False", RELEASE_PUBLICATION_ENABLED: "True" }],
  ["mixed case", { RELEASE_HOLD: "fAlSe", RELEASE_PUBLICATION_ENABLED: "tRuE" }],
  ["hold uppercase only", { RELEASE_HOLD: "FALSE" }],
  ["publication uppercase only", { RELEASE_PUBLICATION_ENABLED: "TRUE" }],
  ["trailing hold space", { RELEASE_HOLD: "false " }],
  ["leading flag space", { RELEASE_PUBLICATION_ENABLED: " true" }],
  ["newline", { RELEASE_HOLD: "false\n" }],
  ["confusable hold", { RELEASE_HOLD: "fаlse" }],
  ["confusable flag", { RELEASE_PUBLICATION_ENABLED: "truе" }],
  ["numeric", { RELEASE_HOLD: "0", RELEASE_PUBLICATION_ENABLED: "1" }],
  ["output injection", { RELEASE_HOLD: "false\nauthorized=1" }],
  ["expression injection", { RELEASE_PUBLICATION_ENABLED: "${{ true }}" }],
  ["pull request", { event: "pull_request" }],
  ["manual dispatch", { event: "workflow_dispatch" }],
  ["workflow run", { event: "workflow_run" }],
  ["push uppercase", { event: "PUSH" }],
  ["other branch", { ref: "refs/heads/review" }],
  ["upper branch", { ref: "refs/heads/MAIN" }],
  ["title branch", { ref: "refs/heads/Main" }],
  ["tag", { ref: "refs/tags/main" }],
  ["pull merge", { ref: "refs/pull/105/merge" }],
  ["missing event", { event: "" }],
  ["missing ref", { ref: "" }],
];
for (const [label, changes] of denied)
  test(`all five publication surfaces reject ${label}`, () => {
    const input = { ...normal, ...changes },
      output = preflight(workflow, input);
    assert.deepEqual(output, { authorized: "0", staging_authorized: "0" });
    assert.deepEqual(surfaces(workflow, context(input, output)), [
      false,
      false,
      false,
      false,
      false,
    ]);
  });
test("exact lowercase authorized main push can reach all five surfaces", () => {
  const outputs = preflight(workflow, normal);
  assert.deepEqual(outputs, { authorized: "1", staging_authorized: "1" });
  assert.deepEqual(surfaces(workflow, context(normal, outputs)), [true, true, true, true, true]);
  const ctx = context(normal, outputs);
  ctx.matrix.service = "test-minio";
  assert.deepEqual(surfaces(workflow, ctx).slice(0, 2), [false, false]);
});
for (const flag of [undefined, "", "false", "TRUE", "True", "true ", "truе"])
  test(`staging requires exact enable value: ${JSON.stringify(flag)}`, () => {
    const input = { ...normal, STAGING_CD_ENABLED: flag },
      outputs = preflight(workflow, input);
    assert.deepEqual(outputs, { authorized: "1", staging_authorized: "0" });
    assert.deepEqual(surfaces(workflow, context(input, outputs)), [true, true, true, true, false]);
  });
for (const result of ["failure", "skipped", "cancelled"])
  test(`preflight ${result} cannot authorize publication or skip scans`, () => {
    const ctx = context(normal, {}, result);
    assert.deepEqual(surfaces(workflow, ctx), [false, false, false, false, false]);
    assert.equal(jobRuns(workflow, "dependencies", ctx), true);
    assert.equal(jobRuns(workflow, "images", ctx), true);
  });
for (const result of ["failure", "skipped", "cancelled"])
  test(`partial positive output from ${result} preflight cannot authorize publication`, () => {
    const ctx = context(normal, { authorized: "1", staging_authorized: "1" }, result);
    assert.deepEqual(surfaces(workflow, ctx), [false, false, false, false, false]);
  });
for (let i = 0; i < 2; i++)
  test(`removing auth-result fence from image surface ${i + 1} is detected`, () => {
    const w = clone(workflow),
      step = w.jobs.images.steps.find((s) => s.name === stepNames[i]);
    step.if = step.if.replace("needs.release-authorization.result == 'success' && ", "");
    assert.throws(() => validateContract(w));
    const ctx = context(normal, { authorized: "1", staging_authorized: "1" }, "failure");
    assert.equal(surfaces(w, ctx)[i], true);
    assert.equal(surfaces(workflow, ctx)[i], false);
  });
for (const output of [
  {},
  { authorized: "" },
  { authorized: "true" },
  { authorized: "01" },
  { authorized: "1 " },
])
  test(`invalid/missing output fails closed ${JSON.stringify(output)}`, () => {
    assert.deepEqual(surfaces(workflow, context(normal, output)), [
      false,
      false,
      false,
      false,
      false,
    ]);
  });
test("runner/output-file failure produces no usable authorization", () => {
  assert.deepEqual(preflight(workflow, normal, { noOutput: true }), {});
});
for (const job of ["dependencies", "images", "supply-chain-security"])
  test(`actual ${job} failure is not bypassed by authorization`, () => {
    const ctx = context(normal, { authorized: "1", staging_authorized: "1" });
    ctx.needs[job].result = "failure";
    assert.equal(jobRuns(workflow, "publish", ctx), false);
    ctx.success = false;
    assert.deepEqual(surfaces(workflow, ctx).slice(0, 2), [false, false]);
  });
for (let i = 0; i < 5; i++)
  test(`deletion of publication gate ${i + 1} is rejected`, () => {
    const w = clone(workflow),
      target =
        i < 2
          ? w.jobs.images.steps.find((s) => s.name === stepNames[i])
          : w.jobs[["publish", "release", "staging"][i - 2]];
    target.if = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
    assert.throws(() => validateContract(w));
    assert.equal(
      surfaces(w, context(normal, { authorized: "0", staging_authorized: "0" }))[i],
      true,
    );
  });
for (const condition of [
  "needs.release-authorization.outputs.authorised == '1'",
  "needs.release-authorization.outputs.authorized != '0'",
  "always()",
  "true",
])
  test(`weakened gate rejected: ${condition}`, () => {
    const w = clone(workflow);
    w.jobs.publish.if = condition;
    assert.throws(() => validateContract(w));
  });
test("preflight script mutation to case-insensitive input acceptance is detected behaviorally", () => {
  const w = clone(workflow);
  w.jobs[auth].steps[0].run = w.jobs[auth].steps[0].run.replace(
    'env.RELEASE_HOLD === "false"',
    'env.RELEASE_HOLD.toLowerCase() === "false"',
  );
  assert.notEqual(w.jobs[auth].steps[0].run, workflow.jobs[auth].steps[0].run);
  assert.equal(preflight(w, { ...normal, RELEASE_HOLD: "FALSE" }).authorized, "1");
  assert.equal(preflight(workflow, { ...normal, RELEASE_HOLD: "FALSE" }).authorized, "0");
});
test("all 11 image scans, required aggregate, six ASR shards and Walking remain live", () => {
  assert.equal(workflow.jobs.images.strategy.matrix.include.length, 11);
  assert.ok(workflow.jobs.images.steps.some((s) => s.run?.includes("supply-chain-scan-image.sh")));
  assert.ok(
    workflow.jobs["supply-chain-security"].steps.some((s) =>
      s.run?.includes("supply-chain-security-gate.sh"),
    ),
  );
  assert.match(workflow.jobs["supply-chain-security"].if, /always\(\)/);
  for (const state of [{ event: "pull_request", ref: "refs/pull/105/merge" }, normal]) {
    const ctx = context(state, { authorized: "0" });
    assert.equal(jobRuns(workflow, "images", ctx), true);
    assert.equal(jobRuns(workflow, "supply-chain-security", ctx), true);
  }
  for (const p of ["ci.yml", "e2e.yml"])
    assert.equal(read(`.github/workflows/${p}`).includes("release-authorization"), false);
  const ci = load(read(".github/workflows/ci.yml"));
  assert.equal(ci.jobs["real-asr"].strategy.matrix.shard.length, 6);
  assert.match(read(".github/workflows/e2e.yml"), /walking-skeleton/);
});
function publishers(workflows) {
  for (const [name, w] of workflows)
    for (const [id, j] of Object.entries(w.jobs)) {
      const release =
        j.permissions?.packages === "write" ||
        j.steps?.some((s) =>
          /docker\s+push|publish-release-image\.sh|staging-ssh\.sh|release_manifest\.py assemble/.test(
            s.run ?? "",
          ),
        );
      if (release)
        assert.ok(
          name === "supply-chain.yml" && ["publish", "release", "staging"].includes(id),
          `unguarded publication surface ${name}:${id}`,
        );
    }
}
test("all current publication-capable workflows are within the guarded surfaces", () => {
  const workflows = readdirSync(path.join(root, ".github/workflows"))
    .filter((n) => /\.ya?ml$/.test(n))
    .map((n) => [n, load(read(`.github/workflows/${n}`))]);
  publishers(workflows);
  assert.throws(() =>
    publishers([
      ...workflows,
      ["injected.yml", { jobs: { ship: { permissions: { packages: "write" }, steps: [] } } }],
    ]),
  );
});
test("security scan definitions and staging review/SSH protections retain frozen bytes", () => {
  // Canonical parsed objects: line wrapping is not a security change.
  const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  assert.equal(
    digest(workflow.jobs.dependencies),
    "b9b5d4cb77fd5631e9e7d6b58bdb282cd5e33036dce0f5fcd33d4c4f2ac4f49d",
  );
  assert.equal(
    digest(workflow.jobs["supply-chain-security"]),
    "0d0cda8bc5bffbbc4c6925e440b323a8f3151c13d6c7b4f569d7d69b8335f189",
  );
  assert.equal(
    digest(workflow.jobs.staging.steps),
    "4cbf0a76b5cd756cdc4f684e63476579c53dcfacf0583dbd91cc016f40d21a1e",
  );
  assert.equal(workflow.jobs.staging.environment, "staging");
  assert.deepEqual(workflow.jobs.staging.concurrency, {
    group: "staging-deployment",
    "cancel-in-progress": false,
  });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "read", packages: "write" });
});
