/** Synthetic GitHub/Git inputs only. Never a real policy or qualification receipt. */
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { canonical, hash } from "../../../tools/test/pc100-source-verifier.mjs";
import { TRUST_CONFIG, ATTESTATION_ENGINE } from "../../../tools/test/pc100-app-attestation.mjs";
import {
  REGISTRY,
  APP_CONFIG,
  APP_ENGINE,
  APP_CHECK,
  ENGINE,
  LOCK,
  SCANNERS,
  CANDIDATE_WORKFLOW,
  REQUIRED_WORKFLOW,
  REQUIRED_JOB,
  CANDIDATE_JOB,
  CANDIDATE_TITLE,
  evaluateCandidatePolicy,
} from "../../../tools/test/pc100-candidate-policy.mjs";
export const blobSHA = (b) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]))
    .digest("hex");
export function sampleLock() {
  const source = {
    commit: "ffa87c25fdf587178b1521ad87f2a4a72a02e584",
    sha256: "d650e7a8a2cbec8a1725386f87f5eb803c95aa84417530aec58c1925fd23a2c9",
  };
  const modules = {
    "github.com/go-jose/go-jose/v4": { version: "v4.1.6" },
    "github.com/andybalholm/brotli": { version: "v1.2.7" },
  };
  const scanners = { trivy: "0.75.0", syft: "1.54.0", gitleaks: "8.30.1" };
  const limits = {
    candidate_bytes: 125829120,
    provenance_bytes: 16777216,
    total_transfer_bytes: 268435456,
    retention_days: 1,
  };
  const toolchain = {
      tag: "1.26.10-alpine3.24",
      amd64_digest: "sha256:d1f3216ef30257c850cc136ba42a359ccd9d3e75f19b2c276e520c0b4ef327ce",
      index_digest: "sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308",
    },
    runtime_donor = {
      image:
        "chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8",
    };
  const production_contract = {
    source,
    modules,
    compiler: toolchain,
    runtime_donor,
    go_version: "go1.26.10",
    target: "linux/amd64",
    profile: "seaweedfs-go-s-w-production-candidate-v1",
    transport: "docker-save-xz6",
    flags:
      "-extldflags -static -X github.com/seaweedfs/seaweedfs/weed/util/version.COMMIT=ffa87c2+editagent-sec1 -s -w",
    scanners,
    limits,
  };
  return {
    source,
    modules,
    toolchain,
    runtime_donor,
    scanners,
    limits,
    trusted_baseline: Object.fromEntries(
      SCANNERS.map((p) => [p, hash(Buffer.from(`synthetic:${p}`))]),
    ),
    build: {
      platform: "linux/amd64",
      go_version: "go1.26.10",
      CGO_ENABLED: "0",
      GOAMD64: "v1",
      build_tags: [],
      output_profile: production_contract.profile,
      diagnostic_only: false,
      production_contract,
      production_contract_sha256: hash(canonical(production_contract)),
    },
  };
}
export function candidateFixture({ context, fileBytes, lock = sampleLock(), appConfig } = {}) {
  const c = context ?? {
    H: "a".repeat(40),
    B: "b".repeat(40),
    M: "c".repeat(40),
    TH: "d".repeat(40),
    TM: "d".repeat(40),
  };
  const rt = "7".repeat(40),
    bt = "6".repeat(40),
    R = "5".repeat(40);
  const content = fileBytes
    ? Object.fromEntries(Object.entries(fileBytes).map(([p, b]) => [p, Buffer.from(b)]))
    : Object.fromEntries(
        [
          REGISTRY,
          TRUST_CONFIG,
          ATTESTATION_ENGINE,
          APP_CONFIG,
          APP_ENGINE,
          ENGINE,
          CANDIDATE_WORKFLOW,
          REQUIRED_WORKFLOW,
          "tools/test/pc100-source-verifier.mjs",
          LOCK,
          ...SCANNERS,
          "infra/seaweedfs/docker-entrypoint.sh",
          "infra/seaweedfs/apply-container-firewall.sh",
          "infra/seaweedfs/apply-host-isolation.sh",
          "infra/seaweedfs/ensure-storage-network.sh",
          "infra/seaweedfs/verify-trust-boundary.sh",
          "infra/seaweedfs/storage-network.env",
          "compose.yml",
          "package.json",
          "pnpm-lock.yaml",
        ].map((p) => [p, Buffer.from(`synthetic:${p}`)]),
      );
  const lockBytes = fileBytes?.[LOCK]
    ? Buffer.from(fileBytes[LOCK])
    : Buffer.from(JSON.stringify(lock) + "\n");
  content[LOCK] = lockBytes;
  content[".github/workflows/supply-chain.yml"] ??= readFileSync(
    new URL("../../../.github/workflows/supply-chain.yml", import.meta.url),
  );
  content[APP_ENGINE] ??= Buffer.from("synthetic:independent-app-engine");
  const app = appConfig ?? {
    schema: "pc100-independent-app-v1",
    repository_id: 1395822921,
    app_id: 246810,
    installation_id: 12345,
    slug: "independent-test-only",
    check_name: APP_CHECK,
  };
  content[APP_CONFIG] = Buffer.from(canonical(app) + "\n");
  const record = (b) => ({
    git_blob_sha1: blobSHA(b),
    sha256: hash(b),
    mode: "100644",
    bytes: b.length,
  });
  const files = Object.fromEntries(
    Object.entries(content)
      .filter(([p]) => p !== REGISTRY)
      .map(([p, b]) => [p, record(b)]),
  );
  const entry = {
    reviewed_source: { commit: R, tree: rt },
    expected_elf_sha256: "e".repeat(64),
    inventory_sha256: hash(canonical(files)),
    files,
    K: lock.build.production_contract_sha256,
    L: hash(lockBytes),
    profile: "seaweedfs-go-s-w-production-candidate-v1",
    scope: "candidate-qualification-only",
    release_authorized: false,
  };
  const registry = {
      schema: "pc100-protected-candidate-policies-v1",
      repository_id: 1395822921,
      pr: 100,
      policies: [entry],
    },
    registryBytes = Buffer.from(canonical(registry) + "\n");
  content[REGISTRY] = registryBytes;
  const tree = (sha) => ({
    sha,
    truncated: false,
    tree: Object.entries(content).map(([path, b]) => ({
      path,
      type: "blob",
      mode: "100644",
      sha: blobSHA(b),
      size: b.length,
    })),
  });
  const main = {
    name: "main",
    protected: true,
    commit: { sha: c.B, commit: { tree: { sha: bt } } },
  };
  const pr = {
    number: 100,
    state: "open",
    draft: true,
    merged: false,
    head: { sha: c.H, ref: "fix/ci-ffmpeg-seaweedfs-security", repo: { id: 1395822921 } },
    base: { sha: c.B, ref: "main", repo: { id: 1395822921 } },
    merge_commit_sha: c.M,
  };
  const head = { sha: c.H, tree: { sha: c.TH } },
    merge = { sha: c.M, tree: { sha: c.TM }, parents: [{ sha: c.B }, { sha: c.H }] },
    reviewed = { sha: R, tree: { sha: rt } },
    trustedTree = tree(bt),
    targetTree = tree(c.TH),
    reviewedTree = tree(rt);
  const snapshot = {
    context: c,
    sourceBytes: content,
    main,
    pr,
    head,
    merge,
    reviewed,
    reviewedTree,
    trustedTree,
    targetTree,
    registry,
    registryBytes,
    lockBytes,
    requestedInventory: entry.inventory_sha256,
  };
  const result = evaluateCandidatePolicy(snapshot),
    decision = { ...result.decision, upstream_run: 130, upstream_attempt: 1 };
  const run = {
    id: 123,
    workflow_id: 80,
    path: CANDIDATE_WORKFLOW,
    event: "workflow_run",
    head_sha: c.B,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    repository: { id: 1395822921 },
    head_repository: { id: 1395822921 },
    check_suite_id: 125,
  };
  const check = {
    id: 124,
    app: { id: 15368 },
    check_suite: { id: 125 },
    head_sha: c.B,
    name: CANDIDATE_JOB,
    status: "completed",
    conclusion: "success",
  };
  const upstream = {
    id: 130,
    workflow_id: 99,
    path: ".github/workflows/pc100-artifact-integration.yml",
    event: "pull_request",
    head_branch: "fix/ci-ffmpeg-seaweedfs-security",
    head_sha: c.H,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    repository: { id: 1395822921 },
    head_repository: { id: 1395822921 },
    pull_requests: [
      {
        number: 100,
        head: { sha: c.H, ref: "fix/ci-ffmpeg-seaweedfs-security" },
        base: { sha: c.B, ref: "main" },
      },
    ],
  };
  const rows = {
    "rules/branches/main": [
      {
        type: "required_status_checks",
        ruleset_id: 77,
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: APP_CHECK, integration_id: app.app_id },
            { context: "ci", integration_id: 15368 },
            { context: "supply-chain-security", integration_id: 15368 },
          ],
        },
      },
    ],
    "branches/main": main,
    "pulls/100": pr,
    [`git/commits/${c.B}`]: { sha: c.B, tree: { sha: bt } },
    [`git/commits/${c.H}`]: head,
    [`git/commits/${c.M}`]: merge,
    [`git/commits/${R}`]: reviewed,
    [`git/trees/${bt}?recursive=1`]: trustedTree,
    [`git/trees/${c.TH}?recursive=1`]: targetTree,
    [`git/trees/${rt}?recursive=1`]: reviewedTree,
    "actions/workflows/pc100-candidate-admission.yml": { id: 80, path: CANDIDATE_WORKFLOW },
    [`actions/workflows/80/runs?event=workflow_run&head_sha=${c.B}&per_page=100&page=1`]: {
      total_count: 1,
      workflow_runs: [run],
    },
    "actions/runs/123/attempts/1/jobs?per_page=100&page=1": {
      total_count: 1,
      jobs: [
        {
          id: 126,
          name: CANDIDATE_JOB,
          run_id: 123,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          check_run_url: "https://api.github.com/repos/mahmoudemad68/Your_Editor/check-runs/124",
        },
      ],
    },
    "check-runs/124": check,
    "check-runs/124/annotations?per_page=100&page=1": [
      { title: CANDIDATE_TITLE, message: canonical(decision) },
    ],
    "actions/runs/130": upstream,
    "actions/workflows/pc100-artifact-integration.yml": { id: 99, path: upstream.path },
  };
  Object.defineProperty(rows, "rules/branches/main?per_page=100&page=1", {
    enumerable: true,
    get: () => rows["rules/branches/main"],
  });
  rows["branches/main/protection"] = {
    enforce_admins: { enabled: true },
    required_status_checks: { strict: true },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  rows["rulesets/77"] = { id: 77, enforcement: "active", target: "branch", bypass_actors: [] };
  rows[
    `actions/workflows/pc100-artifact-integration.yml/runs?event=pull_request&head_sha=${c.H}&per_page=100&page=1`
  ] = { total_count: 1, workflow_runs: [upstream] };
  const requiredRun = {
    ...upstream,
    id: 140,
    workflow_id: 81,
    path: REQUIRED_WORKFLOW,
    check_suite_id: 141,
  };
  rows["actions/runs/140"] = requiredRun;
  rows["actions/workflows/pc100-required-admission.yml"] = { id: 81, path: REQUIRED_WORKFLOW };
  rows[`actions/workflows/81/runs?event=pull_request&head_sha=${c.H}&per_page=100&page=1`] = {
    total_count: 1,
    workflow_runs: [requiredRun],
  };
  rows["actions/runs/140/attempts/1/jobs?per_page=100&page=1"] = {
    total_count: 1,
    jobs: [
      {
        id: 142,
        name: REQUIRED_JOB,
        run_id: 140,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        check_run_url: "https://api.github.com/repos/mahmoudemad68/Your_Editor/check-runs/143",
      },
    ],
  };
  rows["check-runs/143"] = {
    id: 143,
    name: APP_CHECK,
    head_sha: c.H,
    app: { id: app.app_id, slug: app.slug },
    check_suite: { id: 141 },
    status: "completed",
    conclusion: "success",
    completed_at: new Date().toISOString(),
    external_id: hash(canonical(decision)),
    output: { title: CANDIDATE_TITLE, summary: canonical(decision) + "\n" },
  };
  rows[
    `commits/${c.H}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all&per_page=100&page=1`
  ] = { total_count: 1, check_runs: [rows["check-runs/143"]] };
  rows["check-suites/141"] = {
    id: 141,
    app: { id: app.app_id },
    head_sha: c.H,
    repository: { id: 1395822921 },
  };
  rows["check-runs/143/annotations?per_page=100&page=1"] = [
    { title: CANDIDATE_TITLE, message: canonical(decision) },
  ];
  for (const b of Object.values(content))
    rows[`git/blobs/${blobSHA(b)}`] = {
      sha: blobSHA(b),
      encoding: "base64",
      size: b.length,
      content: b.toString("base64"),
    };
  const read = async (route) => {
    if (!Object.hasOwn(rows, route)) throw Error(`Unexpected fixture read: ${route}`);
    return rows[route];
  };
  return {
    context: c,
    content,
    entry,
    snapshot,
    registry,
    registryBytes,
    decision,
    result,
    run,
    check,
    upstream,
    rows,
    read,
  };
}

// MOCK GraphQL replay: no installed App/private endpoint qualification.
export function branchBypassFixture(B) {
  const ref = {
    id: "REF_SYNTHETIC_MAIN",
    name: "main",
    prefix: "refs/heads/",
    target: { __typename: "Commit", oid: B },
  };
  const connection = (nodes) => ({
    totalCount: nodes.length,
    nodes,
    edges: nodes.map((node, i) => ({ cursor: `cursor${i}`, node })),
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: nodes.length ? "cursor0" : null,
      endCursor: nodes.length ? `cursor${nodes.length - 1}` : null,
    },
  });
  const rule = {
    id: "BPR_SYNTHETIC_MAIN",
    databaseId: 10,
    pattern: "main",
    matchingRefs: connection([ref]),
    bypassPullRequestAllowances: connection([]),
  };
  return {
    data: {
      repository: {
        id: "R_kgDOUzKRSQ",
        databaseId: 1395822921,
        nameWithOwner: "mahmoudemad68/Your_Editor",
        ref: { ...ref, branchProtectionRule: { id: rule.id, databaseId: 10, pattern: "main" } },
        branchProtectionRules: connection([rule]),
      },
    },
  };
}

// Exact synthetic shape for the protected-main, native attempt1 full Supply job set.
export function supplyJobsFixture(f, r) {
  const names = [
    "Case-exact release authorization",
    "dependencies",
    ...[
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
    ].map((n) => "image " + n),
    "supply-chain-security",
    "publish ${{ matrix.service }}",
    "release manifest",
    "owner-approved staging",
  ];
  r.check_suite_id = 9000;
  const jobs = names.map((name, i) => ({
    id: 10000 + i,
    name,
    run_id: r.id,
    run_attempt: 1,
    status: "completed",
    conclusion: i >= 14 ? "skipped" : "success",
    check_run_url: `https://api.github.com/repos/mahmoudemad68/Your_Editor/check-runs/${11000 + i}`,
  }));
  f.rows[`actions/runs/${r.id}/attempts/1/jobs?per_page=100&page=1`] = {
    total_count: jobs.length,
    jobs,
  };
  f.rows["check-suites/9000"] = {
    id: 9000,
    head_sha: r.head_sha,
    app: { id: 15368 },
    repository: { id: 1395822921 },
  };
  for (const [i, j] of jobs.entries())
    f.rows[`check-runs/${11000 + i}`] = {
      id: 11000 + i,
      name: j.name,
      head_sha: r.head_sha,
      app: { id: 15368 },
      check_suite: { id: 9000 },
      status: j.status,
      conclusion: j.conclusion,
    };
  return jobs;
}
