/** Read-only default-branch verifier. NEVER checks out or executes PR code. */
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { setTimeout as deadlineTimer, clearTimeout as clearDeadline } from "node:timers";
export const REPO = "mahmoudemad68/Your_Editor",
  REPOSITORY_ID = 1395822921;
// Historical protected-main identity for compatibility only. Authority is the
// LIVE protected main B, never a PR-authored content snapshot.
export const BASELINE_SHA = "5cdb1d794d347a36d869027947bb62504dddff92";
export const SOURCE_SCOPE = "complete-tracked-repository-v1";
export const WORKFLOW = ".github/workflows/pc100-source-verifier.yml";
export const MODULE = "tools/test/pc100-source-verifier.mjs";
export const INTEGRATION = ".github/workflows/pc100-artifact-integration.yml";
export const OWN_FILES = Object.freeze([
  WORKFLOW,
  MODULE,
  INTEGRATION,
  "tools/test/pc100-artifact-integration.mjs",
  "tests/architecture/pc100-source-verifier.test.mjs",
]);
// Legacy input/test-vector names, NOT an admission allowlist. sourceInventory
// protects every tracked path; this exported list has no approval authority.
export const BASELINE_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/e2e.yml",
  ".github/workflows/supply-chain.yml",
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
  ".github/actions/pc100-bounded-artifact/action.yml",
  ".github/actions/pc100-bounded-artifact/index.mjs",
]);
const fail = (code) => {
  throw new Error(code);
};
const need = (v, c) => {
  if (!v) fail(c);
};
const validSHA = (s) => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
export const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export const hash = (b) => createHash("sha256").update(b).digest("hex");
export function treeEntries(t) {
  need(
    t && validSHA(t.sha) && t.truncated === false && Array.isArray(t.tree),
    "POLICY_TREE_INCOMPLETE",
  );
  need(t.tree.length <= 20000, "POLICY_TREE_RESOURCE_LIMIT");
  const result = new Map();
  for (const e of t.tree) {
    need(
      typeof e.path === "string" &&
        e.path.length <= 4096 &&
        !e.path.includes("\\") &&
        [...e.path].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
        !e.path.startsWith("/") &&
        e.path.split("/").every((p) => p && p !== "." && p !== ".." && p !== ".git"),
      "POLICY_PATH_UNSAFE",
    );
    need(!result.has(e.path), "POLICY_PATH_DUPLICATE");
    need(validSHA(e.sha), "POLICY_OBJECT_INVALID");
    need(
      (e.type === "tree" && e.mode === "040000") ||
        (e.type === "blob" && ["100644", "100755"].includes(e.mode)),
      "POLICY_FILE_UNSAFE_OR_MISSING",
    );
    result.set(e.path, e);
  }
  return result;
}
// Compare the COMPLETE Git tree, including mode and additions/removals. This
// closes every tracked transitive executable/config dependency, not just a
// guessed list of entrypoints. External submodules and symlinks are unsupported.
export function sourceInventory(t) {
  return Object.fromEntries(
    [...treeEntries(t)]
      .filter(([, e]) => e.type === "blob")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, e]) => [p, { blob_sha1: e.sha, mode: e.mode }]),
  );
}
export function verifySourceSnapshot(s) {
  const { pr, main, head, merge, baselineTree, headTree, trustedTree, upstream, trustedSHA } = s;
  need(
    pr?.number === 100 && pr.state === "open" && pr.draft === true && !pr.merged,
    "POLICY_PR_STATE",
  );
  need(
    pr.head?.repo?.id === REPOSITORY_ID && pr.base?.repo?.id === REPOSITORY_ID,
    "POLICY_REPOSITORY",
  );
  need(
    main?.name === "main" &&
      main.protected === true &&
      validSHA(trustedSHA) &&
      main.commit?.sha === trustedSHA &&
      pr.base.sha === trustedSHA,
    "POLICY_TRUSTED_BASE_DRIFT",
  );
  const H = pr.head.sha,
    B = pr.base.sha,
    M = pr.merge_commit_sha;
  need([H, B, M, head?.tree?.sha, merge?.tree?.sha].every(validSHA), "POLICY_IDENTITY");
  need(
    head.sha === H &&
      merge.sha === M &&
      head.tree.sha === merge.tree.sha &&
      canonical(merge.parents.map((p) => p.sha)) === canonical([B, H]),
    "POLICY_MERGE_IDENTITY",
  );
  need(
    headTree.sha === head.tree.sha && trustedTree.sha === main.commit.commit.tree.sha,
    "POLICY_TREE_IDENTITY",
  );
  // A caller cannot nominate an unprotected PR commit, or its own hashes, as
  // approved policy. No override manifest is accepted by this bootstrap.
  need(
    s.baseline?.sha === B &&
      s.baseline.tree.sha === trustedTree.sha &&
      baselineTree.sha === trustedTree.sha,
    "UNTRUSTED_BASELINE_REJECTED",
  );
  const trusted = sourceInventory(trustedTree),
    target = sourceInventory(headTree);
  need(
    canonical(sourceInventory(baselineTree)) === canonical(trusted),
    "UNTRUSTED_BASELINE_REJECTED",
  );
  need(
    canonical(target) === canonical(trusted) && headTree.sha === trustedTree.sha,
    "UNTRUSTED_SOURCE_REJECTED",
  );
  need(
    upstream?.repository?.id === REPOSITORY_ID &&
      upstream.head_repository?.id === REPOSITORY_ID &&
      upstream.event === "pull_request" &&
      upstream.path === INTEGRATION &&
      upstream.head_sha === H &&
      upstream.run_attempt === 1 &&
      upstream.status === "completed" &&
      upstream.conclusion === "success" &&
      upstream.pull_requests?.some((p) => p.number === 100 && p.head.sha === H && p.base.sha === B),
    "POLICY_PREFLIGHT_NOT_QUALIFIED",
  );
  return {
    schema: "pc100-development-integrity-v2",
    decision: "DEVELOPMENT_SOURCE_INTEGRITY_VERIFIED",
    scope: "development-integrity-only",
    candidate_admission_authorized: false,
    release_authorized: false,
    repository_id: REPOSITORY_ID,
    pr: 100,
    H,
    B,
    M,
    TH: head.tree.sha,
    TM: merge.tree.sha,
    baseline: B,
    trusted_workflow_sha: B,
    source_scope: SOURCE_SCOPE,
    file_count: Object.keys(trusted).length,
    inventory_sha256: hash(canonical(trusted)),
    upstream_run: upstream.id,
    upstream_attempt: 1,
  };
}
const DECISION_KEYS = [
  "schema",
  "decision",
  "scope",
  "candidate_admission_authorized",
  "release_authorized",
  "repository_id",
  "pr",
  "H",
  "B",
  "M",
  "TH",
  "TM",
  "baseline",
  "trusted_workflow_sha",
  "source_scope",
  "file_count",
  "inventory_sha256",
  "upstream_run",
  "upstream_attempt",
].sort();
export function verifyTrustedEvidence(decision, run, check, context, trustedWorkflowId) {
  need(
    decision &&
      canonical(Object.keys(decision).sort()) === canonical(DECISION_KEYS) &&
      decision.schema === "pc100-development-integrity-v2" &&
      decision.decision === "DEVELOPMENT_SOURCE_INTEGRITY_VERIFIED" &&
      decision.scope === "development-integrity-only" &&
      decision.candidate_admission_authorized === false &&
      decision.release_authorized === false &&
      decision.baseline === context.B &&
      decision.source_scope === SOURCE_SCOPE,
    "POLICY_SCOPE_REJECTED",
  );
  need(
    decision.repository_id === REPOSITORY_ID &&
      decision.pr === 100 &&
      ["H", "B", "M", "TH", "TM"].every(
        (k) => validSHA(context[k]) && decision[k] === context[k],
      ) &&
      context.TH === context.TM &&
      decision.trusted_workflow_sha === context.B &&
      decision.upstream_attempt === 1,
    "POLICY_EVIDENCE_IDENTITY",
  );
  need(
    run?.workflow_id === trustedWorkflowId &&
      run.path === WORKFLOW &&
      run.event === "workflow_run" &&
      run.run_attempt === 1 &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.id === REPOSITORY_ID &&
      run.head_repository?.id === REPOSITORY_ID &&
      run.head_sha === context.B,
    "POLICY_VERIFIER_RUN_REJECTED",
  );
  need(
    check?.app?.id === 15368 &&
      check.check_suite?.id === run.check_suite_id &&
      check.head_sha === context.B &&
      check.head_sha === run.head_sha &&
      check.name === "PC100 trusted source verification" &&
      check.status === "completed" &&
      check.conclusion === "success",
    "POLICY_VERIFIER_CHECK_REJECTED",
  );
  need(
    Number.isSafeInteger(decision.file_count) &&
      decision.file_count > 0 &&
      decision.file_count <= 20000 &&
      /^[a-f0-9]{64}$/.test(decision.inventory_sha256 ?? ""),
    "POLICY_FILE_MAP_REJECTED",
  );
  return {
    ...decision,
    evidence: { run: run.id, attempt: 1, check: check.id, workflow: trustedWorkflowId },
    record_sha256: hash(canonical(decision)),
  };
}
// Targeted, complete pagination. A truncated page, unstable total, duplicate ID,
// API error or bounded resource exhaustion can never produce a trusted result.
export async function completePages(read, route, field) {
  const rows = [],
    seen = new Set();
  let total;
  for (let page = 1; page <= 40; page++) {
    const data = await read(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const chunk = field ? data[field] : data;
    need(Array.isArray(chunk) && chunk.length <= 100, "POLICY_PAGE_INCOMPLETE");
    if (field) {
      need(
        Number.isSafeInteger(data.total_count) && data.total_count >= 0 && data.total_count <= 4000,
        "POLICY_INVENTORY_RESOURCE_LIMIT",
      );
      if (total === undefined) total = data.total_count;
      need(
        data.total_count === total && chunk.length === Math.min(100, total - rows.length),
        "POLICY_PAGE_INCOMPLETE",
      );
    }
    for (const item of chunk) {
      const key = field ? item.id : hash(canonical(item));
      need(
        (!field || (Number.isSafeInteger(key) && key > 0)) && !seen.has(key),
        "POLICY_PAGE_DUPLICATE",
      );
      seen.add(key);
      rows.push(item);
    }
    if (field ? rows.length === total : chunk.length < 100) return rows;
  }
  fail("POLICY_INVENTORY_RESOURCE_LIMIT");
}
export async function api(
  route,
  token = process.env.PC100_METADATA_TOKEN !== undefined
    ? process.env.PC100_METADATA_TOKEN
    : process.env.GITHUB_TOKEN,
  signal,
) {
  need(
    typeof route === "string" &&
      !route.startsWith("/") &&
      !route.includes("..") &&
      !/[\r\n#]/.test(route),
    "POLICY_API_ROUTE",
  );
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token !== undefined) {
    need(
      typeof token === "string" && /^[A-Za-z0-9_.-]{1,4096}$/.test(token),
      "POLICY_TOKEN_INVALID",
    );
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await globalThis.fetch(
    `https://api.github.com/repos/${REPO}${route ? "/" + route : ""}`,
    {
      headers,
      redirect: "error",
      signal: signal
        ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(15000)])
        : globalThis.AbortSignal.timeout(15000),
    },
  );
  need(response.status === 200, "POLICY_API_UNAVAILABLE");
  let count = 0;
  const chunks = [];
  for await (const b of response.body) {
    count += b.length;
    need(count <= 2 * 1024 * 1024, "POLICY_API_OVERSIZE");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function observeTrustedEvidence(context, read = api) {
  const main = await read("branches/main");
  need(main.protected === true && main.commit.sha === context.B, "POLICY_TRUSTED_BASE_DRIFT");
  const commit = await read(`git/commits/${context.B}`),
    rawTree = await read(`git/trees/${commit.tree.sha}?recursive=1`),
    tree = treeEntries(rawTree);
  if (!tree.has(WORKFLOW) || !tree.has(MODULE)) fail("TRUSTED_VERIFIER_NOT_INSTALLED");
  const trustedFiles = sourceInventory(rawTree);
  const live = await read("pulls/100");
  need(
    live.head.sha === context.H &&
      live.base.sha === context.B &&
      live.merge_commit_sha === context.M &&
      live.state === "open" &&
      live.draft === true &&
      !live.merged,
    "POLICY_LIVE_DRIFT",
  );
  const workflow = await read("actions/workflows/pc100-source-verifier.yml");
  need(workflow.path === WORKFLOW && Number.isSafeInteger(workflow.id), "POLICY_WORKFLOW_REJECTED");
  const runs = await completePages(
    read,
    `actions/workflows/${workflow.id}/runs?event=workflow_run&head_sha=${context.B}`,
    "workflow_runs",
  );
  const found = [];
  for (const run of runs) {
    need(
      run.head_sha === context.B &&
        run.workflow_id === workflow.id &&
        run.path === WORKFLOW &&
        run.repository?.id === REPOSITORY_ID &&
        run.head_repository?.id === REPOSITORY_ID,
      "POLICY_VERIFIER_RUN_REJECTED",
    );
    if (run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== 1)
      continue;
    const jobs = await completePages(read, `actions/runs/${run.id}/attempts/1/jobs`, "jobs");
    for (const job of jobs.filter(
      (j) => j.name === "PC100 trusted source verification" && j.conclusion === "success",
    )) {
      need(
        /^https:\/\/api\.github\.com\/repos\/mahmoudemad68\/Your_Editor\/check-runs\/[1-9][0-9]*$/.test(
          job.check_run_url,
        ),
        "POLICY_CHECK_URL",
      );
      need(
        job.run_id === run.id && job.run_attempt === 1 && job.status === "completed",
        "POLICY_JOB_REJECTED",
      );
      const cid = job.check_run_url.split("/").at(-1),
        check = await read(`check-runs/${cid}`),
        annotations = await completePages(read, `check-runs/${cid}/annotations`);
      const decisions = annotations.filter((a) => a.title === "PC100 development source");
      need(decisions.length === 1, "POLICY_EVIDENCE_MISSING_OR_AMBIGUOUS");
      let v;
      try {
        v = JSON.parse(decisions[0].message);
      } catch {
        fail("POLICY_ANNOTATION_INVALID");
      }
      if (v.H === context.H && v.B === context.B) {
        const verified = verifyTrustedEvidence(v, run, check, context, workflow.id);
        need(
          v.inventory_sha256 === hash(canonical(trustedFiles)) &&
            v.file_count === Object.keys(trustedFiles).length &&
            context.TH === rawTree.sha,
          "UNTRUSTED_SOURCE_REJECTED",
        );
        found.push(verified);
      }
    }
  }
  need(found.length <= 1, "POLICY_EVIDENCE_MISSING_OR_AMBIGUOUS");
  if (!found.length) {
    const pending = await completePages(
      read,
      `actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${context.H}`,
      "workflow_runs",
    );
    need(pending.length <= 1, "POLICY_PREFLIGHT_AMBIGUOUS");
    if (pending.length) {
      const r = pending[0];
      need(
        r.repository?.id === REPOSITORY_ID &&
          r.head_repository?.id === REPOSITORY_ID &&
          r.path === INTEGRATION &&
          r.event === "pull_request" &&
          r.head_sha === context.H &&
          r.run_attempt === 1 &&
          r.pull_requests?.some(
            (p) => p.number === 100 && p.head.sha === context.H && p.base.sha === context.B,
          ) &&
          ["queued", "in_progress", "requested", "waiting", "pending", "completed"].includes(
            r.status,
          ) &&
          (r.status !== "completed" || r.conclusion === "success"),
        "POLICY_PREFLIGHT_NOT_QUALIFIED",
      );
    }
    fail("POLICY_EVIDENCE_PENDING");
  }
  const result = found[0];
  need(Number.isSafeInteger(result.upstream_run) && result.upstream_run > 0, "POLICY_UPSTREAM_ID");
  const upstream = await read(`actions/runs/${result.upstream_run}`),
    integration = await read("actions/workflows/pc100-artifact-integration.yml");
  need(
    upstream.id === result.upstream_run &&
      upstream.workflow_id === integration.id &&
      integration.path === INTEGRATION &&
      upstream.path === INTEGRATION &&
      upstream.event === "pull_request" &&
      upstream.head_sha === context.H &&
      upstream.run_attempt === 1 &&
      upstream.status === "completed" &&
      upstream.conclusion === "success" &&
      upstream.repository?.id === REPOSITORY_ID &&
      upstream.head_repository?.id === REPOSITORY_ID &&
      upstream.pull_requests?.some(
        (p) => p.number === 100 && p.head.sha === context.H && p.base.sha === context.B,
      ),
    "POLICY_PREFLIGHT_NOT_QUALIFIED",
  );
  const [finalMain, finalPR] = await Promise.all([read("branches/main"), read("pulls/100")]);
  need(
    finalMain.protected === true &&
      finalMain.commit.sha === context.B &&
      finalPR.head.sha === context.H &&
      finalPR.base.sha === context.B &&
      finalPR.merge_commit_sha === context.M &&
      finalPR.state === "open" &&
      finalPR.draft === true &&
      !finalPR.merged,
    "POLICY_LIVE_DRIFT",
  );
  return result;
}
// Read-only reconciliation inside the original admission attempt. Never retries
// a workflow, a failed preflight, ambiguous evidence, or an ordinary test error.
export async function readTrustedEvidence(context, read = api, timing = { now: Date.now, sleep }) {
  const deadline = timing.now() + 120000;
  const controller = new globalThis.AbortController();
  const expired = new Promise((_, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("POLICY_EVIDENCE_DEADLINE")),
      { once: true },
    ),
  );
  void expired.catch(() => {});
  const timer = deadlineTimer(() => controller.abort(), 120000);
  const boundedRead = async (route) => {
    need(timing.now() < deadline, "POLICY_EVIDENCE_DEADLINE");
    const value = await Promise.race([
      read === api ? api(route, undefined, controller.signal) : read(route),
      expired,
    ]);
    need(timing.now() < deadline, "POLICY_EVIDENCE_DEADLINE");
    return value;
  };
  try {
    for (;;) {
      need(timing.now() < deadline, "POLICY_EVIDENCE_DEADLINE");
      try {
        const result = await observeTrustedEvidence(context, boundedRead);
        need(timing.now() < deadline, "POLICY_EVIDENCE_DEADLINE");
        return result;
      } catch (error) {
        if (error.message !== "POLICY_EVIDENCE_PENDING") throw error;
        const remaining = deadline - timing.now();
        need(remaining > 0, "POLICY_EVIDENCE_DEADLINE");
        await Promise.race([timing.sleep(Math.min(3000, remaining)), expired]);
      }
    }
  } finally {
    clearDeadline(timer);
    controller.abort();
  }
}
export async function verifyEvent(event, trustedSHA, read = api) {
  need(
    Number.isSafeInteger(event.workflow_run?.id) && event.workflow_run.id > 0,
    "POLICY_UPSTREAM_ID",
  );
  need(validSHA(trustedSHA), "POLICY_TRUSTED_SOURCE_REQUIRED");
  const [repo, pr, main, upstream, trusted, integration] = await Promise.all([
    read(""),
    read("pulls/100"),
    read("branches/main"),
    read(`actions/runs/${event.workflow_run.id}`),
    read(`git/commits/${trustedSHA}`),
    read("actions/workflows/pc100-artifact-integration.yml"),
  ]);
  need(repo.id === REPOSITORY_ID && repo.default_branch === "main", "POLICY_REPOSITORY");
  need(
    upstream.id === event.workflow_run.id &&
      upstream.workflow_id === integration.id &&
      integration.path === INTEGRATION,
    "POLICY_PREFLIGHT_NOT_QUALIFIED",
  );
  const [head, merge, trustedTree] = await Promise.all([
    read(`git/commits/${pr.head.sha}`),
    read(`git/commits/${pr.merge_commit_sha}`),
    read(`git/trees/${trusted.tree.sha}?recursive=1`),
  ]);
  const headTree = await read(`git/trees/${head.tree.sha}?recursive=1`);
  const decision = verifySourceSnapshot({
    pr,
    main,
    upstream,
    trustedSHA,
    head,
    merge,
    trustedTree,
    headTree,
    baseline: trusted,
    baselineTree: trustedTree,
  });
  const [end, endMain] = await Promise.all([read("pulls/100"), read("branches/main")]);
  need(
    endMain.protected === true &&
      endMain.commit.sha === trustedSHA &&
      end.head.sha === decision.H &&
      end.base.sha === decision.B &&
      end.merge_commit_sha === decision.M,
    "POLICY_LIVE_DRIFT",
  );
  return decision;
}
async function main() {
  need(process.env.GITHUB_EVENT_NAME === "workflow_run", "POLICY_DEFAULT_EVENT_REQUIRED");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const decision = await verifyEvent(event, process.env.TRUSTED_WORKFLOW_SHA);
  const record = canonical(decision);
  // No candidate profile, ELF contract, seal, approval, status write or upload.
  console.log(
    "::notice title=PC100 development source::" +
      record.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A"),
  );
  console.log(
    JSON.stringify({
      outcome: decision.decision,
      H: decision.H,
      B: decision.B,
      TH: decision.TH,
      inventory_sha256: decision.inventory_sha256,
      candidate_admission_authorized: false,
      release_authorized: false,
    }),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(
      JSON.stringify({
        outcome: "TRUSTED_POLICY_REJECTED",
        code: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "POLICY_INTERNAL_FAILURE",
      }),
    );
    process.exitCode = 1;
  });
