/** Protected-main candidate qualification authority. Never executes PR code. */
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import {
  api,
  canonical,
  hash,
  treeEntries,
  completePages,
  REPO,
  REPOSITORY_ID,
  INTEGRATION,
} from "./pc100-source-verifier.mjs";

export const REGISTRY = "infra/seaweedfs/candidate-policy.json";
export const ENGINE = "tools/test/pc100-candidate-policy.mjs";
export const CANDIDATE_WORKFLOW = ".github/workflows/pc100-candidate-admission.yml";
export const CANDIDATE_JOB = "PC100 candidate source admission";
export const CANDIDATE_TITLE = "PC100 candidate admission";
export const CANDIDATE_SCHEMA = "pc100-security-candidate-admission-v1";
export const CANDIDATE_DECISION = "SECURITY_CANDIDATE_ADMISSION_AUTHORIZED";
export const CANDIDATE_PROFILE = "seaweedfs-go-s-w-production-candidate-v1";
export const LOCK = "infra/seaweedfs/security-build.lock.json";
export const SCANNERS = Object.freeze([
  "infra/scripts/install-supply-chain-tools.sh",
  "infra/scripts/supply-chain-scan-image.sh",
  "infra/scripts/supply-chain-security-gate.sh",
  "infra/scripts/supply-chain-findings.py",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".dockerignore",
]);
const CONTROL = [REGISTRY, ENGINE, CANDIDATE_WORKFLOW, "tools/test/pc100-source-verifier.mjs"];
const fail = (code) => {
  throw new Error(code);
};
const need = (ok, code) => {
  if (!ok) fail(code);
};
const sha = (s) => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const id = (n) => Number.isSafeInteger(n) && n > 0;
function keys(value, names) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      canonical(Object.keys(value).sort()) === canonical([...names].sort()),
    "CANDIDATE_FIELDS_REJECTED",
  );
}
function safePath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 4096 &&
    !p.includes("\\") &&
    !p.startsWith("/") &&
    [...p].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
    p.split("/").every((c) => c && c !== "." && c !== ".." && c !== ".git")
  );
}
export function validateSourceInventory(files) {
  need(
    files &&
      typeof files === "object" &&
      !Array.isArray(files) &&
      Object.keys(files).length > 0 &&
      Object.keys(files).length <= 20000,
    "CANDIDATE_INVENTORY_REJECTED",
  );
  for (const [p, e] of Object.entries(files)) {
    need(safePath(p), "CANDIDATE_INVENTORY_REJECTED");
    keys(e, ["git_blob_sha1", "sha256", "mode", "bytes"]);
    need(
      sha(e.git_blob_sha1) &&
        digest(e.sha256) &&
        ["100644", "100755"].includes(e.mode) &&
        Number.isSafeInteger(e.bytes) &&
        e.bytes >= 0 &&
        e.bytes <= 512 * 1024 ** 2,
      "CANDIDATE_INVENTORY_REJECTED",
    );
  }
  return files;
}
function matches(files, tree, omitRegistry = false) {
  const actual = [...treeEntries(tree)].filter(
    ([, e]) => e.type === "blob" && (!omitRegistry || e.path !== REGISTRY),
  );
  const expected = Object.keys(files)
    .filter((p) => !omitRegistry || p !== REGISTRY)
    .sort();
  need(
    canonical(actual.map(([p]) => p).sort()) === canonical(expected),
    "CANDIDATE_SOURCE_SET_DRIFT",
  );
  for (const [p, e] of actual) {
    const f = files[p];
    need(
      f.git_blob_sha1 === e.sha && f.mode === e.mode && f.bytes === e.size,
      "CANDIDATE_SOURCE_HASH_DRIFT",
    );
  }
}
export function readPolicyJSON(bytes) {
  need(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 ** 2,
    "CANDIDATE_JSON_REJECTED",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Exact canonical or conventional formatted JSON eliminates duplicate keys
  // and ambiguous encodings while allowing normal repository formatting.
  const value = JSON.parse(text);
  need(
    (text === canonical(value) + "\n" || text === JSON.stringify(value, null, 2) + "\n") &&
      !(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191),
    "CANDIDATE_JSON_NONCANONICAL",
  );
  return value;
}
export async function authenticatedBlob(read, entry, cap = 4 * 1024 ** 2) {
  need(
    entry?.type === "blob" &&
      ["100644", "100755"].includes(entry.mode) &&
      sha(entry.sha) &&
      entry.size <= cap,
    "CANDIDATE_BLOB_REJECTED",
  );
  const b = await read(`git/blobs/${entry.sha}`);
  need(
    b.sha === entry.sha &&
      b.encoding === "base64" &&
      Number.isSafeInteger(b.size) &&
      b.size === entry.size &&
      b.size <= cap &&
      typeof b.content === "string" &&
      /^[A-Za-z0-9+/=\r\n]*$/.test(b.content),
    "CANDIDATE_BLOB_REJECTED",
  );
  const bytes = Buffer.from(b.content, "base64");
  need(
    bytes.length === entry.size &&
      createHash("sha1")
        .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
        .digest("hex") === entry.sha,
    "CANDIDATE_BLOB_DIGEST_MISMATCH",
  );
  return bytes;
}
export function validatePinnedLock(lock, entry, bytes) {
  need(
    hash(bytes) === entry.L &&
      hash(canonical(lock.build?.production_contract)) === entry.K &&
      lock.build?.production_contract_sha256 === entry.K,
    "CANDIDATE_LOCK_DRIFT",
  );
  const b = lock.build,
    c = b.production_contract;
  need(
    b.output_profile === CANDIDATE_PROFILE &&
      b.diagnostic_only === false &&
      b.go_version === "go1.26.10" &&
      b.platform === "linux/amd64" &&
      b.CGO_ENABLED === "0" &&
      b.GOAMD64 === "v1" &&
      canonical(b.build_tags) === "[]" &&
      c.profile === CANDIDATE_PROFILE &&
      c.go_version === "go1.26.10" &&
      c.target === "linux/amd64" &&
      c.transport === "docker-save-xz6" &&
      c.flags ===
        "-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=ffa87c2+editagent-sec1 -s -w",
    "CANDIDATE_BUILD_PROFILE_REJECTED",
  );
  need(
    lock.source?.commit === "ffa87c25fdf587178b1521ad87f2a4a72a02e584" &&
      lock.source.sha256 === "d650e7a8a2cbec8a1725386f87f5eb803c95aa84417530aec58c1925fd23a2c9" &&
      lock.toolchain?.tag === "1.26.10-alpine3.24" &&
      lock.toolchain.amd64_digest ===
        "sha256:d1f3216ef30257c850cc136ba42a359ccd9d3e75f19b2c276e520c0b4ef327ce" &&
      lock.toolchain.index_digest ===
        "sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308" &&
      lock.runtime_donor?.image ===
        "chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8" &&
      canonical(c.source) === canonical(lock.source) &&
      canonical(c.compiler) === canonical(lock.toolchain) &&
      canonical(c.modules) === canonical(lock.modules) &&
      canonical(c.runtime_donor) === canonical(lock.runtime_donor),
    "CANDIDATE_DEPENDENCY_DRIFT",
  );
  need(
    lock.modules?.["github.com/go-jose/go-jose/v4"]?.version === "v4.1.6" &&
      lock.modules?.["github.com/andybalholm/brotli"]?.version === "v1.2.7" &&
      canonical(lock.scanners) ===
        canonical({ trivy: "0.75.0", syft: "1.54.0", gitleaks: "8.30.1" }) &&
      canonical(c.scanners) === canonical(lock.scanners),
    "CANDIDATE_DEPENDENCY_DRIFT",
  );
  const limits = {
    candidate_bytes: 125829120,
    provenance_bytes: 16777216,
    total_transfer_bytes: 268435456,
    retention_days: 1,
  };
  need(
    canonical(lock.limits) === canonical(limits) &&
      canonical(c.limits) === canonical(limits) &&
      canonical(Object.keys(lock.trusted_baseline).sort()) === canonical([...SCANNERS].sort()),
    "CANDIDATE_SECURITY_POLICY_DRIFT",
  );
  for (const p of SCANNERS)
    need(entry.files[p]?.sha256 === lock.trusted_baseline[p], "CANDIDATE_SECURITY_POLICY_DRIFT");
}
export function evaluateCandidatePolicy(s) {
  const {
    context: c,
    pr,
    main,
    head,
    merge,
    trustedTree,
    targetTree,
    registry,
    registryBytes,
    reviewed,
    reviewedTree,
    lockBytes,
  } = s;
  need(
    c && ["H", "B", "M", "TH", "TM"].every((k) => sha(c[k])) && c.TH === c.TM,
    "CANDIDATE_IDENTITY_DRIFT",
  );
  need(
    main?.name === "main" &&
      main.protected === true &&
      main.commit?.sha === c.B &&
      main.commit.commit.tree.sha === trustedTree.sha,
    "CANDIDATE_TRUSTED_BASE_DRIFT",
  );
  need(
    pr?.number === 100 &&
      pr.state === "open" &&
      pr.draft === true &&
      !pr.merged &&
      pr.head?.repo?.id === REPOSITORY_ID &&
      pr.base?.repo?.id === REPOSITORY_ID &&
      pr.head.sha === c.H &&
      pr.base.sha === c.B &&
      pr.merge_commit_sha === c.M,
    "CANDIDATE_LIVE_DRIFT",
  );
  need(
    head?.sha === c.H &&
      head.tree.sha === c.TH &&
      targetTree.sha === c.TH &&
      merge?.sha === c.M &&
      merge.tree.sha === c.TM &&
      canonical(merge.parents.map((p) => p.sha)) === canonical([c.B, c.H]),
    "CANDIDATE_IDENTITY_DRIFT",
  );
  keys(registry, ["schema", "repository_id", "pr", "policies"]);
  need(
    registry.schema === "pc100-protected-candidate-policies-v1" &&
      registry.repository_id === REPOSITORY_ID &&
      registry.pr === 100 &&
      Array.isArray(registry.policies) &&
      registry.policies.length <= 16,
    "CANDIDATE_REGISTRY_REJECTED",
  );
  need(
    canonical(readPolicyJSON(registryBytes)) === canonical(registry),
    "CANDIDATE_REGISTRY_REJECTED",
  );
  const base = treeEntries(trustedTree),
    target = treeEntries(targetTree);
  for (const p of CONTROL)
    need(
      base.has(p) &&
        target.has(p) &&
        base.get(p).sha === target.get(p).sha &&
        base.get(p).mode === target.get(p).mode,
      "CANDIDATE_CONTROL_SOURCE_DRIFT",
    );
  const entries = registry.policies.filter((p) => p?.inventory_sha256 === s.requestedInventory);
  need(entries.length === 1, "CANDIDATE_POLICY_MISSING_OR_AMBIGUOUS");
  const entry = entries[0];
  keys(entry, [
    "reviewed_source",
    "inventory_sha256",
    "files",
    "K",
    "L",
    "profile",
    "scope",
    "release_authorized",
  ]);
  keys(entry.reviewed_source, ["commit", "tree"]);
  need(
    sha(entry.reviewed_source.commit) &&
      sha(entry.reviewed_source.tree) &&
      digest(entry.inventory_sha256) &&
      digest(entry.K) &&
      digest(entry.L) &&
      entry.profile === CANDIDATE_PROFILE &&
      entry.scope === "candidate-qualification-only" &&
      entry.release_authorized === false,
    "CANDIDATE_POLICY_REJECTED",
  );
  validateSourceInventory(entry.files);
  need(!Object.hasOwn(entry.files, REGISTRY), "CANDIDATE_CIRCULAR_POLICY_REJECTED");
  need(
    hash(canonical(entry.files)) === entry.inventory_sha256,
    "CANDIDATE_INVENTORY_DIGEST_MISMATCH",
  );
  need(
    reviewed?.sha === entry.reviewed_source.commit &&
      reviewed.tree.sha === entry.reviewed_source.tree &&
      reviewedTree.sha === reviewed.tree.sha,
    "CANDIDATE_REVIEWED_SOURCE_DRIFT",
  );
  matches(entry.files, reviewedTree, true);
  matches(entry.files, targetTree, true);
  for (const p of SCANNERS)
    need(
      base.has(p) &&
        target.has(p) &&
        base.get(p).sha === target.get(p).sha &&
        base.get(p).mode === target.get(p).mode,
      "CANDIDATE_SCANNER_POLICY_DRIFT",
    );
  need(entry.files[LOCK]?.sha256 === hash(lockBytes), "CANDIDATE_LOCK_DRIFT");
  validatePinnedLock(JSON.parse(lockBytes.toString("utf8")), entry, lockBytes);
  const reg = base.get(REGISTRY),
    inventory = {
      ...entry.files,
      [REGISTRY]: {
        git_blob_sha1: reg.sha,
        sha256: hash(registryBytes),
        mode: reg.mode,
        bytes: registryBytes.length,
      },
    };
  return {
    entry,
    inventory,
    decision: {
      schema: CANDIDATE_SCHEMA,
      decision: CANDIDATE_DECISION,
      scope: "candidate-qualification-only",
      candidate_admission_authorized: true,
      release_authorized: false,
      repository_id: REPOSITORY_ID,
      pr: 100,
      ...c,
      profile: CANDIDATE_PROFILE,
      K: entry.K,
      L: entry.L,
      policy_sha256: hash(canonical(entry)),
      registry_sha256: hash(registryBytes),
      inventory_sha256: hash(canonical(inventory)),
      file_count: Object.keys(inventory).length,
      reviewed_source: entry.reviewed_source,
      trusted_workflow_sha: c.B,
    },
  };
}
async function snapshot(context, read) {
  const [main, pr] = await Promise.all([read("branches/main"), read("pulls/100")]);
  const c = context ?? { H: pr.head.sha, B: pr.base.sha, M: pr.merge_commit_sha };
  need(
    sha(c.B) && main.protected === true && main.commit.sha === c.B,
    "CANDIDATE_TRUSTED_BASE_DRIFT",
  );
  const [base, head, merge] = await Promise.all([
    read(`git/commits/${c.B}`),
    read(`git/commits/${c.H}`),
    read(`git/commits/${c.M}`),
  ]);
  need(base.sha === c.B, "CANDIDATE_TRUSTED_BASE_DRIFT");
  const [trustedTree, targetTree] = await Promise.all([
    read(`git/trees/${base.tree.sha}?recursive=1`),
    read(`git/trees/${head.tree.sha}?recursive=1`),
  ]);
  const entries = treeEntries(trustedTree);
  need(
    CONTROL.every((p) => entries.has(p)),
    "CANDIDATE_POLICY_NOT_INSTALLED",
  );
  const registryBytes = await authenticatedBlob(read, entries.get(REGISTRY)),
    registry = readPolicyJSON(registryBytes);
  need(
    registry?.schema === "pc100-protected-candidate-policies-v1" &&
      Array.isArray(registry.policies) &&
      registry.policies.length <= 16,
    "CANDIDATE_REGISTRY_REJECTED",
  );
  need(registry.policies.length > 0, "CANDIDATE_POLICY_NOT_REVIEWED");
  // Only a protected-main entry can nominate reviewed source. A PR-provided
  // inventory/hash or registry is never consulted to grant authority.
  const candidates = [];
  for (const entry of registry.policies) {
    validateSourceInventory(entry.files);
    try {
      matches(entry.files, targetTree, true);
      candidates.push(entry);
    } catch (e) {
      if (!["CANDIDATE_SOURCE_SET_DRIFT", "CANDIDATE_SOURCE_HASH_DRIFT"].includes(e.message))
        throw e;
    }
  }
  need(candidates.length === 1, "CANDIDATE_POLICY_MISSING_OR_AMBIGUOUS");
  const entry = candidates[0];
  const reviewed = await read(`git/commits/${entry.reviewed_source.commit}`),
    reviewedTree = await read(`git/trees/${reviewed.tree.sha}?recursive=1`);
  const lockBytes = await authenticatedBlob(read, treeEntries(targetTree).get(LOCK));
  const full = { ...c, TH: head.tree.sha, TM: merge.tree.sha };
  if (context) need(canonical(full) === canonical(context), "CANDIDATE_IDENTITY_DRIFT");
  return {
    context: full,
    ...evaluateCandidatePolicy({
      context: full,
      main,
      pr,
      head,
      merge,
      trustedTree,
      targetTree,
      registryBytes,
      registry,
      reviewed,
      reviewedTree,
      lockBytes,
      requestedInventory: entry.inventory_sha256,
    }),
  };
}
const requiredKeys = [
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
  "profile",
  "K",
  "L",
  "policy_sha256",
  "registry_sha256",
  "inventory_sha256",
  "file_count",
  "reviewed_source",
  "trusted_workflow_sha",
  "upstream_run",
  "upstream_attempt",
];
export function verifyCandidateRecord(record, expected, run, check, workflow) {
  keys(record, requiredKeys);
  const { upstream_run, upstream_attempt, ...decision } = record;
  need(
    canonical(decision) === canonical(expected) && id(upstream_run) && upstream_attempt === 1,
    "CANDIDATE_EVIDENCE_DRIFT",
  );
  need(
    id(run?.id) &&
      id(run.check_suite_id) &&
      id(workflow?.id) &&
      workflow.path === CANDIDATE_WORKFLOW &&
      run.workflow_id === workflow.id &&
      run.path === CANDIDATE_WORKFLOW &&
      run.event === "workflow_run" &&
      run.head_sha === expected.B &&
      run.run_attempt === 1 &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.id === REPOSITORY_ID &&
      run.head_repository?.id === REPOSITORY_ID,
    "CANDIDATE_EVIDENCE_RUN_REJECTED",
  );
  need(
    check?.app?.id === 15368 &&
      id(check.check_suite?.id) &&
      check.check_suite?.id === run.check_suite_id &&
      check.head_sha === expected.B &&
      check.name === CANDIDATE_JOB &&
      check.status === "completed" &&
      check.conclusion === "success" &&
      id(check.id),
    "CANDIDATE_EVIDENCE_CHECK_REJECTED",
  );
  return {
    evidence_run_id: run.id,
    evidence_run_attempt: 1,
    evidence_check_id: check.id,
    policy_record_sha256: hash(canonical(record)),
  };
}
async function preflight(read, idValue, context) {
  const [run, workflow] = await Promise.all([
    read(`actions/runs/${idValue}`),
    read("actions/workflows/pc100-artifact-integration.yml"),
  ]);
  need(
    run.id === idValue &&
      run.workflow_id === workflow.id &&
      workflow.path === INTEGRATION &&
      run.path === INTEGRATION &&
      run.head_sha === context.H &&
      run.event === "pull_request" &&
      run.run_attempt === 1 &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      run.repository?.id === REPOSITORY_ID &&
      run.head_repository?.id === REPOSITORY_ID &&
      run.pull_requests?.some(
        (p) => p.number === 100 && p.head.sha === context.H && p.base.sha === context.B,
      ),
    "CANDIDATE_PREFLIGHT_REJECTED",
  );
}
async function live(read, c) {
  const [main, pr] = await Promise.all([read("branches/main"), read("pulls/100")]);
  need(
    main.protected === true &&
      main.commit.sha === c.B &&
      pr.head.sha === c.H &&
      pr.base.sha === c.B &&
      pr.merge_commit_sha === c.M &&
      pr.state === "open" &&
      pr.draft === true &&
      !pr.merged,
    "CANDIDATE_LIVE_DRIFT",
  );
}
export async function observeCandidateAdmission(context, read = api) {
  const src = await snapshot(context, read),
    workflow = await read("actions/workflows/pc100-candidate-admission.yml");
  need(workflow.path === CANDIDATE_WORKFLOW && id(workflow.id), "CANDIDATE_WORKFLOW_REJECTED");
  const runs = await completePages(
      read,
      `actions/workflows/${workflow.id}/runs?event=workflow_run&head_sha=${context.B}`,
      "workflow_runs",
    ),
    found = [];
  for (const run of runs) {
    need(
      run.head_sha === context.B &&
        run.workflow_id === workflow.id &&
        run.path === CANDIDATE_WORKFLOW,
      "CANDIDATE_EVIDENCE_RUN_REJECTED",
    );
    if (run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== 1)
      continue;
    const jobs = await completePages(read, `actions/runs/${run.id}/attempts/1/jobs`, "jobs");
    for (const job of jobs.filter((j) => j.name === CANDIDATE_JOB && j.conclusion === "success")) {
      need(
        job.run_id === run.id &&
          job.run_attempt === 1 &&
          job.status === "completed" &&
          /^https:\/\/api\.github\.com\/repos\/mahmoudemad68\/Your_Editor\/check-runs\/[1-9][0-9]*$/.test(
            job.check_run_url,
          ),
        "CANDIDATE_EVIDENCE_JOB_REJECTED",
      );
      const cid = job.check_run_url.split("/").at(-1),
        check = await read(`check-runs/${cid}`),
        annotations = await completePages(read, `check-runs/${cid}/annotations`);
      need(String(check.id) === cid, "CANDIDATE_EVIDENCE_CHECK_REJECTED");
      const records = annotations.filter((a) => a.title === CANDIDATE_TITLE);
      need(records.length === 1, "CANDIDATE_EVIDENCE_MISSING_OR_AMBIGUOUS");
      const record = JSON.parse(records[0].message);
      if (record.H === context.H && record.B === context.B) {
        const proof = verifyCandidateRecord(record, src.decision, run, check, workflow);
        await preflight(read, record.upstream_run, context);
        found.push({
          ...src.decision,
          ...proof,
          file_inventory: src.inventory,
          files: Object.fromEntries(Object.entries(src.inventory).map(([p, e]) => [p, e.sha256])),
        });
      }
    }
  }
  need(found.length <= 1, "CANDIDATE_EVIDENCE_MISSING_OR_AMBIGUOUS");
  if (!found.length) fail("CANDIDATE_EVIDENCE_PENDING");
  await live(read, context);
  return found[0];
}
export async function readCandidateAdmission(
  context,
  read = api,
  timing = { now: Date.now, sleep },
) {
  const end = timing.now() + 120000,
    controller = new globalThis.AbortController();
  const expired = new Promise((_, reject) =>
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("CANDIDATE_EVIDENCE_DEADLINE")),
      { once: true },
    ),
  );
  void expired.catch(() => {});
  const timer = setTimeout(() => controller.abort(), 120000);
  const bounded = async (route) => {
    need(timing.now() < end, "CANDIDATE_EVIDENCE_DEADLINE");
    const result = await Promise.race([
      read === api ? api(route, undefined, controller.signal) : read(route),
      expired,
    ]);
    need(timing.now() < end, "CANDIDATE_EVIDENCE_DEADLINE");
    return result;
  };
  try {
    for (;;) {
      need(timing.now() < end, "CANDIDATE_EVIDENCE_DEADLINE");
      try {
        const result = await observeCandidateAdmission(context, bounded);
        need(timing.now() < end, "CANDIDATE_EVIDENCE_DEADLINE");
        return result;
      } catch (e) {
        if (e.message !== "CANDIDATE_EVIDENCE_PENDING") throw e;
        await Promise.race([timing.sleep(Math.min(3000, end - timing.now())), expired]);
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
export async function verifyCandidateEvent(event, trustedSHA, read = api) {
  need(id(event?.workflow_run?.id) && sha(trustedSHA), "CANDIDATE_EVENT_REJECTED");
  const src = await snapshot(undefined, read);
  need(src.context.B === trustedSHA, "CANDIDATE_TRUSTED_BASE_DRIFT");
  await preflight(read, event.workflow_run.id, src.context);
  await live(read, src.context);
  return { ...src.decision, upstream_run: event.workflow_run.id, upstream_attempt: 1 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    need(
      process.env.GITHUB_EVENT_NAME === "workflow_run" && process.env.GITHUB_REPOSITORY === REPO,
      "CANDIDATE_EVENT_REJECTED",
    );
    const record = await verifyCandidateEvent(
      JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")),
      process.env.TRUSTED_WORKFLOW_SHA,
    );
    console.log(
      `::notice title=${CANDIDATE_TITLE}::${canonical(record).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        outcome: /^[A-Z_]+$/.test(e.message) ? e.message : "CANDIDATE_INTERNAL_FAILURE",
      }),
    );
    process.exitCode = 1;
  }
}

// Qualification credentials belong only to the trusted storage controller.
// Never forward them into API/web/browser child environments.
export function withoutQualificationCredentials(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(GITHUB_TOKEN|GH_TOKEN|PC100_METADATA_TOKEN|ACTIONS_.*|INPUT_GITHUB[-_]TOKEN)$/i.test(
          key,
        ),
    ),
  );
}
