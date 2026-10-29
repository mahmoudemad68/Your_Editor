/** Admission of a completed, reviewed Supply run. No candidate code executes here. */
import { isDeepStrictEqual } from "node:util";
import process from "node:process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { availableParallelism, totalmem, freemem } from "node:os";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  stat,
  lstat,
  statfs,
  realpath,
  rm,
} from "node:fs/promises";
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
export async function decompress(
  source,
  target,
  python = "python3",
  maxBytes = 4 * 1024 ** 3,
  boundedExperiment = false,
) {
  requireThat(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 4 * 1024 ** 3,
    "IMAGE_EXPANSION_LIMIT_INVALID",
  );
  requireThat(typeof boundedExperiment === "boolean", "FILTER_DECODER_SETTING_INVALID");
  return JSON.parse(
    run(python, [
      "-c",
      `
import lzma,sys,time,json
try: import resource
except ImportError: resource=None
limits=None
if sys.argv[4]=='true' and sys.platform=='linux':
 if resource is None: raise ValueError('resource measurement unavailable')
 resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456))
 limits={'address_space_bytes':268435456}
started=time.perf_counter()
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
u=resource.getrusage(resource.RUSAGE_SELF) if resource else None
print(json.dumps({'elapsed_seconds':time.perf_counter()-started,'uncompressed_bytes':total,'peak_rss_bytes':u.ru_maxrss*1024 if u and sys.platform=='linux' else None,'limits':limits}))
`,
      source,
      target,
      String(maxBytes),
      String(boundedExperiment),
    ]),
  );
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

const MIB = 1024 * 1024;
export const REPORT_FILES = Object.freeze(FILES.filter((name) => name !== "image.tar.xz"));
const byteCount = (value) => Number.isSafeInteger(value) && value > 0;
export function transferBudgetReport(measurement) {
  requireThat(
    measurement && byteCount(measurement.uncompressed_archive_bytes) && byteCount(measurement.C),
    "TRANSFER_MEASUREMENT_INVALID",
  );
  const sizes = measurement.report_file_bytes;
  requireThat(
    sizes &&
      isDeepStrictEqual(Object.keys(sizes).sort(), [...REPORT_FILES].sort()) &&
      Object.values(sizes).every(byteCount),
    "TRANSFER_MEASUREMENT_INVALID",
  );
  const compression = measurement.compression;
  requireThat(
    compression &&
      compression.algorithm === "xz" &&
      [6, 9].includes(compression.preset) &&
      Number.isFinite(compression.elapsed_seconds) &&
      compression.elapsed_seconds > 0 &&
      /^[a-f0-9]{64}$/.test(compression.input_sha256) &&
      /^[a-f0-9]{64}$/.test(compression.output_sha256),
    "TRANSFER_MEASUREMENT_INVALID",
  );
  for (const key of ["peak_rss_bytes", "user_cpu_seconds", "system_cpu_seconds"])
    requireThat(
      compression[key] === null || (Number.isFinite(compression[key]) && compression[key] >= 0),
      "TRANSFER_MEASUREMENT_INVALID",
    );
  requireThat(
    compression.peak_rss_bytes === null || Number.isSafeInteger(compression.peak_rss_bytes),
    "TRANSFER_MEASUREMENT_INVALID",
  );
  const R = Object.values(sizes).reduce((sum, n) => sum + n, 0),
    R_total = 2 * R + 65536,
    combined = 2 * measurement.C + R_total;
  requireThat([R, R_total, combined].every(Number.isSafeInteger), "TRANSFER_MEASUREMENT_INVALID");
  const predicates = {
    candidate: measurement.C <= IMAGE_CAP,
    replicated_provenance: R_total <= REPORT_CAP,
    combined: combined <= 256 * MIB,
  };
  return {
    kind: "TRANSFER_BUDGET_MEASUREMENT",
    schema_version: 1,
    byte_unit: "bytes",
    mib_unit_bytes: MIB,
    uncompressed_archive_bytes: measurement.uncompressed_archive_bytes,
    C: measurement.C,
    report_file_bytes: { ...sizes },
    R,
    provenance_copies: 2,
    provenance_reserve_bytes: 65536,
    R_total,
    combined_transfer_bytes: combined,
    retention_days: 1,
    thresholds: { C: IMAGE_CAP, R_total: REPORT_CAP, combined_transfer_bytes: 256 * MIB },
    display_mib: {
      uncompressed_archive: measurement.uncompressed_archive_bytes / MIB,
      C: measurement.C / MIB,
      R: R / MIB,
      R_total: R_total / MIB,
      combined: combined / MIB,
    },
    thresholds_mib: { C: 120, R_total: 16, combined: 256 },
    predicates,
    within_budget: Object.values(predicates).every(Boolean),
    compression: {
      algorithm: "xz",
      preset: compression.preset,
      elapsed_seconds: compression.elapsed_seconds,
      input_sha256: compression.input_sha256,
      output_sha256: compression.output_sha256,
      peak_rss_bytes: compression.peak_rss_bytes,
      user_cpu_seconds: compression.user_cpu_seconds,
      system_cpu_seconds: compression.system_cpu_seconds,
    },
    observed_resources: {
      visibility: "process_and_runner_observation_only",
      platform: process.platform,
      available_parallelism: availableParallelism(),
      total_memory_bytes: totalmem(),
      free_memory_bytes: freemem(),
    },
  };
}
export async function reportAndEnforceTransfer(measurement, emit, forensic) {
  const report = transferBudgetReport(measurement);
  const withinBudget = report.within_budget;
  try {
    await emit(globalThis.structuredClone(report));
  } catch {
    throw new AdmissionError(
      withinBudget ? "BUDGET_REPORT_EMISSION_FAILED" : "TRANSFER_BUDGET_EXCEEDED",
    );
  }
  if (!withinBudget) {
    if (forensic) {
      try {
        await forensic(globalThis.structuredClone(report));
      } catch {
        try {
          await emit({
            kind: "LOSSLESS_COMPRESSION_PROBE",
            outcome: "NOT_PROVEN_RESOURCE_OR_VERIFICATION_FAILURE",
            qualified: false,
          });
        } catch {
          /* preserve original rejection */
        }
      }
    }
    // Neither a successful diagnostic callback nor a smaller experimental file
    // can change the disposition of the original baseline candidate.
    throw new AdmissionError("TRANSFER_BUDGET_EXCEEDED");
  }
  return report;
}
export const FILTER_PROFILE = "xz-x86-bcj-lzma2-preset9";
export const OCI_PROFILE = "complete-oci-raw-xz6-v1";
export function compressArchive(source, target, preset = 6, python = "python3", profile = "plain") {
  requireThat(
    [6, 9].includes(preset) &&
      (profile === "plain" ||
        (profile === FILTER_PROFILE && preset === 9) ||
        (profile === OCI_PROFILE && preset === 6)),
    "COMPRESSION_SETTING_REJECTED",
  );
  const started = Date.now();
  const result = JSON.parse(
    run(
      python,
      [
        "-c",
        `
import lzma,sys,time,hashlib,platform,ctypes,_lzma
from pathlib import Path
preset=int(sys.argv[3]);profile=sys.argv[4];limits=None
try:
 import resource
 if sys.platform=='linux':
  resource.setrlimit(resource.RLIMIT_AS,(1073741824,1073741824))
  limit=480 if preset==9 or profile=='complete-oci-raw-xz6-v1' else 540
  resource.setrlimit(resource.RLIMIT_CPU,(limit,limit))
  limits={'address_space_bytes':1073741824,'cpu_seconds':limit}
except ImportError: resource=None
try:
 library=ctypes.CDLL(_lzma.__file__);version=library.lzma_version_string;version.restype=ctypes.c_char_p
 libversion=version().decode('ascii')
except (AttributeError,OSError):libversion='UNAVAILABLE'
filtered=profile=='xz-x86-bcj-lzma2-preset9'
options={'filters':[{'id':lzma.FILTER_X86},{'id':lzma.FILTER_LZMA2,'preset':9}]} if filtered else {'preset':preset}
started=time.perf_counter();h=hashlib.sha256();count=0
with open(sys.argv[1],'rb') as src,lzma.open(sys.argv[2],'xb',format=lzma.FORMAT_XZ,check=lzma.CHECK_CRC64,**options) as dst:
 while b:=src.read(1048576):h.update(b);count+=len(b);dst.write(b)
elapsed=time.perf_counter()-started;out=hashlib.sha256()
with open(sys.argv[2],'rb') as f:
 while b:=f.read(1048576):out.update(b)
u=resource.getrusage(resource.RUSAGE_SELF) if resource else None
import json
print(json.dumps({'algorithm':'xz','preset':preset,'profile':profile,'filter_chain':['X86','LZMA2_PRESET_9'] if filtered else ['LZMA2_PRESET_'+str(preset)],'check':'CRC64','runtime':{'python':platform.python_version(),'implementation':platform.python_implementation(),'platform':sys.platform,'liblzma':libversion},'elapsed_seconds':elapsed,'input_sha256':h.hexdigest(),'output_sha256':out.hexdigest(),'uncompressed_bytes':count,'compressed_bytes':Path(sys.argv[2]).stat().st_size,'peak_rss_bytes':u.ru_maxrss*1024 if u and sys.platform=='linux' else None,'user_cpu_seconds':u.ru_utime if u else None,'system_cpu_seconds':u.ru_stime if u else None,'limits':limits}))
`,
        source,
        target,
        String(preset),
        profile,
      ],
      { timeout: preset === 9 || profile === OCI_PROFILE ? 540000 : 600000 },
    ),
  );
  return { ...result, process_wall_seconds: (Date.now() - started) / 1000 };
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function fileBytes(file) {
  try {
    const info = await lstat(file);
    requireThat(info.isFile() && byteCount(info.size), "TRANSFER_MEASUREMENT_INVALID");
    return info.size;
  } catch {
    throw new AdmissionError("TRANSFER_MEASUREMENT_INVALID");
  }
}

export function validateFilterAttempt(result, expected) {
  requireThat(
    result && result.budget && result.encoder && result.decoding && result.identity,
    "FILTER_MEASUREMENTS_UNAVAILABLE",
  );
  requireThat(result.artifact_uploaded === false, "FILTER_PROMOTION_FORBIDDEN");
  const c = result.encoder,
    d = result.decoding;
  requireThat(
    c.profile === FILTER_PROFILE &&
      isDeepStrictEqual(c.filter_chain, ["X86", "LZMA2_PRESET_9"]) &&
      c.algorithm === "xz" &&
      c.preset === 9 &&
      c.check === "CRC64",
    "FILTER_PROFILE_DRIFT",
  );
  requireThat(
    c.runtime?.platform === "linux" &&
      /^\d+\.\d+\.\d+(?:[a-z0-9.-]*)?$/.test(c.runtime.python) &&
      c.runtime.implementation === "CPython" &&
      /^\d+\.\d+\.\d+(?:[a-z0-9.-]*)?$/.test(c.runtime.liblzma),
    "FILTER_RUNTIME_UNAVAILABLE",
  );
  const positive = (n) => Number.isFinite(n) && n > 0;
  requireThat(
    positive(c.process_wall_seconds) &&
      c.process_wall_seconds <= 540 &&
      positive(c.elapsed_seconds) &&
      c.elapsed_seconds <= 540 &&
      Number.isSafeInteger(c.peak_rss_bytes) &&
      c.peak_rss_bytes > 0 &&
      c.peak_rss_bytes <= 1073741824 &&
      Number.isFinite(c.user_cpu_seconds) &&
      c.user_cpu_seconds >= 0 &&
      Number.isFinite(c.system_cpu_seconds) &&
      c.system_cpu_seconds >= 0 &&
      c.user_cpu_seconds + c.system_cpu_seconds <= 480 &&
      c.limits?.address_space_bytes === 1073741824 &&
      c.limits?.cpu_seconds === 480,
    "FILTER_ENCODER_RESOURCE_LIMIT",
  );
  requireThat(
    positive(d.elapsed_seconds) &&
      d.elapsed_seconds <= 600 &&
      Number.isSafeInteger(d.peak_rss_bytes) &&
      d.peak_rss_bytes > 0 &&
      d.peak_rss_bytes <= 256 * MIB &&
      d.limits?.address_space_bytes === 268435456 &&
      d.uncompressed_bytes === expected.archive_bytes &&
      d.uncompressed_bytes <= 4 * 1024 ** 3,
    "FILTER_DECODER_RESOURCE_LIMIT",
  );
  requireThat(
    result.archive_sha256 === expected.archive_sha256 &&
      c.input_sha256 === expected.archive_sha256 &&
      c.uncompressed_bytes === expected.archive_bytes &&
      /^[a-f0-9]{64}$/.test(c.output_sha256),
    "FILTER_ARCHIVE_DRIFT",
  );
  requireThat(
    isDeepStrictEqual(result.identity, expected.identity),
    "FILTER_IMAGE_LAYER_ELF_DRIFT",
  );
  const recalculated = transferBudgetReport({
    uncompressed_archive_bytes: expected.archive_bytes,
    C: c.compressed_bytes,
    report_file_bytes: expected.report_file_bytes,
    compression: c,
  });
  requireThat(
    result.budget.C === recalculated.C &&
      result.budget.R === recalculated.R &&
      result.budget.R_total === recalculated.R_total &&
      result.budget.combined_transfer_bytes === recalculated.combined_transfer_bytes,
    "FILTER_ACCOUNTING_DRIFT",
  );
  requireThat(recalculated.within_budget, "FILTER_CAPACITY_FAILED");
}
export async function runBoundedFilterExperiment(expected, attempt, emit) {
  const results = [];
  let started = 0;
  try {
    for (let number = 1; number <= 2; number++) {
      started = number;
      const result = await attempt(number);
      results.push(globalThis.structuredClone(result));
      try {
        validateFilterAttempt(result, expected);
      } catch (error) {
        await emit({
          kind: "BCJ_FILTER_ATTEMPT",
          attempt: number,
          qualified: false,
          result: globalThis.structuredClone(result),
          failure: error instanceof AdmissionError ? error.code : "FILTER_VALIDATION_FAILED",
        });
        throw error;
      }
      await emit({
        kind: "BCJ_FILTER_ATTEMPT",
        attempt: number,
        qualified: false,
        result: globalThis.structuredClone(result),
        outcome: "ATTEMPT_CONDITIONS_PASS",
      });
      if (number === 2)
        requireThat(
          results[0].encoder.output_sha256 === result.encoder.output_sha256 &&
            results[0].encoder.compressed_bytes === result.encoder.compressed_bytes &&
            isDeepStrictEqual(results[0].encoder.runtime, result.encoder.runtime),
          "FILTER_REPRODUCIBILITY_FAILED",
        );
    }
    await emit({
      kind: "BCJ_FILTER_FEASIBILITY",
      verdict: "FULL_IMAGE_FILTER_FEASIBILITY=MET_EXPERIMENT_ONLY",
      qualified: false,
      attempts: 2,
      compressed_sha256: results[0].encoder.output_sha256,
      baseline_disposition: "TRANSFER_BUDGET_EXCEEDED",
      artifact_compatibility: "NOT_PROVEN_NO_UPLOAD",
    });
    return "FULL_IMAGE_FILTER_FEASIBILITY=MET_EXPERIMENT_ONLY";
  } catch (error) {
    await emit({
      kind: "BCJ_FILTER_FEASIBILITY",
      verdict: "FULL_IMAGE_FILTER_FEASIBILITY=NOT_MET",
      qualified: false,
      attempts: started,
      verified_results: results.length,
      failure:
        error instanceof AdmissionError ? error.code : "FILTER_RESOURCE_OR_MEASUREMENT_FAILURE",
      signal: ["SIGTERM", "SIGKILL", "SIGXCPU"].includes(error?.signal) ? error.signal : null,
      baseline_disposition: "TRANSFER_BUDGET_EXCEEDED",
    });
    return "FULL_IMAGE_FILTER_FEASIBILITY=NOT_MET";
  }
}
async function archiveIdentity(file) {
  return JSON.parse(
    run("python3", [
      "-c",
      `
import tarfile,json,sys,hashlib
with tarfile.open(sys.argv[1],'r:') as t:
 m=json.load(t.extractfile('manifest.json'))
 if len(m)!=1: raise ValueError('ambiguous manifest')
 b=t.extractfile(m[0]['Config']).read(1048577)
 if len(b)>1048576: raise ValueError('config size')
 c=json.loads(b)
 print(json.dumps({'config_sha256':hashlib.sha256(b).hexdigest(),'layer_diff_ids':c['rootfs']['diff_ids']}))
`,
      file,
    ]),
  );
}
function filterIdentity(verification, layers) {
  requireThat(
    layers.config_sha256 === verification.image_id.slice(7) &&
      Array.isArray(layers.layer_diff_ids) &&
      layers.layer_diff_ids.length === 6 &&
      layers.layer_diff_ids.every((v) => /^sha256:[a-f0-9]{64}$/.test(v)),
    "FILTER_LAYER_CONFIG_INVALID",
  );
  requireThat(
    verification.old_elf_absent === true &&
      verification.runtime_preserved === true &&
      verification.native_brotli === "1.2.1-r0" &&
      verification.rust_sha256 &&
      Object.keys(verification.rust_sha256).length === 2 &&
      Object.values(verification.rust_sha256).every((v) => /^[a-f0-9]{64}$/.test(v)),
    "FILTER_NATIVE_RUNTIME_INVALID",
  );
  return {
    image_id: verification.image_id,
    config_sha256: layers.config_sha256,
    layer_diff_ids: layers.layer_diff_ids,
    elf_sha256: verification.elf_sha256,
    old_elf_absent: true,
    runtime_preserved: true,
    native_brotli: verification.native_brotli,
    rust_sha256: verification.rust_sha256,
  };
}
export const OCI_DIAGNOSTIC_PY = String.raw`import sys,json,hashlib,tarfile,posixpath,gzip,tempfile,os,time,contextlib,re
from pathlib import Path
try: import resource
except ImportError: resource=None
LIMIT=4*1024**3
PROFILE='complete-oci-raw-xz6-v1'
RAW='application/vnd.oci.image.layer.v1.tar'
MAN='application/vnd.oci.image.manifest.v1+json'
CFG='application/vnd.oci.image.config.v1+json'
IDX='application/vnd.oci.image.index.v1+json'
OBS={}
class Reject(Exception):pass
def need(ok,code):
 if not ok:raise Reject(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def filehash(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def digest(s):return isinstance(s,str) and len(s)==71 and s.startswith('sha256:') and all(c in '0123456789abcdef' for c in s[7:])
def integer(n):return type(n) is int and 0<=n<=LIMIT
def pairs(a):
 d={}
 for k,v in a:
  need(k not in d,'OCI_JSON_DUPLICATE');d[k]=v
 return d
def parse(b):
 need(len(b)<=1048576,'OCI_METADATA_LIMIT')
 v=json.loads(b.decode('utf8'),object_pairs_hook=pairs,parse_constant=lambda _:need(False,'OCI_JSON_NUMBER'))
 def walk(x,n=0):
  need(n<=32,'OCI_METADATA_DEPTH')
  if isinstance(x,dict):
   for a in x.values():walk(a,n+1)
  if isinstance(x,list):
   for a in x:walk(a,n+1)
 walk(v);return v
def encode(v):return (json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True)+'\n').encode()
def path(s,root=False):
 need(isinstance(s,str),'OCI_PATH')
 s=s.removeprefix('./').rstrip('/')
 if s in ('','.'):need(root,'OCI_PATH');return ''
 need(not s.startswith('/') and '\\' not in s and ':' not in s and '\x00' not in s and all(p not in ('','..','.') for p in s.split('/')),'OCI_PATH')
 return s
def copy(src,dst,count):
 h=hashlib.sha256();remaining=count
 while remaining:
  b=src.read(min(1048576,remaining));need(bool(b),'OCI_TRUNCATED');remaining-=len(b);h.update(b)
  if dst:dst.write(b)
 return h.hexdigest()
def header(name,size,kind=tarfile.REGTYPE):
 t=tarfile.TarInfo(name);t.size=size;t.type=kind;t.mode=0o755 if kind==tarfile.DIRTYPE else 0o644
 t.uid=t.gid=t.mtime=0;t.uname=t.gname=''
 return t.tobuf(format=tarfile.USTAR_FORMAT,encoding='utf8',errors='strict')
def wrap(target,items,dirs=False):
 need(len({n for n,_,_ in items})==len(items),'OCI_DUPLICATE_ENTRY')
 total=1024;payload=0
 for n,size,_ in items:total+=512+((size+511)//512)*512;payload+=size
 if dirs:total+=1024
 need(total<=LIMIT,'OCI_EXPANSION_LIMIT')
 with open(target,'xb') as out:
  if dirs:
   for n in ('blobs/','blobs/sha256/'):out.write(header(n,0,tarfile.DIRTYPE))
  for n,size,source in sorted(items):
   out.write(header(n,size))
   with source() as f:copy(f,out,size)
   out.write(b'\0'*((-size)%512))
  out.write(b'\0'*1024)
 need(Path(target).stat().st_size==total,'OCI_WRITER_SIZE')
 return {'bytes':total,'sha256':filehash(target),'header_padding_bytes':total-payload,'payload_bytes':payload}
class Segment:
 def __init__(self,p,offset,size):self.p=p;self.offset=offset;self.size=size
 def __enter__(self):self.f=open(self.p,'rb');self.f.seek(self.offset);return self
 def __exit__(self,*a):self.f.close()
 def read(self,n=-1):
  if n<0:n=self.size
  n=min(n,self.size);b=self.f.read(n);self.size-=len(b);return b
def records(p):
 # Fixed canonical USTAR only; no implicit PAX/long-name interpretation.
 need(Path(p).stat().st_size<=LIMIT,'OCI_EXPANSION_LIMIT');result={}
 with open(p,'rb') as f:
  while True:
   b=f.read(512);need(len(b)==512,'OCI_TRUNCATED')
   if b==b'\0'*512:
    need(f.read(512)==b'\0'*512 and not f.read(1),'OCI_TRAILING_DATA');break
   t=tarfile.TarInfo.frombuf(b,'utf8','strict');n=t.name+('/' if t.isdir() and not t.name.endswith('/') else '')
   need(n not in result and len(result)<16,'OCI_DUPLICATE_OR_EXCESS_ENTRY')
   need(t.type in (tarfile.REGTYPE,tarfile.DIRTYPE) and b==header(n,t.size,t.type),'OCI_OUTER_HEADER')
   if t.isdir():need(n in ('blobs/','blobs/sha256/') and t.size==0,'OCI_OUTER_PATH')
   else:need(n in ('oci-layout','index.json') or (n.startswith('blobs/sha256/') and digest('sha256:'+n[13:])),'OCI_OUTER_PATH')
   need(integer(t.size),'OCI_SIZE');result[n]={'offset':f.tell(),'bytes':t.size,'directory':t.isdir()}
   f.seek(t.size,1);padding=f.read((-t.size)%512);need(padding==b'\0'*len(padding) and len(padding)==(-t.size)%512,'OCI_PADDING')
 return result
def pax(b):
 need(len(b)<=1048576,'OCI_PAX_LIMIT');d={}
 while b:
  n,boundary,b2=b.partition(b' ');need(boundary and n.isdigit(),'OCI_PAX')
  length=int(n);need(0<length<=len(b),'OCI_PAX')
  entry=b[len(n)+1:length];need(entry.endswith(b'\n'),'OCI_PAX')
  k,sep,v=entry[:-1].partition(b'=');need(sep,'OCI_PAX');k=k.decode('utf8');v=v.decode('utf8')
  need(k not in d and len(v.encode())<=65536,'OCI_PAX')
  OBS['pax_key_sha256']=sha(k.encode('utf8'));need(k in ('path','linkpath','size','uid','gid','uname','gname','mtime','atime','ctime') or k.startswith('SCHILY.xattr.'),'OCI_PAX_UNSUPPORTED')
  if k in ('mtime','atime','ctime'):need(re.fullmatch(r'-?[0-9]{1,20}(?:\.[0-9]{1,9})?',v) is not None,'OCI_PAX_NUMBER')
  d[k]=v;b=b[length:]
 return d
def layer(f,length,state,old,counts):
 need(length>=1024 and length%512==0,'OCI_LAYER_END')
 remaining=length;seen=set();pending={};longname=None;longlink=None;forms={};elfs=[];ended=False;extended=0
 def read(n):
  nonlocal remaining
  need(0<=n<=remaining,'OCI_LAYER_TRUNCATED');b=f.read(n);need(len(b)==n,'OCI_LAYER_TRUNCATED');remaining-=n;return b
 while remaining:
  b=read(512)
  if b==b'\0'*512:
   ended=True
   need(remaining>=512 and read(512)==b'\0'*512 and not pending and longname is None and longlink is None,'OCI_LAYER_END')
   while remaining:need(not any(read(min(1048576,remaining))),'OCI_LAYER_TRAILING')
   break
  t=tarfile.TarInfo.frombuf(b,'utf8','strict');OBS.update(header_type_hex=t.type.hex(),header_name_sha256=sha(t.name.encode('utf8')));need(integer(t.size),'OCI_LAYER_SIZE')
  need(type(t.uid) is int and 0<=t.uid<=4294967295 and type(t.gid) is int and 0<=t.gid<=4294967295 and 0<=t.mode<=0o7777,'OCI_LAYER_OWNER_MODE')
  forms[t.type.decode('ascii')]=forms.get(t.type.decode('ascii'),0)+1
  if t.type in (tarfile.XHDTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_LONGLINK):
   counts['extended_bytes']+=t.size;extended+=t.size;need(extended<=1048576,'OCI_PAX_LIMIT')
   v=read(t.size);read((-t.size)%512)
   if t.type==tarfile.XHDTYPE:need(not pending,'OCI_PAX');pending=pax(v)
   elif t.type==tarfile.GNUTYPE_LONGNAME:need(longname is None,'OCI_PAX');longname=v.rstrip(b'\0').decode('utf8')
   else:need(longlink is None,'OCI_PAX');longlink=v.rstrip(b'\0').decode('utf8')
   continue
  need(t.type in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE,tarfile.SYMTYPE,tarfile.LNKTYPE),'OCI_LAYER_TYPE_UNSUPPORTED')
  name=path(pending.get('path',longname if longname is not None else t.name),True)
  link=pending.get('linkpath',longlink if longlink is not None else t.linkname)
  for key in ('size','uid','gid'):
   if key in pending:need(pending[key].isdigit() and int(pending[key])==getattr(t,key),'OCI_PAX_OVERRIDE_UNSUPPORTED')
  need(name not in seen,'OCI_LAYER_DUPLICATE');seen.add(name);counts['entries']+=1;need(counts['entries']<=200000,'OCI_ENTRY_LIMIT')
  need(not posixpath.basename(name).startswith('.wh.'),'OCI_WHITEOUT_UNSUPPORTED')
  need(not(name=='usr/local/go' or name.startswith(('usr/local/go/','root/go/','build/'))),'OCI_COMPILER_IN_LAYER')
  for parent in [name.rsplit('/',i)[0] for i in range(1,name.count('/')+1)]:
   need(parent not in state or state[parent]['type']=='5','OCI_LINK_PARENT_UNSUPPORTED')
  h=None;iself=False
  if t.isfile():
   need(t.size<=512*1024**2,'OCI_FILE_LIMIT');hasher=hashlib.sha256();left=t.size;first=True
   while left:
    v=read(min(1048576,left));left-=len(v);hasher.update(v)
    if first:iself=v.startswith(b'\x7fELF');first=False
   h=hasher.hexdigest()
   if iself:need(h!=old and not name.startswith('usr/share/editagent-seaweedfs/'),'OCI_OLD_OR_HIDDEN_ELF');elfs.append(h)
  else:need(t.size==0,'OCI_LINK_OR_DIR_DATA')
  read((-t.size)%512)
  if t.issym() or t.islnk():
   need(link and '\\' not in link and '\0' not in link,'OCI_LINK_UNSUPPORTED')
   target=posixpath.normpath((link.lstrip('/') if link.startswith('/') else posixpath.join(posixpath.dirname(name),link)) if t.issym() else link)
   target=path(target,True)
   if t.islnk():need(target in state and state[target]['type'] in ('0','1'),'OCI_HARDLINK_UNSUPPORTED');h=state[target]['sha256']
   visited={name};cur=target
   while cur in state and state[cur]['type']=='2':
    need(cur not in visited and len(visited)<40,'OCI_LINK_CYCLE');visited.add(cur);cur=state[cur]['target']
   need(cur!=name,'OCI_LINK_CYCLE')
  else:target=None
  if name in state and state[name]['type']=='5' and not t.isdir():
   need(not any(p.startswith(name+'/') for p in state),'OCI_DIRECTORY_REPLACEMENT_UNSUPPORTED')
  state[name]={'type':'0' if t.isfile() else t.type.decode('ascii'),'mode':t.mode,'uid':t.uid,'gid':t.gid,'link':link,'target':target,'sha256':h,'mtime':str(t.mtime),'pax':pending}
  pending={};longname=longlink=None
 need(remaining==0 and ended,'OCI_LAYER_TRUNCATED')
 return {'forms':forms,'elfs':elfs}
def source(p,tmp,expected,old):
 need(Path(p).stat().st_size<=LIMIT,'OCI_SOURCE_LIMIT');sourcehash=filehash(p)
 OBS.update(source_sha256=sourcehash,source_bytes=Path(p).stat().st_size)
 if expected.get('source_sha256'):need(sourcehash==expected['source_sha256'],'OCI_SOURCE_DRIFT')
 with tarfile.open(p,'r:') as t:
  members=t.getmembers();names={}
  need(len(members)<=20000,'OCI_SOURCE_LIMIT')
  for m in members:
   n=path(m.name,True);need(n not in names and (m.isfile() or m.isdir()),'OCI_SOURCE_ENTRY');names[n]=m
  def stream(n):
   n=path(n);need(n in names and names[n].isfile(),'OCI_MISSING_BLOB');return t.extractfile(names[n])
  def data(n):
   n=path(n);need(n in names and names[n].size<=1048576,'OCI_METADATA_LIMIT')
   with stream(n) as f:return f.read()
  m=parse(data('manifest.json'));need(type(m) is list and len(m)==1,'OCI_SOURCE_MANIFEST');m=m[0]
  config=data(m['Config']);cfg=parse(config);q=sha(config)
  need('sha256:'+q==expected['image_id'] and cfg.get('architecture')=='amd64' and cfg.get('os')=='linux','OCI_CONFIG_OR_PLATFORM')
  ds=cfg['rootfs']['diff_ids'];need(cfg['rootfs']['type']=='layers' and len(ds)==6 and all(digest(d) for d in ds) and len(m['Layers'])==6,'OCI_LAYER_ORDER')
  if 'index.json' in names:
   need(parse(data('oci-layout')).get('imageLayoutVersion')=='1.0.0','OCI_SOURCE_LAYOUT')
   leaves=[]
   def desc(d,depth=0):
    need(depth<=4 and digest(d.get('digest')) and integer(d.get('size')) and not any(k in d for k in ('urls','data')),'OCI_SOURCE_DESCRIPTOR')
    n='blobs/sha256/'+d['digest'][7:];v=data(n);need(len(v)==d['size'] and sha(v)==d['digest'][7:],'OCI_SOURCE_DESCRIPTOR')
    mt=d.get('mediaType')
    if mt in (IDX,'application/vnd.docker.distribution.manifest.list.v2+json'):
     children=parse(v)['manifests'];need(len(children)==1,'OCI_SOURCE_DESCRIPTOR');desc(children[0],depth+1)
    else:need(mt in (MAN,'application/vnd.docker.distribution.manifest.v2+json'),'OCI_SOURCE_MEDIA');leaves.append(parse(v))
   idx=parse(data('index.json'));need(len(idx['manifests'])==1,'OCI_SOURCE_DESCRIPTOR');desc(idx['manifests'][0])
   need(len(leaves)==1 and leaves[0]['config']['mediaType'] in (CFG,'application/vnd.docker.container.image.v1+json') and leaves[0]['config']['digest']=='sha256:'+q and leaves[0]['config']['size']==len(config),'OCI_SOURCE_DESCRIPTOR')
   ls=leaves[0]['layers'];need(len(ls)==6,'OCI_LAYER_ORDER')
   for d,n in zip(ls,m['Layers']):
    need(digest(d.get('digest')) and d.get('mediaType') in (RAW,RAW+'+gzip','application/vnd.docker.image.rootfs.diff.tar.gzip') and not any(k in d for k in ('urls','data')),'OCI_SOURCE_MEDIA')
    need(path(n)=='blobs/sha256/'+d['digest'][7:] and names[path(n)].size==d['size'],'OCI_SOURCE_DESCRIPTOR')
  state={};layers=[];blobs={};counts={'entries':0,'extended_bytes':0};semantic=0
  for i,(n,d) in enumerate(zip(m['Layers'],ds)):
   OBS['layer_position']=i
   n=path(n);raw=Path(tmp)/('layer-'+str(i));h=hashlib.sha256();size=0
   with stream(n) as f:
    encodedhash=hashlib.file_digest(f,'sha256').hexdigest()
   if n.startswith('blobs/sha256/'):need(n[13:]==encodedhash,'OCI_SOURCE_BLOB_DIGEST')
   with stream(n) as f:
    magic=f.read(2)
   if 'index.json' in names:need((ls[i]['mediaType']==RAW and magic!=b'\x1f\x8b') or (ls[i]['mediaType']!=RAW and magic==b'\x1f\x8b'),'OCI_SOURCE_ENCODING_MEDIA_DRIFT')
   with stream(n) as f,contextlib.ExitStack() as stack,open(raw,'xb') as out:
    src=stack.enter_context(gzip.GzipFile(fileobj=f)) if magic==b'\x1f\x8b' else f
    while b:=src.read(1048576):
     size+=len(b);semantic+=len(b);need(semantic<=LIMIT,'OCI_EXPANSION_LIMIT');h.update(b);out.write(b)
   need('sha256:'+h.hexdigest()==d,'OCI_RAW_DIFFID')
   with open(raw,'rb') as f:meta=layer(f,size,state,old,counts)
   layers.append({'position':i,'diff_id':d,'raw_bytes':size,'source_encoded_bytes':names[n].size,'source_encoded_sha256':encodedhash,'metadata':meta})
   if d not in blobs:blobs[d]=raw
  need(state.get('usr/bin/weed',{}).get('sha256')==expected['elf_sha256'],'OCI_ELF_DRIFT')
  for n,h in expected['rust_sha256'].items():need(state.get(n,{}).get('sha256')==h,'OCI_NATIVE_DRIFT')
  return config,ds,layers,blobs,{'source_sha256':sourcehash,'source_bytes':Path(p).stat().st_size,'image_id':'sha256:'+q,'config_bytes':len(config),'layers':layers,'semantic_layer_bytes':semantic,'metadata_sha256':sha(encode(state)),'entry_count':counts['entries']}
def oldelf(p):
 value=None
 with tarfile.open(p,'r:') as t:
  m=parse(t.extractfile('manifest.json').read(1048577))[0]
  for n in m['Layers']:
   with t.extractfile(n) as f:magic=f.read(2)
   with t.extractfile(n) as f,contextlib.ExitStack() as stack:
    src=stack.enter_context(gzip.GzipFile(fileobj=f)) if magic==b'\x1f\x8b' else f
    with tarfile.open(fileobj=src,mode='r|') as layer_tar:
     for x in layer_tar:
      if path(x.name,True)=='usr/bin/weed' and x.isfile():value=hashlib.file_digest(layer_tar.extractfile(x),'sha256').hexdigest()
 need(value is not None,'OCI_OLD_ELF_REFERENCE_MISSING');return {'old_elf_sha256':value}
def check_descriptor(d,media):
 need(type(d) is dict and set(d)=={'mediaType','digest','size'} and d['mediaType']==media and digest(d['digest']) and integer(d['size']),'OCI_DESCRIPTOR')
def validate(p,target,expected,old):
 rs=records(p)
 def data(n):
  need(n in rs and rs[n]['bytes']<=1048576,'OCI_MISSING_OR_OVERSIZE_METADATA')
  with Segment(p,rs[n]['offset'],rs[n]['bytes']) as f:return f.read()
 need(data('oci-layout')==b'{"imageLayoutVersion":"1.0.0"}\n','OCI_LAYOUT')
 index_data=data('index.json');idx=parse(index_data);need(encode(idx)==index_data,'OCI_CANONICAL_JSON');need(set(idx)=={'schemaVersion','mediaType','manifests'} and type(idx['schemaVersion']) is int and idx['schemaVersion']==2 and idx['mediaType']==IDX and len(idx['manifests'])==1,'OCI_INDEX')
 desc=idx['manifests'][0];need(set(desc)=={'mediaType','digest','size','platform'} and desc['platform']=={'os':'linux','architecture':'amd64'},'OCI_PLATFORM')
 check_descriptor({k:v for k,v in desc.items() if k!='platform'},MAN)
 mn='blobs/sha256/'+desc['digest'][7:];mb=data(mn);need(len(mb)==desc['size'] and sha(mb)==desc['digest'][7:],'OCI_MANIFEST_DIGEST')
 m=parse(mb);need(encode(m)==mb,'OCI_CANONICAL_JSON');need(set(m)=={'schemaVersion','mediaType','config','layers'} and type(m['schemaVersion']) is int and m['schemaVersion']==2 and m['mediaType']==MAN and len(m['layers'])==6,'OCI_MANIFEST')
 check_descriptor(m['config'],CFG);cn='blobs/sha256/'+m['config']['digest'][7:];config=data(cn);cfg=parse(config)
 need(len(config)==m['config']['size'] and 'sha256:'+sha(config)==m['config']['digest']==expected['image_id'] and len(config)==expected['config_bytes'],'OCI_CONFIG_DRIFT')
 ds=cfg['rootfs']['diff_ids'];need(cfg.get('os')=='linux' and cfg.get('architecture')=='amd64' and cfg['rootfs']['type']=='layers' and ds==[v['diff_id'] for v in expected['layers']],'OCI_LAYER_ORDER')
 closure={'blobs/','blobs/sha256/','oci-layout','index.json',mn,cn};items=[];state={};counts={'entries':0,'extended_bytes':0};semantic=0
 for i,(d,original) in enumerate(zip(m['layers'],expected['layers'])):
  check_descriptor(d,RAW);need(d['digest']==ds[i] and d['size']==original['raw_bytes'],'OCI_LAYER_ORDER')
  n='blobs/sha256/'+d['digest'][7:];closure.add(n);need(n in rs and rs[n]['bytes']==d['size'],'OCI_MISSING_BLOB')
  with Segment(p,rs[n]['offset'],d['size']) as f:need(copy(f,None,d['size'])==ds[i][7:],'OCI_RAW_DIFFID')
  semantic+=d['size'];need(semantic<=LIMIT,'OCI_EXPANSION_LIMIT')
  with Segment(p,rs[n]['offset'],d['size']) as f:layer(f,d['size'],state,old,counts)
  items.append(('layers/'+str(i).zfill(4)+'/layer.tar',d['size'],lambda n=n:Segment(p,rs[n]['offset'],rs[n]['bytes'])))
 need(set(rs)==closure,'OCI_CLOSURE_EXTRA_OR_MISSING')
 need(sha(encode(state))==expected['metadata_sha256'],'OCI_RUNTIME_METADATA_DRIFT')
 need(state.get('usr/bin/weed',{}).get('sha256')==expected['elf_sha256'],'OCI_ELF_DRIFT')
 for n,h in expected['rust_sha256'].items():need(state.get(n,{}).get('sha256')==h,'OCI_NATIVE_DRIFT')
 q=sha(config);import io
 items.append((q+'.json',len(config),lambda:io.BytesIO(config)))
 adapter_manifest=encode([{'Config':q+'.json','RepoTags':[],'Layers':[v[0] for v in items if v[0].startswith('layers/')]}])
 items.append(('manifest.json',len(adapter_manifest),lambda:io.BytesIO(adapter_manifest)))
 adapter=wrap(target,items)
 return {'image_id':expected['image_id'],'ordered_diff_ids':ds,'elf_sha256':state['usr/bin/weed']['sha256'],'metadata_sha256':sha(encode(state)),'layout_sha256':filehash(p),'layout_bytes':Path(p).stat().st_size,'config_sha256':q,'manifest_sha256':sha(mb),'adapter':adapter}
def main():
 mode,p,target,expected_json=sys.argv[1:5];expected=json.loads(expected_json);old=expected.get('old_elf_sha256')
 if mode=='old-elf':return oldelf(p)
 need(digest('sha256:'+str(old)) and digest(expected.get('image_id')) and digest('sha256:'+str(expected.get('elf_sha256'))),'OCI_REFERENCE_MISSING')
 if mode=='validate':return validate(p,target,expected,old)
 need(mode in ('pack','resave'),'OCI_MODE')
 with tempfile.TemporaryDirectory(prefix='oci-raw-',dir=str(Path(target).parent)) as tmp:
  config,ds,layers,blobs,inventory=source(p,tmp,expected,old)
  if mode=='resave':return inventory
  import io
  q=sha(config);content={'oci-layout':b'{"imageLayoutVersion":"1.0.0"}\n','blobs/sha256/'+q:config}
  manifest=encode({'schemaVersion':2,'mediaType':MAN,'config':{'mediaType':CFG,'digest':'sha256:'+q,'size':len(config)},'layers':[{'mediaType':RAW,'digest':d,'size':v['raw_bytes']} for d,v in zip(ds,layers)]})
  content['blobs/sha256/'+sha(manifest)]=manifest
  content['index.json']=encode({'schemaVersion':2,'mediaType':IDX,'manifests':[{'mediaType':MAN,'digest':'sha256:'+sha(manifest),'size':len(manifest),'platform':{'os':'linux','architecture':'amd64'}}]})
  items=[(n,len(b),lambda b=b:io.BytesIO(b)) for n,b in content.items()]
  items.extend(('blobs/sha256/'+d[7:],Path(f).stat().st_size,lambda f=f:open(f,'rb')) for d,f in blobs.items())
  result=wrap(target,items,True)
  return {**inventory,'layout':result,'manifest_sha256':sha(manifest),'index_bytes':len(content['index.json']),'manifest_bytes':len(manifest),'unique_raw_blobs':len(blobs),'metadata_file_bytes':sum(map(len,content.values())),'blob_inventory':[{'path':n,'bytes':size} for n,size,_ in sorted(items)]}
try:
 limits=None
 if resource and sys.platform=='linux':
  resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456));resource.setrlimit(resource.RLIMIT_CPU,(120,120));limits={'address_space_bytes':268435456,'cpu_seconds':120}
 started=time.perf_counter();value=main();u=resource.getrusage(resource.RUSAGE_SELF) if resource else None
 visible={}
 for key in ('cpu.max','memory.max','pids.max'):
  try:
   text=(Path('/sys/fs/cgroup')/key).read_text()[:4096].strip();visible[key]=text if re.fullmatch(r'(?:max|[0-9]+)(?: [0-9]+)?',text) else 'UNTRUSTWORTHY'
  except OSError:visible[key]='UNAVAILABLE'
 value['measurement']={'visible_resources':{'affinity_cpus':len(os.sched_getaffinity(0)) if hasattr(os,'sched_getaffinity') else None,'cgroup_current_namespace':visible,'visibility':'observations only; hidden parent limits not attested'},'wall_seconds':time.perf_counter()-started,'peak_rss_bytes':u.ru_maxrss*1024 if u and sys.platform=='linux' else None,'user_cpu_seconds':u.ru_utime if u else None,'system_cpu_seconds':u.ru_stime if u else None,'limits':limits}
 print(json.dumps(value,sort_keys=True))
except Exception as error:
 print(json.dumps({'error':str(error) if isinstance(error,Reject) else 'OCI_TOOL_FAILURE','observed':OBS}));sys.exit(1)
`;
export function runOCITool(mode, input, target, expected, python = "python3") {
  requireThat(["old-elf", "pack", "validate", "resave"].includes(mode), "OCI_MODE");
  try {
    return JSON.parse(
      run(python, ["-c", OCI_DIAGNOSTIC_PY, mode, input, target, JSON.stringify(expected)], {
        timeout: 180000,
      }),
    );
  } catch (error) {
    let code = "OCI_TOOL_RESOURCE_OR_MEASUREMENT_FAILURE";
    const observed = {};
    try {
      const failure = JSON.parse(String(error.stdout));
      if (/^OCI_[A-Z0-9_]+$/.test(failure.error)) code = failure.error;
      for (const key of ["source_sha256", "header_name_sha256", "pax_key_sha256"])
        if (/^[a-f0-9]{64}$/.test(failure.observed?.[key])) observed[key] = failure.observed[key];
      for (const key of ["source_bytes", "layer_position"])
        if (byteCount(failure.observed?.[key])) observed[key] = failure.observed[key];
      if (/^[a-f0-9]{2}$/.test(failure.observed?.header_type_hex))
        observed.header_type_hex = failure.observed.header_type_hex;
    } catch {
      /* never disclose exception payloads */
    }
    const rejection = new AdmissionError(code);
    rejection.ociObserved = observed;
    throw rejection;
  }
}
export function ociZipBound(C, reportFileBytes) {
  requireThat(byteCount(C), "OCI_ZIP_MEASUREMENT_INVALID");
  requireThat(
    isDeepStrictEqual(Object.keys(reportFileBytes).sort(), [...REPORT_FILES].sort()),
    "OCI_ZIP_MEASUREMENT_INVALID",
  );
  for (const n of Object.values(reportFileBytes))
    requireThat(byteCount(n), "OCI_ZIP_MEASUREMENT_INVALID");
  // zlib default deflateBound form, plus conservative ZIP64/header allowances.
  // This is a model, not measured GitHub wire compatibility or upload approval.
  const deflate = (n) =>
    n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 13;
  const zip = (files) =>
    98 +
    files.reduce((n, [name, size]) => n + deflate(size) + 148 + 2 * Buffer.byteLength(name), 0);
  const files = [["image.oci.tar.xz", C], ...Object.entries(reportFileBytes)];
  const R = Object.values(reportFileBytes).reduce((a, b) => a + b, 0);
  const receipt = 8192,
    seal = 2048;
  const wrapper =
    1024 +
    [...files, ["admission.json", receipt]].reduce(
      (n, [, size]) => n + 512 + Math.ceil(size / 512) * 512,
      0,
    );
  const source = zip(files),
    promoted = zip([["promoted-bundle.tar", wrapper]]);
  const ancillary = zip([["admission.json", receipt]]) + zip([["seal.json", seal]]);
  const extra = Math.max(0, source - C - R) + Math.max(0, promoted - C - R) + ancillary;
  return {
    model: "default-deflate-bound-plus-ZIP64-v1",
    source_zip_upper_bytes: source,
    promotion_wrapper_upper_bytes: wrapper,
    promoted_zip_upper_bytes: promoted,
    ancillary_zip_upper_bytes: ancillary,
    extra_upper_bytes: extra,
    reserve_bytes: 65536,
    within_reserve: extra <= 65536,
    diagnostic_artifact_uploads: 0,
    diagnostic_artifact_downloads: 0,
    wire_qualification: "NOT_PROVEN_NO_UPLOAD",
  };
}
function measureOCICommand(command, timeout = 240, daemon = false) {
  const script = String.raw`
import sys,json,time,subprocess,os,signal,resource
from pathlib import Path
command=json.loads(sys.argv[1]);limit=int(sys.argv[2]);daemon=sys.argv[3]=='true'
samples=0;peak=0;hwm=0;pids=[]
if daemon:
 for entry in Path('/proc').iterdir():
  if entry.name.isdigit():
   try:
    if (entry/'comm').read_text().strip() in ('dockerd','containerd'):pids.append(entry)
   except OSError:pass
 if not pids:print(json.dumps({'error':'OCI_DAEMON_MEASUREMENT_UNAVAILABLE'}));sys.exit(1)
started=time.monotonic();p=subprocess.Popen(command,stdout=sys.stderr,stderr=sys.stderr,start_new_session=True)
failed=False
try:
 while True:
  rss=high=0
  for entry in pids:
   fields={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in (entry/'status').read_text().splitlines() if ':' in line}
   rss+=int(fields['VmRSS'].split()[0])*1024;high+=int(fields['VmHWM'].split()[0])*1024
  samples+=1;peak=max(peak,rss);hwm=max(hwm,high)
  if p.poll() is not None:break
  if time.monotonic()-started>limit:failed=True;break
  time.sleep(.05)
finally:
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 if failed and command[:2]==['sh','infra/seaweedfs/verify-image.sh']:
  subprocess.run(['docker','rm','-f','editagent-seaweed-metadata-'+str(p.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
u=resource.getrusage(resource.RUSAGE_CHILDREN)
if failed or p.returncode!=0:print(json.dumps({'error':'OCI_COMMAND_DEADLINE' if failed else 'OCI_COMMAND_FAILED'}));sys.exit(1)
print(json.dumps({'wall_seconds':time.monotonic()-started,'peak_waited_child_rss_bytes':u.ru_maxrss*1024,'user_cpu_seconds':u.ru_utime,'system_cpu_seconds':u.ru_stime,'deadline_seconds':limit,'daemon':{'observed_processes':len(pids),'samples':samples,'peak_sampled_rss_bytes':peak,'lifetime_hwm_upper_bytes':hwm,'attribution':'shared daemon observations, not import-exclusive or cold-store proof'} if daemon else None}))
`;
  try {
    return JSON.parse(
      run("python3", ["-c", script, JSON.stringify(command), String(timeout), String(daemon)], {
        timeout: (timeout + 25) * 1000,
      }),
    );
  } catch (error) {
    let code = "OCI_COMMAND_RESOURCE_OR_MEASUREMENT_FAILURE";
    try {
      const r = JSON.parse(String(error.stdout));
      if (/^OCI_[A-Z0-9_]+$/.test(r.error)) code = r.error;
    } catch {
      /* bounded public code only */
    }
    throw new AdmissionError(code);
  }
}
export function validateOCIAttempt(r, expected) {
  requireThat(
    r && r.pack && r.encoder && r.decoding && r.validation && r.imported && r.resave && r.budget,
    "OCI_MEASUREMENTS_UNAVAILABLE",
  );
  requireThat(
    r.artifact_uploaded === false && r.production_format_unchanged === true,
    "OCI_PROMOTION_FORBIDDEN",
  );
  const c = r.encoder,
    positive = (n) => Number.isFinite(n) && n > 0;
  requireThat(
    c.profile === OCI_PROFILE &&
      c.algorithm === "xz" &&
      c.preset === 6 &&
      c.check === "CRC64" &&
      isDeepStrictEqual(c.filter_chain, ["LZMA2_PRESET_6"]),
    "OCI_PROFILE_DRIFT",
  );
  requireThat(
    Number.isSafeInteger(c.compressed_bytes) &&
      c.compressed_bytes > 0 &&
      /^[a-f0-9]{64}$/.test(c.output_sha256),
    "OCI_ENCODER_MEASUREMENT_INVALID",
  );
  requireThat(
    c.runtime?.platform === "linux" &&
      c.runtime.implementation === "CPython" &&
      /^\d+\.\d+\.\d+$/.test(c.runtime.python) &&
      /^\d+\.\d+\.\d+$/.test(c.runtime.liblzma),
    "OCI_RUNTIME_UNAVAILABLE",
  );
  requireThat(
    positive(c.process_wall_seconds) &&
      c.process_wall_seconds <= 540 &&
      positive(c.elapsed_seconds) &&
      c.elapsed_seconds <= 540 &&
      positive(c.peak_rss_bytes) &&
      c.peak_rss_bytes <= 1073741824 &&
      Number.isFinite(c.user_cpu_seconds) &&
      c.user_cpu_seconds >= 0 &&
      Number.isFinite(c.system_cpu_seconds) &&
      c.system_cpu_seconds >= 0 &&
      c.user_cpu_seconds + c.system_cpu_seconds <= 480 &&
      c.limits?.address_space_bytes === 1073741824 &&
      c.limits?.cpu_seconds === 480,
    "OCI_ENCODER_RESOURCE_LIMIT",
  );
  const d = r.decoding;
  requireThat(
    positive(d.elapsed_seconds) &&
      d.elapsed_seconds <= 600 &&
      positive(d.peak_rss_bytes) &&
      d.peak_rss_bytes <= 256 * MIB &&
      d.limits?.address_space_bytes === 268435456 &&
      d.uncompressed_bytes === r.pack.layout.bytes &&
      d.uncompressed_bytes <= 4 * 1024 ** 3,
    "OCI_DECODER_RESOURCE_LIMIT",
  );
  for (const phase of [r.pack, r.validation, r.resave]) {
    const m = phase.measurement;
    requireThat(
      m &&
        positive(m.wall_seconds) &&
        m.wall_seconds <= 180 &&
        positive(m.peak_rss_bytes) &&
        m.peak_rss_bytes <= 256 * MIB &&
        Number.isFinite(m.user_cpu_seconds) &&
        m.user_cpu_seconds >= 0 &&
        Number.isFinite(m.system_cpu_seconds) &&
        m.system_cpu_seconds >= 0 &&
        m.user_cpu_seconds + m.system_cpu_seconds <= 120 &&
        m.limits?.address_space_bytes === 268435456 &&
        m.limits?.cpu_seconds === 120,
      "OCI_PARSER_RESOURCE_LIMIT",
    );
  }
  for (const m of [
    r.adapter_verification,
    r.loaded_verification,
    r.import_measurement,
    r.export_measurement,
  ])
    requireThat(
      m &&
        positive(m.wall_seconds) &&
        m.wall_seconds <= m.deadline_seconds &&
        positive(m.peak_waited_child_rss_bytes) &&
        m.peak_waited_child_rss_bytes <= 1073741824,
      "OCI_COMMAND_MEASUREMENT_INVALID",
    );
  requireThat(
    r.import_measurement.daemon?.observed_processes > 0 &&
      r.import_measurement.daemon.peak_sampled_rss_bytes > 0 &&
      r.import_measurement.daemon.lifetime_hwm_upper_bytes > 0,
    "OCI_DAEMON_MEASUREMENT_UNAVAILABLE",
  );
  requireThat(
    r.pack.source_sha256 === expected.source_sha256 &&
      r.pack.image_id === expected.identity.image_id &&
      c.input_sha256 === r.pack.layout.sha256 &&
      r.decoded_sha256 === r.pack.layout.sha256 &&
      r.validation.layout_sha256 === r.pack.layout.sha256 &&
      r.validation.layout_bytes === r.pack.layout.bytes &&
      r.validation.metadata_sha256 === r.pack.metadata_sha256 &&
      r.validation.config_sha256 === expected.identity.config_sha256 &&
      r.validation.image_id === expected.identity.image_id &&
      r.validation.elf_sha256 === expected.identity.elf_sha256,
    "OCI_SOURCE_OR_LAYOUT_DRIFT",
  );
  const ds = r.pack.layers.map((l) => l.diff_id);
  requireThat(
    ds.length === 6 &&
      isDeepStrictEqual(ds, expected.identity.layer_diff_ids) &&
      isDeepStrictEqual(ds, r.validation.ordered_diff_ids) &&
      isDeepStrictEqual(ds, r.imported.RootFS?.Layers) &&
      isDeepStrictEqual(
        ds,
        r.resave.layers.map((l) => l.diff_id),
      ),
    "OCI_ORDERED_DIFFID_DRIFT",
  );
  requireThat(
    r.imported.Id === expected.identity.image_id &&
      r.imported.RootFS?.Type === "layers" &&
      r.imported.Os === "linux" &&
      r.imported.Architecture === "amd64" &&
      r.resave.image_id === expected.identity.image_id &&
      r.resave.config_bytes === r.pack.config_bytes &&
      r.resave.metadata_sha256 === r.pack.metadata_sha256 &&
      isDeepStrictEqual(r.adapter_identity, expected.identity) &&
      isDeepStrictEqual(r.loaded_identity, expected.identity),
    "OCI_IMPORT_OR_RUNTIME_DRIFT",
  );
  const b = transferBudgetReport({
    uncompressed_archive_bytes: r.pack.layout.bytes,
    C: c.compressed_bytes,
    report_file_bytes: r.report_file_bytes,
    compression: c,
  });
  requireThat(
    r.budget.C === b.C &&
      r.budget.R === b.R &&
      r.budget.R_total === b.R_total &&
      r.budget.combined_transfer_bytes === b.combined_transfer_bytes,
    "OCI_BUDGET_ACCOUNTING_DRIFT",
  );
  requireThat(b.within_budget, "OCI_CAPACITY_FAILED");
  const z = ociZipBound(b.C, r.report_file_bytes);
  requireThat(isDeepStrictEqual(z, r.zip_bound), "OCI_ZIP_MEASUREMENT_INVALID");
  requireThat(z.within_reserve, "OCI_ZIP_BOUND_NOT_PROVEN");
}
export async function runBoundedOCIExperiment(expected, attempt, emit) {
  let started = 0;
  const results = [];
  try {
    for (let number = 1; number <= 2; number++) {
      started = number;
      const r = await attempt(number);
      results.push(globalThis.structuredClone(r));
      try {
        validateOCIAttempt(r, expected);
      } catch (error) {
        await emit({
          kind: "OCI_DIAGNOSTIC_ATTEMPT",
          attempt: number,
          qualified: false,
          result: globalThis.structuredClone(r),
          failure: error instanceof AdmissionError ? error.code : "OCI_VALIDATION_FAILED",
        });
        throw error;
      }
      await emit({
        kind: "OCI_DIAGNOSTIC_ATTEMPT",
        attempt: number,
        qualified: false,
        result: globalThis.structuredClone(r),
        outcome: "ATTEMPT_CONDITIONS_PASS",
      });
      if (number === 2)
        requireThat(
          results[0].encoder.output_sha256 === r.encoder.output_sha256 &&
            results[0].pack.layout.sha256 === r.pack.layout.sha256 &&
            isDeepStrictEqual(results[0].encoder.runtime, r.encoder.runtime),
          "OCI_REPRODUCIBILITY_FAILED",
        );
    }
    await emit({
      kind: "OCI_REPRESENTATION_FEASIBILITY",
      verdict: "OCI_REPRESENTATION_FEASIBILITY=MET_DIAGNOSTIC_ONLY",
      attempts: 2,
      qualified: false,
      baseline_disposition: "TRANSFER_BUDGET_EXCEEDED",
      wire_compatibility: "NOT_PROVEN_NO_UPLOAD",
      cold_runner_compatibility: "NOT_PROVEN",
    });
    return "OCI_REPRESENTATION_FEASIBILITY=MET_DIAGNOSTIC_ONLY";
  } catch (error) {
    await emit({
      kind: "OCI_REPRESENTATION_FEASIBILITY",
      verdict: "OCI_REPRESENTATION_FEASIBILITY=NOT_MET",
      attempts: started,
      completed_measurements: results.length,
      qualified: false,
      failure: error instanceof AdmissionError ? error.code : "OCI_RESOURCE_OR_MEASUREMENT_FAILURE",
      observed: error instanceof AdmissionError ? error.ociObserved : undefined,
      baseline_disposition: "TRANSFER_BUDGET_EXCEEDED",
    });
    return "OCI_REPRESENTATION_FEASIBILITY=NOT_MET";
  }
}
async function losslessCompressionProbe(report, work, verification, context) {
  const emit = async (r) => console.log(JSON.stringify(r));
  try {
    requireThat(process.platform === "linux", "OCI_LINUX_REQUIRED");
    const jobs = await pages(`actions/runs/${id(process.env.GITHUB_RUN_ID)}/jobs`, "jobs");
    const matches = jobs.filter(
      (j) =>
        j.name === "image seaweedfs" &&
        j.run_attempt === id(process.env.GITHUB_RUN_ATTEMPT) &&
        j.status === "in_progress",
    );
    requireThat(
      matches.length === 1 && Number.isFinite(Date.parse(matches[0].started_at)),
      "OCI_JOB_DEADLINE_UNAVAILABLE",
    );
    const deadline = Date.parse(matches[0].started_at) + 59 * 60000;
    const remaining = (seconds) =>
      requireThat(deadline - Date.now() >= seconds * 1000, "OCI_REMAINING_JOB_TIME");
    remaining(1500);
    const disk = await statfs(work),
      scratchFree = disk.bavail * disk.bsize;
    const scratchRequired =
      report.uncompressed_archive_bytes + 4 * 4 * 1024 ** 3 + report.C * 2 + 1024 * MIB;
    requireThat(scratchFree >= scratchRequired, "OCI_SCRATCH_LIMIT");
    const dockerVersion = JSON.parse(run("docker", ["version", "--format", "{{json .Server}}"]));
    const dockerInfo = JSON.parse(run("docker", ["info", "--format", "{{json .}}"]));
    const rootDisk = await statfs(dockerInfo.DockerRootDir);
    requireThat(rootDisk.bavail * rootDisk.bsize >= 9 * 1024 ** 3, "OCI_DOCKER_SCRATCH_LIMIT");
    const source = path.join(work, "candidate.tar");
    const old = runOCITool("old-elf", path.join(work, "donor.tar"), path.join(work, "unused"), {});
    const identityExpected = filterIdentity(verification, await archiveIdentity(source));
    const expected = { source_sha256: report.compression.input_sha256, identity: identityExpected };
    const inputExpected = {
      source_sha256: expected.source_sha256,
      image_id: verification.image_id,
      elf_sha256: verification.elf_sha256,
      rust_sha256: verification.rust_sha256,
      old_elf_sha256: old.old_elf_sha256,
    };
    await emit({
      kind: "OCI_DIAGNOSTIC_START",
      profile: OCI_PROFILE,
      context,
      run_id: id(process.env.GITHUB_RUN_ID),
      attempt: id(process.env.GITHUB_RUN_ATTEMPT),
      original: identityExpected,
      source_sha256: expected.source_sha256,
      source_bytes: report.uncompressed_archive_bytes,
      scratch_free_bytes: scratchFree,
      scratch_required_bytes: scratchRequired,
      docker_root_free_bytes: rootDisk.bavail * rootDisk.bsize,
      artifact_uploaded: false,
    });
    await runBoundedOCIExperiment(
      expected,
      async (number) => {
        remaining(1500);
        requireThat(
          isDeepStrictEqual((await identity()).context, context),
          "OCI_LIVE_IDENTITY_DRIFT",
        );
        const raw = path.join(work, `oci-${number}.tar`),
          packed = path.join(work, `oci-${number}.xz`),
          decoded = path.join(work, `oci-${number}-decoded.tar`),
          adapter = path.join(work, `oci-${number}-adapter.tar`),
          loaded = path.join(work, `oci-${number}-loaded.tar`);
        const pack = runOCITool("pack", source, raw, inputExpected);
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "RAW_LAYOUT_PREPARED",
          pack,
          qualified: false,
        });
        remaining(540);
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "ENCODER_START",
          profile: OCI_PROFILE,
          qualified: false,
        });
        const encoder = compressArchive(raw, packed, 6, "python3", OCI_PROFILE);
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "ENCODER_COMPLETE",
          encoder,
          C_cap: 125829120,
          C_within_cap: encoder.compressed_bytes <= 125829120,
          qualified: false,
        });
        requireThat(
          (await fileBytes(packed)) === encoder.compressed_bytes &&
            (await fileDigest(packed)) === encoder.output_sha256,
          "OCI_ENCODER_MEASUREMENT_DRIFT",
        );
        remaining(600);
        const decoding = await decompress(packed, decoded, "python3", 4 * 1024 ** 3, true),
          decoded_sha256 = await fileDigest(decoded);
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "DECODED",
          decoding,
          decoded_sha256,
          qualified: false,
        });
        requireThat(decoded_sha256 === pack.layout.sha256, "OCI_LAYOUT_DIGEST_DRIFT");
        const completeExpected = { ...inputExpected, ...pack };
        remaining(180);
        const validation = runOCITool("validate", decoded, adapter, completeExpected);
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "ADAPTER_PREPARED",
          validation,
          qualified: false,
        });
        remaining(240);
        const inspection = path.join(work, `oci-inspection-${number}`);
        const adapter_verification = measureOCICommand([
          "sh",
          "infra/seaweedfs/verify-image.sh",
          adapter,
          inspection,
        ]);
        const adapter_identity = filterIdentity(
          await jsonFile(path.join(inspection, "verify-image.json")),
          await archiveIdentity(adapter),
        );
        requireThat(
          isDeepStrictEqual(adapter_identity, identityExpected),
          "OCI_ADAPTER_IDENTITY_DRIFT",
        );
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "ADAPTER_VERIFIED",
          adapter_identity,
          adapter_verification,
          qualified: false,
        });
        remaining(120);
        const import_measurement = measureOCICommand(["docker", "load", "-i", adapter], 120, true);
        await emit({
          kind: "OCI_DIAGNOSTIC_STAGE",
          attempt: number,
          stage: "IMPORTED",
          import_measurement,
          qualified: false,
        });
        const importedAll = JSON.parse(
          run("docker", ["image", "inspect", verification.image_id]),
        )[0];
        const imported = {
          Id: importedAll.Id,
          Os: importedAll.Os,
          Architecture: importedAll.Architecture,
          RootFS: importedAll.RootFS,
        };
        remaining(120);
        const export_measurement = measureOCICommand(
          [
            "docker",
            "image",
            "save",
            "--platform",
            "linux/amd64",
            verification.image_id,
            "-o",
            loaded,
          ],
          120,
        );
        remaining(180);
        const resave = runOCITool("resave", loaded, path.join(work, "unused"), {
          ...completeExpected,
          source_sha256: undefined,
        });
        remaining(240);
        const loadedInspection = path.join(work, `oci-loaded-inspection-${number}`);
        const loaded_verification = measureOCICommand([
          "sh",
          "infra/seaweedfs/verify-image.sh",
          loaded,
          loadedInspection,
        ]);
        const loaded_identity = filterIdentity(
          await jsonFile(path.join(loadedInspection, "verify-image.json")),
          await archiveIdentity(loaded),
        );
        requireThat(
          isDeepStrictEqual(loaded_identity, identityExpected),
          "OCI_LOADED_IDENTITY_DRIFT",
        );
        requireThat(
          isDeepStrictEqual((await identity()).context, context),
          "OCI_FINAL_IDENTITY_DRIFT",
        );
        const diagnosticVerification = {
          original: verification,
          adapter: adapter_identity,
          loaded: loaded_identity,
          metadata_sha256: pack.metadata_sha256,
          profile: OCI_PROFILE,
        };
        const diagnosticManifest = {
          schema_version: "1.0.0-draft.1",
          diagnostic_only: true,
          format: OCI_PROFILE,
          context,
          producer: {
            run_id: id(process.env.GITHUB_RUN_ID),
            attempt: id(process.env.GITHUB_RUN_ATTEMPT),
          },
          pack,
          payload: { sha256: encoder.output_sha256, bytes: encoder.compressed_bytes },
          source_reports: report.report_file_bytes,
        };
        const report_file_bytes = {
          ...report.report_file_bytes,
          "verification.json": Buffer.byteLength(JSON.stringify(diagnosticVerification) + "\n"),
          "candidate-manifest.json": Buffer.byteLength(JSON.stringify(diagnosticManifest) + "\n"),
        };
        const budget = transferBudgetReport({
          uncompressed_archive_bytes: pack.layout.bytes,
          C: encoder.compressed_bytes,
          report_file_bytes,
          compression: encoder,
        });
        const result = {
          pack,
          encoder,
          decoding,
          decoded_sha256,
          validation,
          adapter_verification,
          adapter_identity,
          imported,
          import_measurement,
          export_measurement,
          resave,
          loaded_verification,
          loaded_identity,
          report_file_bytes,
          budget,
          zip_bound: ociZipBound(budget.C, report_file_bytes),
          scratch_free_bytes: scratchFree,
          scratch_required_bytes: scratchRequired,
          docker_root_free_bytes: rootDisk.bavail * rootDisk.bsize,
          remaining_job_seconds: Math.floor((deadline - Date.now()) / 1000),
          runtime: {
            docker_version: dockerVersion.Version,
            api_version: dockerVersion.ApiVersion,
            os: dockerVersion.Os,
            architecture: dockerVersion.Arch,
            storage_driver: dockerInfo.Driver,
            python_decoder: "configured producer runtime",
            warm_image_cache: true,
            cold_runner_qualification: "NOT_PROVEN",
          },
          artifact_uploaded: false,
          production_format_unchanged: true,
        };
        for (const f of [raw, packed, decoded, adapter, loaded]) await rm(f);
        await dispose(inspection);
        await dispose(loadedInspection);
        return result;
      },
      emit,
    );
  } catch (error) {
    await emit({
      kind: "OCI_REPRESENTATION_FEASIBILITY",
      verdict: "OCI_REPRESENTATION_FEASIBILITY=NOT_MET",
      attempts: 0,
      qualified: false,
      failure: error instanceof AdmissionError ? error.code : "OCI_RESOURCE_OR_MEASUREMENT_FAILURE",
      baseline_disposition: "TRANSFER_BUDGET_EXCEEDED",
    });
  }
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
  const originalArchiveBytes = await fileBytes(path.join(work, "candidate.tar"));
  const compression = compressArchive(
    path.join(work, "candidate.tar"),
    path.join(folder, "image.tar.xz"),
    6,
  );
  requireThat(
    compression.uncompressed_bytes === originalArchiveBytes,
    "TRANSFER_MEASUREMENT_INVALID",
  );
  const files = {};
  const reportFileBytes = {};
  for (const name of FILES.filter((n) => n !== "candidate-manifest.json")) {
    files[name] = sha256(await readFile(path.join(folder, name)));
    if (name !== "image.tar.xz") reportFileBytes[name] = await fileBytes(path.join(folder, name));
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
  reportFileBytes["candidate-manifest.json"] = Buffer.byteLength(text);
  const C = await fileBytes(path.join(folder, "image.tar.xz"));
  requireThat(compression.compressed_bytes === C, "TRANSFER_MEASUREMENT_INVALID");
  const budget = await reportAndEnforceTransfer(
    {
      uncompressed_archive_bytes: originalArchiveBytes,
      C,
      report_file_bytes: reportFileBytes,
      compression,
    },
    async (report) => {
      console.log(
        JSON.stringify({
          ...report,
          context,
          run_id: id(process.env.GITHUB_RUN_ID),
          attempt: id(process.env.GITHUB_RUN_ATTEMPT),
          image_id: imageId,
        }),
      );
    },
    (report) => losslessCompressionProbe(report, work, verification, context),
  );
  const R = budget.R;
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
