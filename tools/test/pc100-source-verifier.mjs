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
export const BASELINE_SHA = "298abcb83b7f3a3bab68f539c038c8378ea0d3ac";
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
  const result = new Map();
  for (const e of t.tree) {
    need(typeof e.path === "string" && !result.has(e.path), "POLICY_PATH_DUPLICATE");
    result.set(e.path, e);
  }
  return result;
}
function blob(entries, p) {
  const e = entries.get(p);
  need(
    e && e.type === "blob" && ["100644", "100755"].includes(e.mode) && validSHA(e.sha),
    "POLICY_FILE_UNSAFE_OR_MISSING",
  );
  return e;
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
      validSHA(main.commit?.sha) &&
      main.commit.sha === trustedSHA &&
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
    headTree.sha === head.tree.sha &&
      trustedTree.sha === main.commit.commit.tree.sha &&
      baselineTree.sha === s.baseline.tree.sha &&
      s.baseline.sha === BASELINE_SHA,
    "POLICY_TREE_IDENTITY",
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
  const base = treeEntries(baselineTree),
    target = treeEntries(headTree),
    trusted = treeEntries(trustedTree);
  for (const p of BASELINE_FILES)
    need(canonical(blob(base, p)) === canonical(blob(target, p)), "POLICY_BASELINE_TAMPERING");
  for (const p of OWN_FILES)
    need(canonical(blob(trusted, p)) === canonical(blob(target, p)), "POLICY_VERIFIER_TAMPERING");
  return {
    schema: "pc100-development-policy-v1",
    decision: "DEVELOPMENT_SOURCE_VERIFIED",
    scope: "development-only",
    release_authorized: false,
    repository_id: REPOSITORY_ID,
    pr: 100,
    H,
    B,
    M,
    TH: head.tree.sha,
    TM: merge.tree.sha,
    baseline: BASELINE_SHA,
    trusted_workflow_sha: trustedSHA,
    upstream_run: upstream.id,
    upstream_attempt: 1,
  };
}
export function verifyTrustedEvidence(decision, run, check, context, trustedWorkflowId) {
  need(
    decision?.schema === "pc100-development-policy-v1" &&
      decision.decision === "DEVELOPMENT_SOURCE_VERIFIED" &&
      decision.scope === "development-only" &&
      decision.release_authorized === false &&
      decision.baseline === BASELINE_SHA,
    "POLICY_SCOPE_REJECTED",
  );
  need(
    decision.repository_id === REPOSITORY_ID &&
      decision.pr === 100 &&
      ["H", "B", "M", "TH", "TM"].every((k) => decision[k] === context[k]) &&
      decision.TH === decision.TM &&
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
      run.head_repository?.id === REPOSITORY_ID,
    "POLICY_VERIFIER_RUN_REJECTED",
  );
  need(
    check?.app?.id === 15368 &&
      check.check_suite?.id === run.check_suite_id &&
      check.head_sha === run.head_sha &&
      check.name === "PC100 trusted source verification" &&
      check.status === "completed" &&
      check.conclusion === "success",
    "POLICY_VERIFIER_CHECK_REJECTED",
  );
  need(
    decision.profile === "seaweedfs-go-s-w-production-candidate-v1" &&
      /^[a-f0-9]{64}$/.test(decision.K ?? "") &&
      /^[a-f0-9]{64}$/.test(decision.L ?? ""),
    "POLICY_BUILD_CONTRACT",
  );
  need(
    decision.files &&
      Object.keys(decision.files).sort().join("\n") ===
        [...BASELINE_FILES, ...OWN_FILES].sort().join("\n") &&
      Object.values(decision.files).every((s) => /^[a-f0-9]{64}$/.test(s)),
    "POLICY_FILE_MAP_REJECTED",
  );
  return {
    ...decision,
    evidence: { run: run.id, attempt: 1, check: check.id, workflow: trustedWorkflowId },
    record_sha256: hash(canonical(decision)),
  };
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
  need(main.protected && main.commit.sha === context.B, "POLICY_TRUSTED_BASE_DRIFT");
  const commit = await read(`git/commits/${context.B}`),
    tree = treeEntries(await read(`git/trees/${commit.tree.sha}?recursive=1`));
  if (!tree.has(WORKFLOW) || !tree.has(MODULE)) fail("TRUSTED_VERIFIER_NOT_INSTALLED");
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
  const workflow = await read(`actions/workflows/${WORKFLOW.split("/").at(-1)}`);
  need(workflow.path === WORKFLOW, "POLICY_WORKFLOW_REJECTED");
  const runs = await read(`actions/workflows/${workflow.id}/runs?event=workflow_run&per_page=100`);
  need(runs.total_count <= 100, "POLICY_RUN_INVENTORY_INCOMPLETE");
  const found = [];
  for (const run of runs.workflow_runs) {
    if (run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== 1)
      continue;
    const jobs = await read(`actions/runs/${run.id}/attempts/1/jobs?per_page=100`);
    for (const job of jobs.jobs.filter(
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
        annotations = await read(`check-runs/${cid}/annotations?per_page=100`);
      need(annotations.length < 100, "POLICY_ANNOTATIONS_INCOMPLETE");
      const decisions = annotations.filter((a) => a.title === "PC100 development source");
      need(decisions.length === 1, "POLICY_EVIDENCE_MISSING_OR_AMBIGUOUS");
      for (const a of decisions) {
        let v;
        try {
          v = JSON.parse(a.message);
        } catch {
          fail("POLICY_ANNOTATION_INVALID");
        }
        if (v.H === context.H && v.B === context.B)
          found.push(verifyTrustedEvidence(v, run, check, context, workflow.id));
      }
    }
  }
  need(found.length <= 1, "POLICY_EVIDENCE_MISSING_OR_AMBIGUOUS");
  if (!found.length) {
    const pending = await read(
      `actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${context.H}&per_page=100`,
    );
    need(
      pending.total_count <= 1 && pending.workflow_runs.length === pending.total_count,
      "POLICY_PREFLIGHT_AMBIGUOUS",
    );
    if (pending.total_count) {
      const r = pending.workflow_runs[0];
      need(
        r.repository?.id === REPOSITORY_ID &&
          r.head_repository?.id === REPOSITORY_ID &&
          r.path === INTEGRATION &&
          r.event === "pull_request" &&
          r.head_sha === context.H &&
          r.run_attempt === 1 &&
          r.pull_requests?.some(
            (p) => p.number === 100 && p.head.sha === context.H && p.base.sha === context.B,
          ),
        "POLICY_PREFLIGHT_NOT_QUALIFIED",
      );
      need(
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
  const upstream = await read(`actions/runs/${result.upstream_run}`);
  need(
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
async function main() {
  need(process.env.GITHUB_EVENT_NAME === "workflow_run", "POLICY_DEFAULT_EVENT_REQUIRED");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  need(
    Number.isSafeInteger(event.workflow_run?.id) && event.workflow_run.id > 0,
    "POLICY_UPSTREAM_ID",
  );
  const trustedSHA = process.env.TRUSTED_WORKFLOW_SHA;
  need(validSHA(trustedSHA), "POLICY_TRUSTED_SOURCE_REQUIRED");
  const [repo, pr, main, upstream, baseline, trusted] = await Promise.all([
    api(""),
    api("pulls/100"),
    api("branches/main"),
    api(`actions/runs/${Number(event.workflow_run.id)}`),
    api(`git/commits/${BASELINE_SHA}`),
    api(`git/commits/${trustedSHA}`),
  ]);
  need(repo.id === REPOSITORY_ID && repo.default_branch === "main", "POLICY_REPOSITORY");
  const [head, merge, baselineTree, trustedTree] = await Promise.all([
    api(`git/commits/${pr.head.sha}`),
    api(`git/commits/${pr.merge_commit_sha}`),
    api(`git/trees/${baseline.tree.sha}?recursive=1`),
    api(`git/trees/${trusted.tree.sha}?recursive=1`),
  ]);
  const headTree = await api(`git/trees/${head.tree.sha}?recursive=1`);
  const decision = verifySourceSnapshot({
    pr,
    main,
    head,
    merge,
    baseline,
    baselineTree,
    headTree,
    trustedTree,
    upstream,
    trustedSHA,
  });
  const entries = treeEntries(headTree);
  decision.files = {};
  const cache = new Map();
  for (const name of [...BASELINE_FILES, ...OWN_FILES]) {
    const entry = blob(entries, name);
    let raw = cache.get(entry.sha);
    if (!raw) {
      const b = await api(`git/blobs/${entry.sha}`);
      need(b.encoding === "base64" && b.size <= 512 * 1024, "POLICY_BLOB_REJECTED");
      raw = Buffer.from(b.content, "base64");
      need(
        raw.length === b.size &&
          createHash("sha1")
            .update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]))
            .digest("hex") === entry.sha,
        "POLICY_BLOB_DIGEST",
      );
      cache.set(entry.sha, raw);
    }
    decision.files[name] = hash(raw);
  }
  const lock = JSON.parse(
    cache.get(entries.get("infra/seaweedfs/security-build.lock.json").sha).toString("utf8"),
  );
  decision.profile = lock.build.output_profile;
  decision.K = lock.build.production_contract_sha256;
  decision.L = decision.files["infra/seaweedfs/security-build.lock.json"];
  need(
    decision.profile === "seaweedfs-go-s-w-production-candidate-v1" &&
      hash(canonical(lock.build.production_contract)) === decision.K,
    "POLICY_BUILD_CONTRACT",
  );
  const [end, endMain] = await Promise.all([api("pulls/100"), api("branches/main")]);
  need(
    endMain.protected === true &&
      endMain.commit.sha === trustedSHA &&
      end.head.sha === decision.H &&
      end.base.sha === decision.B &&
      end.merge_commit_sha === decision.M,
    "POLICY_LIVE_DRIFT",
  );
  const record = canonical(decision);
  console.log(
    "::notice title=PC100 development source::" +
      record.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A"),
  );
  console.log(
    JSON.stringify({
      outcome: "DEVELOPMENT_SOURCE_VERIFIED",
      H: decision.H,
      B: decision.B,
      TH: decision.TH,
      record_sha256: hash(record),
      production_approval: false,
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
