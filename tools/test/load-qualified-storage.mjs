/** Admission of a completed, reviewed Supply run. No candidate code executes here. */
import { isDeepStrictEqual } from "node:util";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers";
import { readFile, writeFile, mkdir, mkdtemp, stat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const REPOSITORY = "mahmoudemad68/Your_Editor";
export const REPOSITORY_ID = 1395822921;
export const BASE = "5cdb1d794d347a36d869027947bb62504dddff92";
// 2026-03-10 deliberately removed merge_commit_sha. Pin the still-supported
// PR contract rather than substituting a moving ref for immutable event M.
export const PR_IDENTITY_API = Object.freeze({
  version: "2022-11-28",
  path: "pulls/100?identity_api=2022-11-28",
});
export function validateIdentityApiVersion(selected) {
  requireThat(selected === PR_IDENTITY_API.version, "PR_API_VERSION_DRIFT");
}

export const WORKFLOWS = Object.freeze({
  CI: { id: 370458734, path: ".github/workflows/ci.yml" },
  "Walking skeleton E2E": { id: 377653530, path: ".github/workflows/e2e.yml" },
  "Supply chain": { id: 374068707, path: ".github/workflows/supply-chain.yml" },
});
export const SERVICES = Object.freeze([
  "api",
  "web",
  "media-worker",
  "render-worker",
  "render-executor",
  "agent-worker",
  "ai-worker",
  "seaweedfs",
  "postgres",
  "redis",
  "test-minio",
]);
export const POLICY_FILES = Object.freeze([
  ...Object.values(WORKFLOWS).map((v) => v.path),
  "infra/seaweedfs/Dockerfile",
  "infra/seaweedfs/security-build.lock.json",
  "infra/seaweedfs/build-weed.sh",
  "infra/seaweedfs/verify-image.sh",
  "infra/seaweedfs/image-reference.sh",
  "infra/seaweedfs/start-storage.sh",
  "tools/test/load-qualified-storage.mjs",
  "infra/scripts/install-supply-chain-tools.sh",
  "infra/scripts/supply-chain-scan-image.sh",
  "infra/scripts/supply-chain-security-gate.sh",
  "infra/scripts/supply-chain-findings.py",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".dockerignore",
  "infra/seaweedfs/prepare-secrets.sh",
  "infra/seaweedfs/backup-volumes.sh",
  "infra/seaweedfs/restore-volumes.sh",
  "tests/architecture/seaweedfs-object-storage.test.mjs",
  "tests/architecture/seaweedfs-security-build.test.mjs",
  "tests/integration/seaweedfs-security-recovery.mjs",
  "tests/integration/support/containers.mjs",
  "tests/integration/support/seaweedfs-storage.mjs",
  "tools/render/integration.mjs",
  "tools/render/graduation-demo.mjs",
  "docs/operations/ci-security-remediation-99.md",
  "docs/operations/seaweedfs-object-storage.md",
]);
const IMAGE_CAP = 120 * 1024 * 1024;
const REPORT_CAP = 16 * 1024 * 1024;
const FILES = [
  "image.tar.xz",
  "candidate-manifest.json",
  "verification.json",
  "go-version-m.txt",
  "full-trivy.json",
  "sbom.spdx.json",
  "scanner-versions.json",
];
const BASELINE_POLICY = Object.freeze({
  "infra/scripts/install-supply-chain-tools.sh":
    "24038c26bf7bf75ae760a300f42ad40649e172c6d33c1a7d5416731448d71f57",
  "infra/scripts/supply-chain-scan-image.sh":
    "169a3e4ca8c3617e57976584ef346e7e91c24e33114b5ed4e5b1d30cdede8ea8",
  "infra/scripts/supply-chain-security-gate.sh":
    "16c132a4c0464f06aef599b0f5f7c96413d817064afa536f1b77bc2bb1d8db7f",
  "infra/scripts/supply-chain-findings.py":
    "ef234bfca3ed19c81efab1bf9c1f4050cd2d0d4d20f472191123da135a1f953c",
  ".gitleaks.toml": "987accd5b8dcde52d4ff7f2a3f123b5045ff2d455c23138579e1256ba3b505a3",
  ".gitleaksignore": "3eddba83701c1d63d7d7cab7b45eda5b9b8280e15a89904a269e391228265a7f",
  ".dockerignore": "9e07120b810b89c44ba2a67b0717a7e551eceb976b34157350a0ecc3e182ea43",
});
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export class AdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = "AdmissionError";
    this.code = code;
  }
}
function requireThat(condition, code = "INTEGRITY_REJECTED") {
  if (!condition) throw new AdmissionError(code);
}
function id(value) {
  const number = Number(value);
  requireThat(Number.isSafeInteger(number) && number > 0, "INVALID_IDENTITY");
  return number;
}
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}
async function jsonFile(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function dispose(directory) {
  const base = await realpath(path.join(ROOT, ".local/issue99"));
  const target = await realpath(directory);
  requireThat(
    base === path.resolve(ROOT, ".local/issue99") && target.startsWith(base + path.sep),
    "UNSAFE_CLEANUP_PATH",
  );
  requireThat(
    /^(producer|admission|recheck|promoted)-/.test(path.relative(base, target).split(path.sep)[0]),
    "UNSAFE_CLEANUP_PATH",
  );
  await rm(target, { recursive: true, force: true });
}
function validateStableIdentity(context, pr, headCommit, mergeCommit, nativeRun, env) {
  const { H, B, M, TH, TM } = context;
  for (const v of [H, B, M, TH, TM]) requireThat(/^[0-9a-f]{40}$/.test(v), "INVALID_IDENTITY");
  requireThat(B === BASE && TH === TM, "TREE_OR_BASE_DRIFT");
  requireThat(
    pr.number === 100 && pr.state === "open" && pr.draft === true && !pr.merged,
    "PR_STATE_DRIFT",
  );
  requireThat(
    pr.head?.repo?.id === REPOSITORY_ID && pr.base?.repo?.id === REPOSITORY_ID,
    "REPOSITORY_DRIFT",
  );
  requireThat(pr.head.sha === H && pr.base.sha === B, "HEAD_BASE_MERGE_DRIFT");
  requireThat(
    headCommit.sha === H &&
      headCommit.tree.sha === TH &&
      mergeCommit.sha === M &&
      mergeCommit.tree.sha === TM,
    "TREE_OR_BASE_DRIFT",
  );
  requireThat(
    JSON.stringify(mergeCommit.parents.map((p) => p.sha)) === JSON.stringify([B, H]),
    "MERGE_PARENT_DRIFT",
  );
  const expected = WORKFLOWS[env.GITHUB_WORKFLOW];
  requireThat(
    expected && nativeRun.workflow_id === expected.id && nativeRun.path === expected.path,
    "WORKFLOW_DRIFT",
  );
  requireThat(
    nativeRun.id === id(env.GITHUB_RUN_ID) && nativeRun.run_attempt === id(env.GITHUB_RUN_ATTEMPT),
    "ATTEMPT_DRIFT",
  );
  requireThat(
    nativeRun.event === "pull_request" &&
      nativeRun.head_sha === H &&
      nativeRun.repository.id === REPOSITORY_ID &&
      nativeRun.head_repository.id === REPOSITORY_ID,
    "RUN_IDENTITY_DRIFT",
  );
  requireThat(
    nativeRun.pull_requests.some((p) => p.number === 100 && p.head.sha === H && p.base.sha === B),
    "PR_ASSOCIATION_MISSING",
  );
  requireThat(env.GITHUB_SHA === M && env.GITHUB_REF === "refs/pull/100/merge", "EVENT_REF_DRIFT");
}
export function validateIdentity(context, pr, headCommit, mergeCommit, nativeRun, env) {
  validateStableIdentity(context, pr, headCommit, mergeCommit, nativeRun, env);
  requireThat(pr.merge_commit_sha === context.M, "HEAD_BASE_MERGE_DRIFT");
}
const safeSha = (v) => (typeof v === "string" && /^[a-f0-9]{40}$/.test(v) ? v : null);
const safeId = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const safeDate = (v) =>
  typeof v === "string" && v.length <= 128 && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
const safeText = (v) => (typeof v === "string" && /^[A-Za-z0-9_.:/ -]{1,128}$/.test(v) ? v : null);
let lastIdentityEvidence;
let identityObservations = [];
export function identityEvidence(input, pr, observation, correlation, outcome) {
  const { context: c, headCommit: h, mergeCommit: m, checkout, nativeRun: n, env, suite } = input;
  const association = (p) => ({
    number: safeId(p.number),
    H: safeSha(p.head?.sha),
    B: safeSha(p.base?.sha),
  });
  return {
    version: 1,
    observed_at: new Date().toISOString(),
    observation,
    outcome,
    event: {
      H: safeSha(c.H),
      B: safeSha(c.B),
      M: safeSha(c.M),
      TH: safeSha(c.TH),
      TM: safeSha(c.TM),
      workflow: Object.hasOwn(WORKFLOWS, env.GITHUB_WORKFLOW) ? env.GITHUB_WORKFLOW : "UNEXPECTED",
      run_id: safeId(Number(env.GITHUB_RUN_ID)),
      attempt: safeId(Number(env.GITHUB_RUN_ATTEMPT)),
      ref_matches: env.GITHUB_REF === "refs/pull/100/merge",
    },
    checkout: {
      commit: safeSha(checkout?.sha),
      tree: safeSha(checkout?.tree?.sha),
      parents: checkout?.parents?.map((p) => safeSha(p.sha)),
    },
    git: {
      H: safeSha(h.sha),
      TH: safeSha(h.tree?.sha),
      M: safeSha(m.sha),
      TM: safeSha(m.tree?.sha),
      merge_parents: m.parents?.map((p) => safeSha(p.sha)),
    },
    live_pr: {
      number: safeId(pr.number),
      H: safeSha(pr.head?.sha),
      B: safeSha(pr.base?.sha),
      M: safeSha(pr.merge_commit_sha),
      M_present: Object.hasOwn(pr, "merge_commit_sha"),
      M_type: typeof pr.merge_commit_sha,
      head_repo: safeId(pr.head?.repo?.id),
      base_repo: safeId(pr.base?.repo?.id),
      state: ["open", "closed"].includes(pr.state) ? pr.state : null,
      draft: typeof pr.draft === "boolean" ? pr.draft : null,
      merged: typeof pr.merged === "boolean" ? pr.merged : null,
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeable_state: [
        "unknown",
        "clean",
        "dirty",
        "unstable",
        "blocked",
        "behind",
        "draft",
        "has_hooks",
      ].includes(pr.mergeable_state)
        ? pr.mergeable_state
        : null,
    },
    native: {
      run_id: safeId(n.id),
      attempt: safeId(n.run_attempt),
      workflow_id: safeId(n.workflow_id),
      path: Object.values(WORKFLOWS).some((w) => w.path === n.path) ? n.path : "UNEXPECTED",
      event: n.event === "pull_request" ? n.event : "UNEXPECTED",
      H: safeSha(n.head_sha),
      repository: safeId(n.repository?.id),
      head_repository: safeId(n.head_repository?.id),
      check_suite: safeId(n.check_suite_id),
      associations: (n.pull_requests ?? []).slice(0, 8).map(association),
      app: safeId(suite?.app?.id),
      suite_H: safeSha(suite?.head_sha),
      suite_associations: (suite?.pull_requests ?? []).slice(0, 8).map((p) => safeId(p.number)),
    },
    comparisons: {
      event_H_live_H: c.H === pr.head?.sha,
      event_B_live_B: c.B === pr.base?.sha,
      event_M_live_M: c.M === pr.merge_commit_sha,
      checkout_M: checkout?.sha === c.M,
      checkout_tree: checkout?.tree?.sha === c.TM,
      merge_parents: isDeepStrictEqual(
        m.parents?.map((p) => p.sha),
        [c.B, c.H],
      ),
      equal_trees: c.TH === c.TM,
      native_run: n.id === Number(env.GITHUB_RUN_ID),
      native_attempt: n.run_attempt === Number(env.GITHUB_RUN_ATTEMPT),
    },
    api: {
      request_started_at: safeText(correlation?.request_started_at),
      received_at: safeText(correlation?.received_at),
      status: safeId(correlation?.status),
      request_id:
        typeof correlation?.request_id === "string" &&
        /^[A-Fa-f0-9:]{1,128}$/.test(correlation.request_id)
          ? correlation.request_id
          : null,
      date: safeDate(correlation?.date),
      age:
        typeof correlation?.age === "string" && /^\d{1,8}$/.test(correlation.age)
          ? correlation.age
          : null,
      refresh: correlation?.refresh === true,
      api_version_requested: ["2022-11-28", "2026-03-10"].includes(
        correlation?.api_version_requested,
      )
        ? correlation.api_version_requested
        : null,
      api_version_selected: ["2022-11-28", "2026-03-10"].includes(correlation?.api_version_selected)
        ? correlation.api_version_selected
        : null,
    },
  };
}
// At most three 3-second PR reads and two 500ms delays, in this SAME
// admission attempt. Only a null merge SHA while GitHub computes mergeability
// may be refreshed. A concrete different SHA, H/B drift or any other failed
// guard is immediately terminal, never a producer-prerequisite classification.
export async function reconcileIdentity(input, readPr, pause, record) {
  for (let observation = 1; observation <= 3; observation++) {
    const { pr, correlation } = await readPr(observation);
    let outcome = "IDENTITY_CONFIRMED",
      failure;
    try {
      validateStableIdentity(
        input.context,
        pr,
        input.headCommit,
        input.mergeCommit,
        input.nativeRun,
        input.env,
      );
      requireThat(
        input.checkout.sha === input.context.M &&
          input.checkout.tree.sha === input.context.TM &&
          isDeepStrictEqual(
            input.checkout.parents.map((p) => p.sha),
            [input.context.B, input.context.H],
          ),
        "CHECKOUT_COMMIT_DRIFT",
      );
      requireThat(
        input.suite.app?.id === 15368 &&
          input.suite.head_sha === input.context.H &&
          input.suite.pull_requests?.some((p) => p.number === 100),
        "NATIVE_CHECK_SOURCE_DRIFT",
      );
      if (pr.merge_commit_sha !== input.context.M) {
        const incomplete =
          pr.merge_commit_sha === null && pr.mergeable === null && pr.mergeable_state === "unknown";
        if (incomplete && observation < 3) outcome = "PR_MERGE_METADATA_INCOMPLETE_REFRESH";
        else
          throw new AdmissionError(
            incomplete ? "PR_MERGE_METADATA_UNRESOLVED" : "HEAD_BASE_MERGE_DRIFT",
          );
      }
      if (outcome === "IDENTITY_CONFIRMED")
        validateIdentity(
          input.context,
          pr,
          input.headCommit,
          input.mergeCommit,
          input.nativeRun,
          input.env,
        );
    } catch (error) {
      outcome = error instanceof AdmissionError ? error.code : "ADMISSION_INTERNAL_ERROR";
      failure = error;
    }
    await record(identityEvidence(input, pr, observation, correlation, outcome));
    if (failure) throw failure;
    if (outcome === "IDENTITY_CONFIRMED") return;
    await pause(500);
  }
  throw new AdmissionError("PR_MERGE_METADATA_UNRESOLVED");
}
export function validateProducer(source, jobs, context) {
  requireThat(
    source.repository.id === REPOSITORY_ID && source.head_repository.id === REPOSITORY_ID,
    "PRODUCER_REPOSITORY_DRIFT",
  );
  requireThat(
    source.event === "pull_request" &&
      source.workflow_id === 374068707 &&
      source.path === WORKFLOWS["Supply chain"].path &&
      source.head_sha === context.H,
    "PRODUCER_WORKFLOW_DRIFT",
  );
  requireThat(
    source.pull_requests.some(
      (p) => p.number === 100 && p.head.sha === context.H && p.base.sha === context.B,
    ),
    "PRODUCER_PR_DRIFT",
  );
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(source.status))
    throw new AdmissionError("PRODUCER_NOT_YET_COMPLETE");
  requireThat(source.status === "completed", "PRODUCER_STATE_INVALID");
  requireThat(source.conclusion === "success", "PRODUCER_FAILED");
  for (const name of [
    "dependencies",
    "supply-chain-security",
    ...SERVICES.map((s) => `image ${s}`),
  ]) {
    const found = jobs.filter((j) => j.name === name);
    requireThat(
      found.length === 1 &&
        found[0].status === "completed" &&
        found[0].conclusion === "success" &&
        found[0].run_attempt === source.run_attempt,
      "PRODUCER_REQUIRED_JOB_FAILED",
    );
  }
  const candidate = jobs.find((j) => j.name === "image seaweedfs");
  for (const name of [
    "Fixed module reproducibility and zero HIGH gate",
    "Bounded RSA JWK and Brotli controls",
    "Upload qualified candidate",
    "Seal qualified candidate upload",
    "Upload candidate seal",
  ]) {
    const step = candidate.steps.filter((s) => s.name === name);
    requireThat(
      step.length === 1 && step[0].status === "completed" && step[0].conclusion === "success",
      "CANDIDATE_GATE_FAILED",
    );
  }
}
export function validateArtifact(artifact, source, expectedId, cap, step) {
  requireThat(
    artifact.id === id(expectedId) &&
      artifact.workflow_run?.id === source.id &&
      artifact.workflow_run?.head_sha === source.head_sha &&
      artifact.workflow_run?.head_repository_id === REPOSITORY_ID,
    "ARTIFACT_IDENTITY_DRIFT",
  );
  requireThat(
    !artifact.expired && Date.parse(artifact.expires_at) > Date.now(),
    "ARTIFACT_EXPIRED",
  );
  requireThat(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= cap,
    "ARTIFACT_SIZE_REJECTED",
  );
  requireThat(/^sha256:[a-f0-9]{64}$/.test(artifact.digest), "ARTIFACT_DIGEST_MISSING");
  const created = Date.parse(artifact.created_at);
  requireThat(
    created >= Date.parse(step.started_at) && created <= Date.parse(step.completed_at) + 1000,
    "ARTIFACT_ATTEMPT_DRIFT",
  );
  requireThat(
    Date.parse(artifact.expires_at) - created <= 86400000 + 60000,
    "ARTIFACT_RETENTION_REJECTED",
  );
}
export function validateScans(report, sbom) {
  requireThat(
    report.SchemaVersion >= 2 && Array.isArray(report.Results) && report.Results.length > 0,
    "SCAN_EVIDENCE_MISSING",
  );
  requireThat(
    report.Results.every((r) =>
      (r.Vulnerabilities ?? []).every((v) => !["HIGH", "CRITICAL"].includes(v.Severity)),
    ),
    "HIGH_OR_CRITICAL_FOUND",
  );
  requireThat(
    sbom.spdxVersion?.startsWith("SPDX-") &&
      Array.isArray(sbom.packages) &&
      sbom.packages.length > 0,
    "SBOM_MISSING",
  );
}
export function validateCheck(check, context, suiteId, name, completed = true) {
  requireThat(
    check.app?.id === 15368 &&
      check.head_sha === context.H &&
      check.check_suite?.id === suiteId &&
      check.name === name,
    "CHECK_SOURCE_DRIFT",
  );
  requireThat(
    check.pull_requests?.some((p) => p.number === 100),
    "CHECK_PR_ASSOCIATION_MISSING",
  );
  if (completed)
    requireThat(
      check.status === "completed" && check.conclusion === "success",
      "REQUIRED_CHECK_NOT_SUCCESS",
    );
}

async function request(
  url,
  {
    publicOnly = false,
    bytes = false,
    cap = 4 * 1024 * 1024,
    correlate,
    refresh = false,
    timeout = 30000,
    apiVersion = "2026-03-10",
  } = {},
) {
  requireThat(
    url.startsWith("https://api.github.com/repos/mahmoudemad68/Your_Editor/"),
    "API_ORIGIN_REJECTED",
  );
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": apiVersion };
  if (refresh) headers["Cache-Control"] = "no-cache";
  const started = new Date().toISOString();
  const actionMetadata = url.includes("/actions/");
  if (process.env.GITHUB_TOKEN && (!publicOnly || actionMetadata)) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  } else requireThat(publicOnly, "ACTIONS_READ_TOKEN_MISSING");
  let response = await globalThis.fetch(url, {
    headers,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(timeout),
  });
  if (correlate)
    correlate({
      request_started_at: started,
      received_at: new Date().toISOString(),
      status: response.status,
      request_id: response.headers.get("x-github-request-id"),
      date: response.headers.get("date"),
      age: response.headers.get("age"),
      refresh,
      api_version_requested: apiVersion,
      api_version_selected: response.headers.get("x-github-api-version-selected"),
    });
  if (correlate) validateIdentityApiVersion(response.headers.get("x-github-api-version-selected"));
  if (bytes && response.status === 302) {
    const next = new URL(response.headers.get("location"));
    requireThat(
      next.protocol === "https:" &&
        /(?:\.blob\.core\.windows\.net|\.actions\.githubusercontent\.com|\.actions\.github\.com|\.githubusercontent\.com)$/.test(
          next.hostname,
        ),
      "ARTIFACT_REDIRECT_REJECTED",
    );
    response = await globalThis.fetch(next, {
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(120000),
    });
  }
  requireThat(response.ok, "GITHUB_EVIDENCE_UNAVAILABLE");
  requireThat(Number(response.headers.get("content-length") ?? 0) <= cap, "HTTP_SIZE_REJECTED");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireThat(size <= cap, "HTTP_SIZE_REJECTED");
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks);
  return bytes ? result : JSON.parse(result.toString("utf8"));
}
const api = (suffix, options) =>
  request(`https://api.github.com/repos/${REPOSITORY}/${suffix}`, options);
export async function readIdentityPr(correlate) {
  return api(PR_IDENTITY_API.path, {
    publicOnly: true,
    apiVersion: PR_IDENTITY_API.version,
    refresh: true,
    timeout: 3000,
    correlate,
  });
}
async function pages(suffix, field, publicOnly = false) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await api(
      `${suffix}${suffix.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      { publicOnly },
    );
    const batch = field ? data[field] : data;
    requireThat(Array.isArray(batch), "INVALID_API_PAGE");
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  throw new AdmissionError("API_PAGE_LIMIT");
}
export function parseCommitMetadata(text) {
  // A fetched depth-2 merge has its H/B parents as shallow boundaries. H's
  // own parents may therefore be absent; M must still expose exactly [B,H].
  const [sha, tree, parents = ""] = text.trim().split("\n");
  return {
    sha,
    tree: { sha: tree },
    parents: parents ? parents.split(" ").map((sha) => ({ sha })) : [],
  };
}
async function identity(env = process.env) {
  requireThat(
    env.GITHUB_ACTIONS === "true" && env.GITHUB_EVENT_NAME === "pull_request",
    "PR_EVENT_REQUIRED",
  );
  const event = await jsonFile(env.GITHUB_EVENT_PATH);
  const H = event.pull_request.head.sha,
    B = event.pull_request.base.sha,
    M = env.GITHUB_SHA;
  const commit = (ref) =>
    parseCommitMetadata(
      run("git", ["--no-replace-objects", "show", "-s", "--format=%H%n%T%n%P", ref]),
    );
  const head = commit(H),
    merge = commit(M),
    checkout = commit("HEAD");
  const context = { H, B, M, TH: head.tree.sha, TM: merge.tree.sha };
  const input = {
    context,
    headCommit: head,
    mergeCommit: merge,
    checkout,
    nativeRun: {},
    env,
    suite: {},
  };
  lastIdentityEvidence = undefined;
  identityObservations = [];
  const record = async (evidence) => {
    lastIdentityEvidence = evidence;
    identityObservations.push(evidence);
    console.log("IDENTITY_EVIDENCE " + JSON.stringify(evidence));
    await writeFile(
      path.join(ROOT, ".local/issue99/identity-evidence.jsonl"),
      JSON.stringify(evidence) + "\n",
      { flag: "a", mode: 0o600 },
    );
  };
  try {
    input.nativeRun = await api(`actions/runs/${id(env.GITHUB_RUN_ID)}`, { publicOnly: true });
    input.suite = await api(`check-suites/${id(input.nativeRun.check_suite_id)}`, {
      publicOnly: true,
    });
    await reconcileIdentity(
      input,
      async (observation) => {
        let correlation;
        try {
          const pr = await readIdentityPr((value) => {
            correlation = value;
          });
          return { pr, correlation };
        } catch (error) {
          const outcome = error instanceof AdmissionError ? error.code : "PR_METADATA_READ_FAILED";
          await record(identityEvidence(input, {}, observation, correlation, outcome));
          throw new AdmissionError(outcome);
        }
      },
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      record,
    );
  } catch (error) {
    if (!lastIdentityEvidence)
      await record(
        identityEvidence(
          input,
          {},
          0,
          {},
          error instanceof AdmissionError ? error.code : "NATIVE_METADATA_READ_FAILED",
        ),
      );
    throw error;
  }
  return { context, nativeRun: input.nativeRun };
}

export function reviewedBinding(comments, context) {
  const approved = [];
  for (const c of comments) {
    if (c.user?.login !== "mahmoudemad68" || c.author_association !== "OWNER") continue;
    const match = /```seaweedfs-policy-v1\s*\n([\s\S]*?)\n```/.exec(c.body);
    if (!match) continue;
    let binding;
    try {
      binding = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (binding.decision === "APPROVED" && binding.H === context.H && binding.B === context.B)
      approved.push({ ...binding, comment_id: c.id });
  }
  requireThat(approved.length === 1, "REVIEWED_POLICY_BINDING_MISSING_OR_AMBIGUOUS");
  const binding = approved[0];
  requireThat(
    binding.repository_id === REPOSITORY_ID &&
      binding.pr === 100 &&
      binding.TH === context.TH &&
      binding.files &&
      typeof binding.files === "object",
    "POLICY_IDENTITY_DRIFT",
  );
  requireThat(
    JSON.stringify(Object.keys(binding.files).sort()) === JSON.stringify([...POLICY_FILES].sort()),
    "POLICY_FILE_SET_DRIFT",
  );
  return binding;
}
async function policy(context) {
  const comments = await pages("issues/100/comments", null, true);
  const binding = reviewedBinding(comments, context);
  // Local Git blobs are content-addressed by the original M; its entire tree
  // equals H and is checked through GitHub above. Do not trust working files or
  // spend dozens of unauthenticated API requests on each repeated inspection.
  requireThat(run("git", ["rev-parse", "HEAD"]).trim() === context.M, "CHECKOUT_COMMIT_DRIFT");
  for (const name of POLICY_FILES) {
    const hash = sha256(run("git", ["show", `${context.M}:${name}`], { encoding: "buffer" }));
    requireThat(
      hash === binding.files[name] && sha256(await readFile(path.join(ROOT, name))) === hash,
      "POLICY_HASH_DRIFT",
    );
  }
  const lock = await jsonFile(path.join(ROOT, "infra/seaweedfs/security-build.lock.json"));
  requireThat(isDeepStrictEqual(lock.trusted_baseline, BASELINE_POLICY), "BASELINE_POLICY_DRIFT");
  for (const [name, hash] of Object.entries(lock.trusted_baseline)) {
    requireThat(binding.files[name] === hash, "SCANNER_POLICY_DRIFT");
  }
  return binding;
}
async function unpackZip(artifact, destination, allowed, cap) {
  const data = await api(`actions/artifacts/${id(artifact.id)}/zip`, { bytes: true, cap });
  return unpackVerifiedZip(data, artifact.digest, destination, allowed, cap);
}
export async function unpackVerifiedZip(
  data,
  expectedDigest,
  destination,
  allowed,
  cap,
  python = "python3",
) {
  requireThat(data.length <= cap, "ARTIFACT_SIZE_REJECTED");
  requireThat(`sha256:${sha256(data)}` === expectedDigest, "GITHUB_ARCHIVE_DIGEST_MISMATCH");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const zip = path.join(destination, "download.zip");
  await writeFile(zip, data, { flag: "wx", mode: 0o600 });
  run(python, [
    "-c",
    `
import zipfile,sys,json,stat,os
from pathlib import Path
p=Path(sys.argv[1]); allowed=set(json.loads(sys.argv[2])); cap=int(sys.argv[3])
with zipfile.ZipFile(p/'download.zip') as z:
 entries=z.infolist(); names=[e.filename for e in entries]
 if len(names)!=len(set(names)) or set(names)!=allowed: raise ValueError('unexpected/duplicate artifact paths')
 if sum(e.file_size for e in entries)>cap: raise ValueError('artifact expansion limit')
 for e in entries:
  mode=e.external_attr>>16
  if '/' in e.filename or '\\\\' in e.filename or e.filename in ('.','..') or stat.S_IFMT(mode) not in (0,stat.S_IFREG) or e.flag_bits&1 or e.compress_type not in (0,8): raise ValueError('unsafe artifact member')
  with z.open(e) as src,open(p/e.filename,'xb') as dst:
   count=0
   while b:=src.read(1048576):
    count+=len(b)
    if count>e.file_size: raise ValueError('artifact expansion mismatch')
    dst.write(b)
   if count!=e.file_size: raise ValueError('artifact truncated')
`,
    destination,
    JSON.stringify(allowed),
    String(cap),
  ]);
  await rm(zip);
}
async function selectProducer(context) {
  const candidates = (
    await pages(
      `actions/workflows/374068707/runs?event=pull_request&head_sha=${context.H}`,
      "workflow_runs",
      true,
    )
  ).filter((s) =>
    s.pull_requests.some(
      (p) => p.number === 100 && p.head.sha === context.H && p.base.sha === context.B,
    ),
  );
  if (!candidates.length) throw new AdmissionError("PRODUCER_NOT_YET_CREATED");
  requireThat(candidates.length === 1, "PRODUCER_AMBIGUOUS");
  const source = await api(`actions/runs/${id(candidates[0].id)}`, { publicOnly: true });
  if (source.status !== "completed" || source.conclusion !== "success")
    validateProducer(source, [], context);
  const jobs = await pages(
    `actions/runs/${source.id}/attempts/${id(source.run_attempt)}/jobs`,
    "jobs",
    true,
  );
  validateProducer(source, jobs, context);
  const aggregate = jobs.find((j) => j.name === "supply-chain-security");
  requireThat(
    /^https:\/\/api.github.com\/repos\/mahmoudemad68\/Your_Editor\/check-runs\/[0-9]+$/.test(
      aggregate.check_run_url,
    ),
    "CHECK_URL_REJECTED",
  );
  validateCheck(
    await request(aggregate.check_run_url, { publicOnly: true }),
    context,
    source.check_suite_id,
    "supply-chain-security",
  );
  return { source, jobs };
}
async function qualified(output) {
  const { context, nativeRun } = await identity();
  // These two and ONLY these outcomes are eligible for the single ordered re-run.
  const { source, jobs } = await selectProducer(context);
  const binding = await policy(context);
  const artifacts = await pages(`actions/runs/${source.id}/artifacts`, "artifacts");
  const sealMatches = artifacts.filter(
    (a) => a.name === `seaweedfs-seal-${source.id}-${source.run_attempt}`,
  );
  requireThat(sealMatches.length === 1, "SEAL_MISSING_OR_AMBIGUOUS");
  const candidateJob = jobs.find((j) => j.name === "image seaweedfs");
  const sealStep = candidateJob.steps.find((s) => s.name === "Upload candidate seal");
  const uploadStep = candidateJob.steps.find((s) => s.name === "Upload qualified candidate");
  validateArtifact(sealMatches[0], source, sealMatches[0].id, 65536, sealStep);
  await unpackZip(sealMatches[0], path.join(output, "seal"), ["seal.json"], 65536);
  const seal = await jsonFile(path.join(output, "seal/seal.json"));
  requireThat(
    seal.run_id === source.id && seal.attempt === source.run_attempt && seal.H === context.H,
    "SEAL_DRIFT",
  );
  const artifact = artifacts.find((a) => a.id === seal.artifact_id);
  requireThat(artifact, "ARTIFACT_MISSING");
  validateArtifact(artifact, source, seal.artifact_id, IMAGE_CAP + REPORT_CAP, uploadStep);
  requireThat(artifact.digest === seal.artifact_digest, "SEAL_DIGEST_DRIFT");
  const receipt = {
    version: 1,
    context,
    native_run_id: nativeRun.id,
    native_attempt: nativeRun.run_attempt,
    producer_run: source.id,
    producer_created_at: source.created_at,
    producer_attempt: source.run_attempt,
    artifact_id: artifact.id,
    artifact_digest: artifact.digest,
    policy_comment_id: binding.comment_id,
    policy_files: binding.files,
    seal,
  };
  return { receipt, artifact, source };
}
async function materialize(artifact, output, receipt) {
  const bundle = path.join(output, "bundle");
  await unpackZip(artifact, bundle, FILES, IMAGE_CAP + REPORT_CAP);
  const manifest = await jsonFile(path.join(bundle, "candidate-manifest.json"));
  requireThat(
    sha256(await readFile(path.join(bundle, "candidate-manifest.json"))) ===
      receipt.seal.manifest_sha256,
    "MANIFEST_DIGEST_DRIFT",
  );
  requireThat(isDeepStrictEqual(manifest.context, receipt.context), "MANIFEST_SOURCE_DRIFT");
  requireThat(
    manifest.run_id === receipt.producer_run && manifest.attempt === receipt.producer_attempt,
    "MANIFEST_ATTEMPT_DRIFT",
  );
  for (const name of FILES.filter((f) => f !== "candidate-manifest.json")) {
    requireThat(
      sha256(await readFile(path.join(bundle, name))) === manifest.files[name],
      "INNER_ARTIFACT_DIGEST_MISMATCH",
    );
  }
  requireThat(
    isDeepStrictEqual(manifest.policy_files, receipt.policy_files),
    "MANIFEST_POLICY_DRIFT",
  );
  validateScans(
    await jsonFile(path.join(bundle, "full-trivy.json")),
    await jsonFile(path.join(bundle, "sbom.spdx.json")),
  );
  const scanner = await jsonFile(path.join(bundle, "scanner-versions.json"));
  requireThat(
    scanner.trivy?.Version === "0.75.0" &&
      scanner.syft?.version === "1.54.0" &&
      Date.parse(scanner.trivy.VulnerabilityDB?.DownloadedAt) >=
        Date.parse(receipt.producer_created_at),
    "SCANNER_PROVENANCE_DRIFT",
  );
  requireThat(
    (await jsonFile(path.join(bundle, "full-trivy.json"))).Metadata?.ImageID === manifest.image_id,
    "SCAN_IMAGE_IDENTITY_DRIFT",
  );
  const C = (await stat(path.join(bundle, "image.tar.xz"))).size;
  let R = 0;
  for (const name of FILES.filter((f) => f !== "image.tar.xz"))
    R += (await stat(path.join(bundle, name))).size;
  requireThat(
    C <= IMAGE_CAP && R * 2 + 65536 <= REPORT_CAP && 2 * C + 2 * R + 65536 <= 256 * 1024 * 1024,
    "TRANSFER_BUDGET_EXCEEDED",
  );
  await decompress(path.join(bundle, "image.tar.xz"), path.join(output, "image.tar"));
  run(
    "sh",
    [
      "infra/seaweedfs/verify-image.sh",
      path.join(output, "image.tar"),
      path.join(output, "inspection"),
    ],
    { stdio: "inherit" },
  );
  const verification = await jsonFile(path.join(output, "inspection/verify-image.json"));
  requireThat(
    verification.image_id === manifest.image_id && verification.elf_sha256 === manifest.elf_sha256,
    "IMAGE_OR_ELF_DRIFT",
  );
  await dispose(path.join(output, "inspection"));
  return {
    ...receipt,
    image_id: manifest.image_id,
    elf_sha256: manifest.elf_sha256,
    inner_sha256: manifest.files["image.tar.xz"],
    bundle,
    archive: path.join(output, "image.tar"),
    C,
    R,
  };
}
export async function decompress(source, target, python = "python3", maxBytes = 4 * 1024 ** 3) {
  requireThat(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 4 * 1024 ** 3,
    "IMAGE_EXPANSION_LIMIT_INVALID",
  );
  run(python, [
    "-c",
    `
import lzma,sys
d=lzma.LZMADecompressor(memlimit=256*1024**2); total=0
with open(sys.argv[1],'rb') as src,open(sys.argv[2],'xb') as dst:
 while b:=src.read(1048576):
  v=d.decompress(b,max_length=1048576)
  while True:
   total+=len(v)
   if total>int(sys.argv[3]): raise ValueError('image expansion limit')
   dst.write(v)
   if d.eof or d.needs_input: break
   v=d.decompress(b'',max_length=1048576)
  if d.eof:
   if d.unused_data or src.read(1): raise ValueError('trailing compressed data')
   break
 if not d.eof: raise ValueError('truncated image')
`,
    source,
    target,
    String(maxBytes),
  ]);
}
async function fresh(receipt) {
  const { context } = await identity();
  requireThat(
    receipt.native_run_id === id(process.env.GITHUB_RUN_ID) &&
      receipt.native_attempt === id(process.env.GITHUB_RUN_ATTEMPT),
    "RECEIPT_ATTEMPT_DRIFT",
  );
  requireThat(isDeepStrictEqual(context, receipt.context), "LIVE_IDENTITY_DRIFT");
  const { source, jobs } = await selectProducer(context);
  requireThat(
    source.id === receipt.producer_run && source.run_attempt === receipt.producer_attempt,
    "PRODUCER_ATTEMPT_DRIFT",
  );
  const artifact = await api(`actions/artifacts/${id(receipt.artifact_id)}`, { publicOnly: true });
  validateArtifact(
    artifact,
    source,
    receipt.artifact_id,
    IMAGE_CAP + REPORT_CAP,
    jobs
      .find((j) => j.name === "image seaweedfs")
      .steps.find((s) => s.name === "Upload qualified candidate"),
  );
  requireThat(artifact.digest === receipt.artifact_digest, "ARTIFACT_DIGEST_DRIFT");
  const binding = await policy(context);
  requireThat(
    binding.comment_id === receipt.policy_comment_id &&
      isDeepStrictEqual(binding.files, receipt.policy_files),
    "POLICY_BINDING_DRIFT",
  );
}
async function output(name, value) {
  requireThat(process.env.GITHUB_OUTPUT, "JOB_OUTPUT_MISSING");
  await writeFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: "a" });
}
async function cli(mode, arg, extra) {
  await mkdir(path.join(ROOT, ".local/issue99"), { recursive: true, mode: 0o700 });
  if (mode === "policy-inventory") {
    const H = run("git", ["rev-parse", "HEAD"]).trim();
    const TH = run("git", ["rev-parse", "HEAD^{tree}"]).trim();
    const files = {};
    for (const name of POLICY_FILES)
      files[name] = sha256(run("git", ["show", `${H}:${name}`], { encoding: "buffer" }));
    console.log(
      JSON.stringify(
        {
          decision: "REVIEW_REQUIRED_NOT_APPROVED",
          repository_id: REPOSITORY_ID,
          pr: 100,
          H,
          B: BASE,
          TH,
          files,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (mode === "produce") return produce(arg, extra);
  if (mode === "seal") {
    const bundle = path.join(ROOT, ".local/seaweedfs-transfer/bundle");
    const m = await jsonFile(path.join(bundle, "candidate-manifest.json"));
    const destination = path.join(ROOT, ".local/seaweedfs-transfer/seal");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const digest = /^[a-f0-9]{64}$/.test(extra) ? `sha256:${extra}` : extra;
    requireThat(/^sha256:[a-f0-9]{64}$/.test(digest), "UPLOAD_DIGEST_MISSING");
    await writeFile(
      path.join(destination, "seal.json"),
      JSON.stringify({
        run_id: m.run_id,
        attempt: m.attempt,
        H: m.context.H,
        artifact_id: id(arg),
        artifact_digest: digest,
        manifest_sha256: sha256(await readFile(path.join(bundle, "candidate-manifest.json"))),
      }) + "\n",
    );
    return;
  }
  if (mode === "verify-local") {
    const receipt = await jsonFile(arg);
    await fresh(receipt);
    requireThat(
      run("docker", ["image", "inspect", extra, "--format", "{{.Id}}"]).trim() === receipt.image_id,
      "LOCAL_IMAGE_DRIFT",
    );
    const work = await mkdtemp(path.join(ROOT, ".local/issue99/recheck-"));
    try {
      run("sh", ["infra/seaweedfs/verify-image.sh", receipt.image_id, work], { stdio: "inherit" });
    } finally {
      await dispose(work);
    }
    return;
  }
  if (mode === "promoted") {
    const dir = path.resolve(arg);
    requireThat(
      sha256(await readFile(path.join(dir, "admission.json"))) === extra,
      "PROMOTED_RECEIPT_DRIFT",
    );
    const receipt = await jsonFile(path.join(dir, "admission.json"));
    requireThat(
      receipt.native_run_id === id(process.env.GITHUB_RUN_ID) &&
        receipt.native_attempt === id(process.env.GITHUB_RUN_ATTEMPT),
      "PROMOTED_ATTEMPT_DRIFT",
    );
    await fresh(receipt);
    requireThat(
      sha256(await readFile(path.join(dir, "image.tar.xz"))) === receipt.inner_sha256,
      "PROMOTED_DIGEST_DRIFT",
    );
    const work = await mkdtemp(path.join(ROOT, ".local/issue99/promoted-"));
    await decompress(path.join(dir, "image.tar.xz"), path.join(work, "image.tar"));
    run(
      "sh",
      [
        "infra/seaweedfs/verify-image.sh",
        path.join(work, "image.tar"),
        path.join(work, "inspection"),
      ],
      { stdio: "inherit" },
    );
    const verification = await jsonFile(path.join(work, "inspection/verify-image.json"));
    requireThat(
      verification.image_id === receipt.image_id && verification.elf_sha256 === receipt.elf_sha256,
      "PROMOTED_IMAGE_DRIFT",
    );
    await fresh(receipt);
    run("docker", ["load", "-i", path.join(work, "image.tar")]);
    run("docker", ["tag", receipt.image_id, "editagent-seaweedfs:local"]);
    await rm(path.join(work, "image.tar"));
    await dispose(path.join(work, "inspection"));
    const receiptFile = path.join(work, "admission.json");
    await writeFile(receiptFile, JSON.stringify(receipt));
    await output("receipt", receiptFile);
    return;
  }
  requireThat(["admit", "load", "final"].includes(mode), "INVALID_MODE");
  if (mode === "final") {
    if (extra) requireThat(sha256(await readFile(arg)) === extra, "FINAL_RECEIPT_DRIFT");
    await fresh(await jsonFile(arg));
    console.log("FINAL_ADMISSION_IDENTITY_VERIFIED");
    return;
  }
  const work = await mkdtemp(path.join(ROOT, ".local/issue99/admission-"));
  const admitted = await qualified(work);
  let receipt = await materialize(admitted.artifact, work, admitted.receipt);
  await fresh(receipt);
  if (mode === "load") {
    if (arg) {
      const [source, attempt, artifact] = arg.split(":").map(id);
      requireThat(
        source === receipt.producer_run &&
          attempt === receipt.producer_attempt &&
          artifact === receipt.artifact_id,
        "PREPARATION_BINDING_DRIFT",
      );
    }
    run("docker", ["load", "-i", receipt.archive]);
    run("docker", ["tag", receipt.image_id, "editagent-seaweedfs:local"]);
  }
  await rm(receipt.archive);
  const file = path.join(work, "admission.json");
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  const promotedReceipt = JSON.stringify(receipt) + "\n";
  await writeFile(path.join(receipt.bundle, "admission.json"), promotedReceipt, { mode: 0o600 });
  await output("receipt", file);
  await output("bundle", receipt.bundle);
  await output("producer", receipt.producer_run);
  await output("producer_attempt", receipt.producer_attempt);
  await output("artifact", receipt.artifact_id);
  await output("receipt_sha256", sha256(Buffer.from(promotedReceipt)));
  console.log(
    JSON.stringify({
      outcome: "QUALIFIED",
      native_run: receipt.native_run_id,
      attempt: receipt.native_attempt,
      producer: receipt.producer_run,
      producer_attempt: receipt.producer_attempt,
      image_id: receipt.image_id,
      C: receipt.C,
      R: receipt.R,
    }),
  );
}
async function produce(image, destination) {
  const { context } = await identity();
  const folder = path.resolve(destination);
  requireThat(
    folder === path.join(ROOT, ".local/seaweedfs-transfer/bundle"),
    "ARTIFACT_DESTINATION_REJECTED",
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(path.join(ROOT, ".local/issue99/producer-"));
  const imageId = run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]).trim();
  run("sh", ["infra/seaweedfs/verify-image.sh", imageId, work], { stdio: "inherit" });
  const verification = await jsonFile(path.join(work, "verify-image.json"));
  requireThat(
    verification.image_id === imageId &&
      verification.project_revision === context.M &&
      verification.project_source === `https://github.com/${REPOSITORY}`,
    "PRODUCER_IMAGE_IDENTITY_DRIFT",
  );
  await writeFile(path.join(folder, "verification.json"), JSON.stringify(verification) + "\n");
  await writeFile(
    path.join(folder, "go-version-m.txt"),
    await readFile(path.join(work, "actual-go-version-m.txt")),
  );
  const syftVersion = JSON.parse(run("syft", ["version", "-o", "json"]));
  requireThat(syftVersion.version === "1.54.0", "SCANNER_VERSION_DRIFT");
  const trivyCache = path.join(work, "trivy-cache");
  const trivyVersion = () =>
    JSON.parse(
      run("trivy", ["--config=", "--cache-dir", trivyCache, "version", "--format", "json"]),
    );
  requireThat(trivyVersion().Version === "0.75.0", "SCANNER_VERSION_DRIFT");
  run("syft", [imageId, "-o", `spdx-json=${path.join(folder, "sbom.spdx.json")}`]);
  run("trivy", [
    "--config=",
    "--cache-dir",
    trivyCache,
    "image",
    "--ignorefile=",
    "--secret-config=",
    "--ignore-unfixed=false",
    "--severity",
    "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
    "--format",
    "json",
    "--output",
    path.join(folder, "full-trivy.json"),
    "--exit-code",
    "0",
    imageId,
  ]);
  validateScans(
    await jsonFile(path.join(folder, "full-trivy.json")),
    await jsonFile(path.join(folder, "sbom.spdx.json")),
  );
  const freshVersion = trivyVersion();
  requireThat(
    freshVersion.Version === "0.75.0" &&
      Date.parse(freshVersion.VulnerabilityDB?.DownloadedAt) >=
        Date.parse(
          process.env.GITHUB_EVENT_NAME === "pull_request"
            ? (await api(`actions/runs/${id(process.env.GITHUB_RUN_ID)}`)).created_at
            : "invalid",
        ),
    "FRESH_DB_EVIDENCE_MISSING",
  );
  const scannerEvidence = {
    trivy: { Version: freshVersion.Version, VulnerabilityDB: freshVersion.VulnerabilityDB },
    syft: {
      version: syftVersion.version,
      gitCommit: syftVersion.gitCommit,
      goVersion: syftVersion.goVersion,
    },
  };
  await writeFile(
    path.join(folder, "scanner-versions.json"),
    JSON.stringify(scannerEvidence) + "\n",
  );
  requireThat(
    (await jsonFile(path.join(folder, "full-trivy.json"))).Metadata?.ImageID === imageId,
    "SCAN_IMAGE_IDENTITY_DRIFT",
  );
  run("python3", [
    "-c",
    `
import lzma,sys
with open(sys.argv[1],'rb') as src,lzma.open(sys.argv[2],'xb',preset=6) as dst:
 while b:=src.read(1048576): dst.write(b)
`,
    path.join(work, "candidate.tar"),
    path.join(folder, "image.tar.xz"),
  ]);
  const files = {};
  let R = 0;
  for (const name of FILES.filter((n) => n !== "candidate-manifest.json")) {
    files[name] = sha256(await readFile(path.join(folder, name)));
    if (name !== "image.tar.xz") R += (await stat(path.join(folder, name))).size;
  }
  const policyFiles = {};
  for (const name of POLICY_FILES)
    policyFiles[name] = sha256(
      run("git", ["show", `${context.M}:${name}`], { encoding: "buffer" }),
    );
  const manifest = {
    context,
    run_id: id(process.env.GITHUB_RUN_ID),
    attempt: id(process.env.GITHUB_RUN_ATTEMPT),
    image_id: imageId,
    elf_sha256: verification.elf_sha256,
    files,
    policy_files: policyFiles,
  };
  const text = JSON.stringify(manifest, null, 2) + "\n";
  R += Buffer.byteLength(text);
  const C = (await stat(path.join(folder, "image.tar.xz"))).size;
  requireThat(
    C <= IMAGE_CAP && 2 * R + 65536 <= REPORT_CAP && 2 * C + 2 * R + 65536 <= 256 * 1024 * 1024,
    "TRANSFER_BUDGET_EXCEEDED",
  );
  await writeFile(path.join(folder, "candidate-manifest.json"), text);
  await dispose(work);
  console.log(
    JSON.stringify({ image_id: imageId, C, R, total_transfer_bytes: 2 * C + 2 * R + 65536 }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(...process.argv.slice(2)).catch(async (error) => {
    const outcome = error instanceof AdmissionError ? error.code : "ADMISSION_INTERNAL_ERROR";
    const result = {
      outcome,
      retryable_prerequisite: ["PRODUCER_NOT_YET_CREATED", "PRODUCER_NOT_YET_COMPLETE"].includes(
        outcome,
      ),
      run_id: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      identity_evidence: lastIdentityEvidence,
      identity_observations: identityObservations,
    };
    console.error(JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) await output("outcome", outcome);
    await mkdir(path.join(ROOT, ".local/issue99"), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(ROOT, ".local/issue99/admission-outcome.json"),
      JSON.stringify(result) + "\n",
      { mode: 0o600 },
    );
    process.exitCode = 1;
  });
}
