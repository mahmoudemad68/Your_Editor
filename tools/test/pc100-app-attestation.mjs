/** Offline-testable independent authority contracts. No key lookup, writes or network transport. */
import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonical,
  hash,
  treeEntries,
  sourceInventory,
  completePages,
  REPOSITORY_ID,
} from "./pc100-source-verifier.mjs";

export const TRUST_CONFIG = "infra/seaweedfs/app-trust.json";
export const ATTESTATION_ENGINE = "tools/test/pc100-app-attestation.mjs";
export const CONTROL_PATHS = Object.freeze([
  "infra/seaweedfs/candidate-app.json",
  "infra/seaweedfs/candidate-policy.json",
  TRUST_CONFIG,
  "tools/test/pc100-source-verifier.mjs",
  "tools/test/pc100-candidate-policy.mjs",
  "tools/test/pc100-admission-app.mjs",
  ATTESTATION_ENGINE,
  ".github/workflows/pc100-source-verifier.yml",
  ".github/workflows/pc100-candidate-admission.yml",
  ".github/workflows/pc100-required-admission.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/supply-chain.yml",
  ".github/workflows/e2e.yml",
]);
const CHECK = "PC100 independent security admission";
const anchored = new WeakSet();
const verifiedConsumers = new WeakSet();
function immutable(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
class AttestationError extends Error {}
const need = (ok, code) => {
  if (!ok) throw new AttestationError(code);
};
const sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v) => Number.isSafeInteger(v) && v > 0;
const exact = (v, names) =>
  need(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      canonical(Object.keys(v).sort()) === canonical([...names].sort()),
    "ATTESTATION_FIELDS_REJECTED",
  );
export function decodeAuthorityJSON(bytes, cap = 65536) {
  need(
    [65536, 4 * 1024 ** 2].includes(cap) &&
      Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= cap,
    "ATTESTATION_SIZE_REJECTED",
  );
  const text = bytes.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AttestationError("ATTESTATION_JSON_REJECTED");
  }
  need(
    Buffer.from(text).equals(bytes) &&
      [
        canonical(value) + "\n",
        JSON.stringify(value) + "\n",
        JSON.stringify(value, null, 2) + "\n",
      ].includes(text),
    "ATTESTATION_JSON_REJECTED",
  );
  return value;
}
async function blob(read, entry) {
  need(
    entry?.type === "blob" && entry.mode === "100644" && sha(entry.sha) && entry.size <= 65536,
    "ATTESTATION_ANCHOR_MISSING",
  );
  const b = await read(`git/blobs/${entry.sha}`);
  const raw = Buffer.from(b.content ?? "", "base64");
  need(
    b.sha === entry.sha &&
      b.encoding === "base64" &&
      b.size === raw.length &&
      raw.length === entry.size &&
      createHash("sha1")
        .update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]))
        .digest("hex") === entry.sha,
    "ATTESTATION_BLOB_DRIFT",
  );
  return raw;
}
export async function readAppTrust(read, B) {
  need(sha(B), "ATTESTATION_BASE_REJECTED");
  const main = await read("branches/main"),
    base = await read(`git/commits/${B}`);
  need(
    main.protected === true && main.commit.sha === B && base.sha === B && sha(base.tree?.sha),
    "ATTESTATION_BASE_DRIFT",
  );
  const tree = await read(`git/trees/${base.tree.sha}?recursive=1`);
  need(tree.sha === base.tree.sha, "ATTESTATION_BASE_DRIFT");
  const entries = treeEntries(tree),
    controls = {};
  for (const p of CONTROL_PATHS) {
    const e = entries.get(p);
    need(e?.type === "blob" && e.mode === "100644", "ATTESTATION_CONTROL_SOURCE_MISSING");
    controls[p] = { mode: e.mode, blob_sha1: e.sha };
  }
  const trustBytes = await blob(read, entries.get(TRUST_CONFIG)),
    appBytes = await blob(read, entries.get("infra/seaweedfs/candidate-app.json")),
    trust = decodeAuthorityJSON(trustBytes),
    app = decodeAuthorityJSON(appBytes);
  exact(trust, [
    "schema",
    "repository_id",
    "consumer_attestation_enabled",
    "source_authority",
    "revoked_authorizations",
  ]);
  need(
    trust.schema === "pc100-app-trust-v1" &&
      trust.repository_id === REPOSITORY_ID &&
      typeof trust.consumer_attestation_enabled === "boolean" &&
      Array.isArray(trust.revoked_authorizations) &&
      trust.revoked_authorizations.length <= 256 &&
      trust.revoked_authorizations.every(digest) &&
      new Set(trust.revoked_authorizations).size === trust.revoked_authorizations.length,
    "ATTESTATION_TRUST_REJECTED",
  );
  if (trust.source_authority !== null) {
    exact(trust.source_authority, ["algorithm", "key_id", "public_key"]);
    need(
      trust.source_authority.algorithm === "Ed25519" &&
        digest(trust.source_authority.key_id) &&
        typeof trust.source_authority.public_key === "string" &&
        trust.source_authority.public_key.length <= 512,
      "SOURCE_AUTHORITY_REJECTED",
    );
    const k = createPublicKey(trust.source_authority.public_key);
    need(
      k.asymmetricKeyType === "ed25519" &&
        k.export({ format: "pem", type: "spki" }) === trust.source_authority.public_key &&
        hash(k.export({ format: "der", type: "spki" })) === trust.source_authority.key_id,
      "SOURCE_AUTHORITY_REJECTED",
    );
  }
  exact(app, [
    "schema",
    "repository_id",
    "app_id",
    "installation_id",
    "slug",
    "check_name",
    "protection_reader",
    ...(Object.hasOwn(app, "consumer_attestation") ? ["consumer_attestation"] : []),
  ]);
  need(
    app.consumer_attestation === undefined || typeof app.consumer_attestation === "boolean",
    "ATTESTATION_APP_REJECTED",
  );
  need(
    app.schema === "pc100-independent-app-v1" &&
      app.repository_id === REPOSITORY_ID &&
      id(app.app_id) &&
      app.app_id !== 15368 &&
      id(app.installation_id) &&
      /^[a-z0-9-]{1,100}$/.test(app.slug) &&
      app.check_name === CHECK,
    "ATTESTATION_APP_REJECTED",
  );
  const reader = app.protection_reader;
  exact(reader, ["schema", "repository_id", "app_id", "installation_id", "slug"]);
  need(
    reader?.schema === "pc100-protection-reader-v1" &&
      reader.repository_id === REPOSITORY_ID &&
      id(reader.app_id) &&
      ![15368, app.app_id].includes(reader.app_id) &&
      id(reader.installation_id) &&
      reader.installation_id !== app.installation_id &&
      /^[a-z0-9-]{1,100}$/.test(reader.slug),
    "ATTESTATION_READER_REJECTED",
  );
  const result = {
    B,
    TB: base.tree.sha,
    supply_bytes: entries.get(".github/workflows/supply-chain.yml").size,
    controls,
    source_inventory: sourceInventory(tree),
    trust,
    app,
    policy_sha256: hash(
      canonical({
        B,
        TB: base.tree.sha,
        controls,
        trust_sha256: hash(trustBytes),
        descriptor_sha256: hash(appBytes),
      }),
    ),
  };
  immutable(result);
  anchored.add(result);
  return result;
}
// The ordinary signer is NOT a control-plane authority. This closed boundary
// includes executable/configuration dependencies, policy and operational setup.
// Enlarging trust or changing any of these paths requires separate independent
// protected-main review; this module implements no quorum/break-glass approval.
export function controlPlanePath(p, mode) {
  return (
    mode !== "100644" ||
    /^(?:\.github|\.git|\.husky|\.agents|\.codex|infra|tools|tests)(?:\/|$)/.test(p) ||
    p.startsWith(".") ||
    /^(?:docs\/operations|docs\/evaluation)(?:\/|$)/.test(p) ||
    /(?:^|\/)(?:AGENTS\.md|Dockerfile(?:\..*)?|[^/]*[Cc]ompose[^/]*\.ya?ml|package\.json|[^/]*lock[^/]*|go\.(?:mod|sum)|[^/]*config[^/]*|requirements[^/]*|[^/]*\.(?:service|target|socket|env))$/.test(
      p,
    )
  );
}
function ordinaryBoundary(anchors, headTree) {
  const before = new Map(Object.entries(anchors.source_inventory)),
    after = new Map(Object.entries(sourceInventory(headTree)));
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(p),
      next = after.get(p);
    if (canonical(old) !== canonical(next))
      need(
        !controlPlanePath(p, old?.mode ?? next?.mode) &&
          !controlPlanePath(p, next?.mode ?? old?.mode),
        "SOURCE_CONTROL_CHANGE_REQUIRES_INDEPENDENT_REVIEW",
      );
  }
}
function fresh(record, now) {
  const observed = Date.parse(record.observed_at),
    expires = Date.parse(record.expires_at);
  need(
    typeof record.observed_at === "string" &&
      typeof record.expires_at === "string" &&
      Number.isFinite(observed) &&
      Number.isFinite(expires) &&
      new Date(observed).toISOString() === record.observed_at &&
      new Date(expires).toISOString() === record.expires_at &&
      observed <= now + 30000 &&
      observed >= now - 600000 &&
      expires > now &&
      expires > observed &&
      expires - observed <= 600000,
    "ATTESTATION_EXPIRED",
  );
}
export function verifySourceAuthorization(envelope, anchors, expected, headTree, now = Date.now()) {
  need(
    anchored.has(anchors) && anchors.trust.source_authority !== null,
    "APP_SOURCE_AUTHORITY_NOT_CONFIGURED",
  );
  exact(envelope, ["schema", "payload", "signature"]);
  need(
    envelope.schema === "pc100-source-authorization-envelope-v1" &&
      typeof envelope.signature === "string" &&
      /^[A-Za-z0-9_-]{86}$/.test(envelope.signature),
    "SOURCE_AUTHORIZATION_REJECTED",
  );
  const signature = Buffer.from(envelope.signature, "base64url");
  need(
    signature.length === 64 && signature.toString("base64url") === envelope.signature,
    "SOURCE_AUTHORIZATION_REJECTED",
  );
  ordinaryBoundary(anchors, headTree);
  const r = envelope.payload;
  exact(r, [
    "schema",
    "repository_id",
    "pr",
    "H",
    "B",
    "TH",
    "TB",
    "M",
    "TM",
    "source_inventory_sha256",
    "policy_sha256",
    "observed_at",
    "expires_at",
    "nonce",
    "scope",
    "candidate_admission_authorized",
    "release_authorized",
  ]);
  need(
    r.schema === "pc100-source-change-authorization-v1" &&
      r.repository_id === REPOSITORY_ID &&
      r.pr === expected.pr &&
      r.pr !== 100 &&
      r.M === expected.M &&
      sha(r.M) &&
      r.TM === headTree.sha &&
      r.H === expected.H &&
      r.B === expected.B &&
      r.B === anchors.B &&
      r.TB === anchors.TB &&
      r.TH === headTree.sha &&
      sha(r.H) &&
      r.policy_sha256 === anchors.policy_sha256 &&
      digest(r.nonce) &&
      !anchors.trust.revoked_authorizations.includes(r.nonce) &&
      r.scope === "ordinary-source-change" &&
      r.candidate_admission_authorized === false &&
      r.release_authorized === false &&
      r.source_inventory_sha256 === hash(canonical(sourceInventory(headTree))),
    "SOURCE_AUTHORIZATION_DRIFT",
  );
  fresh(r, now);
  need(
    verify(
      null,
      Buffer.from(canonical(r)),
      createPublicKey(anchors.trust.source_authority.public_key),
      Buffer.from(envelope.signature, "base64url"),
    ),
    "SOURCE_AUTHORIZATION_SIGNATURE_REJECTED",
  );
  return immutable({
    decision: "AUTHORIZED_SOURCE_CHANGE",
    M: r.M,
    TM: r.TM,
    source_authorization: envelope,
    authorization_sha256: hash(canonical(envelope)),
    authority_key_id: anchors.trust.source_authority.key_id,
    policy_sha256: anchors.policy_sha256,
    observed_at: r.observed_at,
    expires_at: r.expires_at,
  });
}
function validatePublicRules(rules, app) {
  const checks = rules.filter((r) => r.type === "required_status_checks");
  for (const [name, integration] of [
    ["ci", 15368],
    ["supply-chain-security", 15368],
    [CHECK, app.app_id],
  ]) {
    need(
      checks.some(
        (r) =>
          r.parameters?.strict_required_status_checks_policy === true &&
          r.parameters.required_status_checks?.some(
            (c) => c.context === name && c.integration_id === integration,
          ),
      ),
      "ATTESTATION_REQUIRED_SOURCE_MISSING",
    );
  }
}
// Fixed read-only query, delegated ONLY to the authenticated Reader installation.
// No caller-selected query, variables, URL, credential or pagination expansion.
export const BRANCH_BYPASS_QUERY = `query PC100BranchBypass {
  repository(owner: "mahmoudemad68", name: "Your_Editor") {
    id databaseId nameWithOwner
    ref(qualifiedName: "refs/heads/main") {
      ...PC100Ref branchProtectionRule { id databaseId pattern }
    }
    branchProtectionRules(first: 100) {
      totalCount pageInfo { ...PC100Page }
      edges { cursor node { id } }
      nodes {
        id databaseId pattern
        matchingRefs(first: 100, query: "main") {
          totalCount pageInfo { ...PC100Page }
          edges { cursor node { id } } nodes { ...PC100Ref }
        }
        bypassPullRequestAllowances(first: 100) {
          totalCount pageInfo { ...PC100Page }
          edges { cursor node { id } } nodes { id }
        }
      }
    }
  }
}
fragment PC100Ref on Ref { id name prefix target { __typename ... on Commit { oid } } }
fragment PC100Page on PageInfo { hasNextPage hasPreviousPage startCursor endCursor }`;
const graphID = (v) => typeof v === "string" && /^[A-Za-z0-9_+/=-]{1,256}$/.test(v);
function closedConnection(c) {
  need(
    c &&
      Number.isSafeInteger(c.totalCount) &&
      c.totalCount >= 0 &&
      c.totalCount <= 100 &&
      Array.isArray(c.nodes) &&
      c.nodes.length === c.totalCount &&
      Array.isArray(c.edges) &&
      c.edges.length === c.totalCount &&
      c.pageInfo?.hasNextPage === false &&
      c.pageInfo.hasPreviousPage === false &&
      new Set(c.nodes.map((n) => n?.id)).size === c.totalCount &&
      new Set(c.edges.map((n) => n?.cursor)).size === c.totalCount,
    "PROTECTION_GRAPHQL_INCOMPLETE",
  );
  for (let i = 0; i < c.totalCount; i++)
    need(
      graphID(c.nodes[i]?.id) &&
        c.edges[i]?.node?.id === c.nodes[i].id &&
        typeof c.edges[i]?.cursor === "string" &&
        c.edges[i].cursor.length > 0 &&
        c.edges[i].cursor.length <= 512,
      "PROTECTION_GRAPHQL_INCOMPLETE",
    );
  need(
    c.pageInfo.startCursor === (c.totalCount ? c.edges[0].cursor : null) &&
      c.pageInfo.endCursor === (c.totalCount ? c.edges.at(-1).cursor : null),
    "PROTECTION_GRAPHQL_INCOMPLETE",
  );
  return c.nodes;
}
function graphBypassProof(response, B) {
  need(
    response &&
      response.data &&
      (!Object.hasOwn(response, "errors") ||
        (Array.isArray(response.errors) && response.errors.length === 0)),
    "PROTECTION_READER_GRAPHQL_NOT_VERIFIED",
  );
  const r = response.data.repository,
    ref = r?.ref;
  need(
    r?.databaseId === REPOSITORY_ID &&
      r.id === "R_kgDOUzKRSQ" &&
      r.nameWithOwner === "mahmoudemad68/Your_Editor" &&
      graphID(ref?.id) &&
      ref.name === "main" &&
      ref.prefix === "refs/heads/" &&
      ref.target?.__typename === "Commit" &&
      ref.target.oid === B,
    "PROTECTION_GRAPHQL_IDENTITY_REJECTED",
  );
  const rules = closedConnection(r.branchProtectionRules),
    applicable = [];
  for (const rule of rules) {
    need(
      id(rule.databaseId) &&
        typeof rule.pattern === "string" &&
        rule.pattern.length > 0 &&
        rule.pattern.length <= 1024,
      "PROTECTION_GRAPHQL_IDENTITY_REJECTED",
    );
    const refs = closedConnection(rule.matchingRefs);
    for (const f of refs)
      need(
        f.prefix === "refs/heads/" &&
          typeof f.name === "string" &&
          f.name.length > 0 &&
          f.target?.__typename === "Commit" &&
          sha(f.target.oid),
        "PROTECTION_GRAPHQL_IDENTITY_REJECTED",
      );
    const main = refs.filter((f) => f.name === "main");
    if (main.length) {
      need(
        main.length === 1 && main[0].id === ref.id && main[0].target.oid === B,
        "PROTECTION_GRAPHQL_IDENTITY_REJECTED",
      );
      need(
        closedConnection(rule.bypassPullRequestAllowances).length === 0,
        "CANDIDATE_PROTECTION_BYPASS",
      );
      applicable.push(rule);
    }
  }
  // Multiple applicable legacy rules are explicitly unsupported: no unrelated
  // rule's empty count may substitute for the effective main protection rule.
  need(
    applicable.length === 1 &&
      ["id", "databaseId", "pattern"].every(
        (k) => applicable[0][k] === ref.branchProtectionRule?.[k],
      ),
    "PROTECTION_GRAPHQL_IDENTITY_REJECTED",
  );
  return {
    schema: "pc100-branch-bypass-proof-v1",
    source: "reader-graphql-corroboration-v1",
    B,
    target: "refs/heads/main",
    rule_ids: [applicable[0].id],
    sha256: hash(canonical(response.data)),
  };
}
function validateBranchProof(p, B) {
  exact(p, ["schema", "source", "B", "target", "rule_ids", "sha256"]);
  need(
    p.schema === "pc100-branch-bypass-proof-v1" &&
      sha(B) &&
      p.B === B &&
      p.target === "refs/heads/main" &&
      digest(p.sha256) &&
      Array.isArray(p.rule_ids) &&
      ((p.source === "rest-explicit-v1" && p.rule_ids.length === 0) ||
        (p.source === "reader-graphql-corroboration-v1" &&
          p.rule_ids.length === 1 &&
          graphID(p.rule_ids[0]))),
    "ATTESTATION_BYPASS_UNVERIFIABLE",
  );
}
function validateProtectionSnapshot(p, rules, B) {
  exact(p, [
    "schema",
    "B",
    "branch_bypass",
    "rules_sha256",
    "enforce_admins",
    "strict",
    "approving_reviews",
    "force_pushes",
    "deletions",
    "bypass_visible",
    "bypass_actors",
    "rulesets",
  ]);
  need(
    p.schema === "pc100-protection-attestation-v2" &&
      p.B === B &&
      p.rules_sha256 === hash(canonical(rules)) &&
      p.enforce_admins === true &&
      p.strict === true &&
      id(p.approving_reviews) &&
      p.force_pushes === false &&
      p.deletions === false &&
      p.bypass_visible === true &&
      Array.isArray(p.bypass_actors) &&
      p.bypass_actors.length === 0,
    "CANDIDATE_PROTECTION_UNVERIFIABLE",
  );
  validateBranchProof(p.branch_bypass, B);
  const existing = rules
    .filter((r) => r.type === "required_status_checks")
    .flatMap((r) =>
      r.parameters?.strict_required_status_checks_policy === true
        ? (r.parameters.required_status_checks ?? [])
        : [],
    );
  need(
    ["ci", "supply-chain-security"].every((name) =>
      existing.some((c) => c.context === name && c.integration_id === 15368),
    ),
    "CANDIDATE_EXISTING_CHECKS_REMOVED",
  );
  const ids = [...new Set(rules.map((r) => r.ruleset_id))].sort((a, b) => a - b);
  need(
    ids.length > 0 &&
      ids.every(id) &&
      Array.isArray(p.rulesets) &&
      canonical(p.rulesets.map((r) => r.id)) === canonical(ids),
    "ATTESTATION_RULESETS_INCOMPLETE",
  );
  for (const r of p.rulesets) {
    exact(r, ["id", "sha256", "enforcement", "target", "bypass_visible", "bypass_actors"]);
    need(
      digest(r.sha256) &&
        r.enforcement === "active" &&
        r.target === "branch" &&
        r.bypass_visible === true &&
        Array.isArray(r.bypass_actors) &&
        r.bypass_actors.length === 0,
      "CANDIDATE_PROTECTION_BYPASS",
    );
  }
}
function validateProtection(p, rules, app, B) {
  validateProtectionSnapshot(p, rules, B);
  validatePublicRules(rules, app);
}
/** One strict predicate for probe, source authorization and attestation issuance. */
export async function collectProtectionEvidence(read, expectedB) {
  const main = await read("branches/main"),
    B = main?.commit?.sha;
  need(
    main?.protected === true && sha(B) && (expectedB === undefined || expectedB === B),
    "CANDIDATE_LIVE_DRIFT",
  );
  const rules = await completePages(read, "rules/branches/main"),
    protection = await read("branches/main/protection");
  const allowances = protection?.required_pull_request_reviews?.bypass_pull_request_allowances;
  let branch;
  if (
    Object.hasOwn(protection?.required_pull_request_reviews ?? {}, "bypass_pull_request_allowances")
  ) {
    need(
      allowances &&
        ["users", "teams", "apps"].every(
          (k) => Array.isArray(allowances[k]) && allowances[k].length === 0,
        ),
      "CANDIDATE_PROTECTION_BYPASS",
    );
    branch = {
      schema: "pc100-branch-bypass-proof-v1",
      source: "rest-explicit-v1",
      B,
      target: "refs/heads/main",
      rule_ids: [],
      sha256: hash(canonical(allowances)),
    };
    // If a dedicated Reader capability is selected, corroborate even an explicit
    // REST empty result; conflicting sources must never be silently ignored.
  }
  if (typeof read.branchProtectionGraphQL === "function") {
    let response;
    try {
      response = await read.branchProtectionGraphQL();
    } catch {
      throw new AttestationError("PROTECTION_READER_GRAPHQL_NOT_VERIFIED");
    }
    branch = graphBypassProof(response, B);
  }
  need(branch !== undefined, "ATTESTATION_BYPASS_UNVERIFIABLE");
  const ids = [...new Set(rules.map((r) => r.ruleset_id))].sort((a, b) => a - b),
    rulesets = [],
    originals = [];
  need(ids.length > 0 && ids.every(id), "ATTESTATION_RULESETS_INCOMPLETE");
  for (const i of ids) {
    const r = await read(`rulesets/${i}`);
    need(
      r.id === i && Array.isArray(r.bypass_actors) && r.bypass_actors.length === 0,
      "CANDIDATE_PROTECTION_BYPASS",
    );
    originals.push(canonical(r));
    rulesets.push({
      id: i,
      sha256: hash(canonical(r)),
      enforcement: r.enforcement,
      target: r.target,
      bypass_visible: true,
      bypass_actors: [],
    });
  }
  const snapshot = {
    schema: "pc100-protection-attestation-v2",
    B,
    branch_bypass: branch,
    rules_sha256: hash(canonical(rules)),
    enforce_admins: protection.enforce_admins?.enabled,
    strict: protection.required_status_checks?.strict,
    approving_reviews: protection.required_pull_request_reviews?.required_approving_review_count,
    force_pushes: protection.allow_force_pushes?.enabled,
    deletions: protection.allow_deletions?.enabled,
    bypass_visible: true,
    bypass_actors: [],
    rulesets,
  };
  validateProtectionSnapshot(snapshot, rules, B);
  need(
    canonical(await completePages(read, "rules/branches/main")) === canonical(rules) &&
      canonical(await read("branches/main/protection")) === canonical(protection),
    "CANDIDATE_LIVE_DRIFT",
  );
  for (let i = 0; i < ids.length; i++)
    need(canonical(await read(`rulesets/${ids[i]}`)) === originals[i], "CANDIDATE_LIVE_DRIFT");
  if (branch.source === "reader-graphql-corroboration-v1") {
    let response;
    try {
      response = await read.branchProtectionGraphQL();
    } catch {
      throw new AttestationError("PROTECTION_READER_GRAPHQL_NOT_VERIFIED");
    }
    need(canonical(graphBypassProof(response, B)) === canonical(branch), "CANDIDATE_LIVE_DRIFT");
  }
  const after = await read("branches/main");
  need(after?.protected === true && after.commit?.sha === B, "CANDIDATE_LIVE_DRIFT");
  return {
    schema: "pc100-protection-visibility-v2",
    B,
    rules,
    ruleset_count: ids.length,
    snapshot,
    candidate_admission_authorized: false,
    release_authorized: false,
    live_a6_enforced: false,
  };
}
export async function collectProtectionAttestation(read, app) {
  const evidence = await collectProtectionEvidence(read);
  validateProtection(evidence.snapshot, evidence.rules, app, evidence.B);
  return evidence.snapshot;
}
// Closed protected-main Supply profile. Unknown workflow bytes require a new
// independent control-plane review, not a PR-defined job-name manifest.
export const SUPPORTED_SUPPLY_SHA256 =
  "2c54849ebbbf401538572dab86e6466d888218e3d7fb936aaa8afa165708a4a9";
export const SUPPLY_JOB_PROFILE = Object.freeze({
  "Case-exact release authorization": "success",
  dependencies: "success",
  ...Object.fromEntries(
    [
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
    ].map((n) => ["image " + n, "success"]),
  ),
  "supply-chain-security": "success",
  "publish ${{ matrix.service }}": "skipped",
  "release manifest": "skipped",
  "owner-approved staging": "skipped",
});
async function verifySupplyJobs(read, r, context, anchors) {
  const entry = anchors.controls[".github/workflows/supply-chain.yml"],
    data = await blob(read, {
      ...entry,
      sha: entry.blob_sha1,
      type: "blob",
      size: anchors.supply_bytes,
    });
  need(hash(data) === SUPPORTED_SUPPLY_SHA256, "ATTESTATION_SUPPLY_PROFILE_UNSUPPORTED");
  const jobs = await completePages(read, `actions/runs/${r.id}/attempts/1/jobs`, "jobs");
  need(
    id(r.check_suite_id) &&
      jobs.length === Object.keys(SUPPLY_JOB_PROFILE).length &&
      new Set(jobs.map((j) => j.name)).size === jobs.length &&
      new Set(jobs.map((j) => j.id)).size === jobs.length,
    "ATTESTATION_SUPPLY_JOBS_REJECTED",
  );
  for (const j of jobs) {
    need(
      id(j.id) &&
        j.run_id === r.id &&
        j.run_attempt === 1 &&
        j.status === "completed" &&
        Object.hasOwn(SUPPLY_JOB_PROFILE, j.name) &&
        j.conclusion === SUPPLY_JOB_PROFILE[j.name] &&
        typeof j.check_run_url === "string" &&
        /^https:\/\/api\.github\.com\/repos\/mahmoudemad68\/Your_Editor\/check-runs\/[1-9][0-9]*$/.test(
          j.check_run_url,
        ),
      "ATTESTATION_SUPPLY_JOBS_REJECTED",
    );
    const cid = Number(j.check_run_url.split("/").at(-1));
    need(id(cid), "ATTESTATION_SUPPLY_JOBS_REJECTED");
    const check = await read(`check-runs/${cid}`),
      suite = await read(`check-suites/${r.check_suite_id}`);
    need(
      check.id === cid &&
        check.name === j.name &&
        check.head_sha === context.H &&
        check.app?.id === 15368 &&
        check.check_suite?.id === r.check_suite_id &&
        check.status === "completed" &&
        check.conclusion === j.conclusion &&
        suite.id === r.check_suite_id &&
        suite.repository?.id === REPOSITORY_ID &&
        suite.head_sha === context.H &&
        suite.app?.id === 15368,
      "ATTESTATION_SUPPLY_CHECK_REJECTED",
    );
  }
}
const workflows = {
  preflight: ".github/workflows/pc100-artifact-integration.yml",
  supply: ".github/workflows/supply-chain.yml",
  ci: ".github/workflows/ci.yml",
  walking: ".github/workflows/e2e.yml",
};
async function verifyRuns(read, runs, context, required, anchors) {
  need(
    Array.isArray(required) &&
      required.includes(context.pr === 100 ? "preflight" : "ci") &&
      new Set(required).size === required.length &&
      required.every((r) => Object.hasOwn(workflows, r)),
    "ATTESTATION_RUN_ROLES_REJECTED",
  );
  need(
    runs &&
      typeof runs === "object" &&
      !Array.isArray(runs) &&
      required.every((role) => Object.hasOwn(runs, role)) &&
      Object.keys(runs).every((role) => Object.hasOwn(workflows, role)),
    "ATTESTATION_RUN_ROLES_REJECTED",
  );
  for (const role of Object.keys(runs)) {
    const ref = runs[role];
    exact(ref, ["id", "attempt", "workflow_id"]);
    need(id(ref.id) && ref.attempt === 1 && id(ref.workflow_id), "ATTESTATION_RUN_REJECTED");
    const r = await read(`actions/runs/${ref.id}`),
      w = await read(`actions/workflows/${ref.workflow_id}`);
    need(
      r.id === ref.id &&
        r.run_attempt === ref.attempt &&
        r.workflow_id === ref.workflow_id &&
        w.id === ref.workflow_id &&
        w.path === workflows[role] &&
        r.path === workflows[role] &&
        r.head_sha === context.H &&
        r.event === "pull_request" &&
        r.repository?.id === REPOSITORY_ID &&
        r.head_repository?.id === REPOSITORY_ID &&
        r.status === "completed" &&
        r.conclusion === "success" &&
        r.pull_requests?.length === 1 &&
        r.pull_requests[0].number === context.pr &&
        r.pull_requests[0].head?.sha === context.H &&
        r.pull_requests[0].base?.sha === context.B,
      "ATTESTATION_RUN_REJECTED",
    );
    if (role === "supply") await verifySupplyJobs(read, r, context, anchors);
  }
}
async function liveContext(read, c) {
  exact(c, ["repository_id", "pr", "H", "B", "M", "TH", "TB", "TM"]);
  const main = await read("branches/main"),
    pr = await read(`pulls/${c.pr}`);
  need(
    c.repository_id === REPOSITORY_ID &&
      id(c.pr) &&
      [c.H, c.B, c.M, c.TH, c.TB, c.TM].every(sha) &&
      main.protected === true &&
      main.commit.sha === c.B &&
      pr.number === c.pr &&
      pr.state === "open" &&
      pr.merged === false &&
      pr.base?.ref === "main" &&
      pr.base.repo?.id === REPOSITORY_ID &&
      pr.head?.repo?.id === REPOSITORY_ID &&
      pr.head.sha === c.H &&
      pr.base.sha === c.B &&
      pr.merge_commit_sha === c.M,
    "ATTESTATION_LIVE_DRIFT",
  );
  const aliases = (await completePages(read, "pulls?state=open&base=main")).filter(
    (p) => p?.head?.sha === c.H,
  );
  need(aliases.length === 1 && aliases[0].number === c.pr, "ATTESTATION_SOURCE_ALIAS_REJECTED");
  const [h, b, m] = await Promise.all([c.H, c.B, c.M].map((s) => read(`git/commits/${s}`)));
  need(
    h.sha === c.H &&
      b.sha === c.B &&
      m.sha === c.M &&
      h.tree.sha === c.TH &&
      b.tree.sha === c.TB &&
      m.tree.sha === c.TM &&
      c.TH === c.TM &&
      canonical(m.parents.map((p) => p.sha)) === canonical([c.B, c.H]),
    "ATTESTATION_TREE_DRIFT",
  );
}
function authorizationShape(r, c) {
  if (c.pr === 100) {
    exact(r, [
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
      "expected_elf_sha256",
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
    ]);
    exact(r.reviewed_source, ["commit", "tree"]);
    need(
      r.schema === "pc100-security-candidate-admission-v1" &&
        r.decision === "SECURITY_CANDIDATE_ADMISSION_AUTHORIZED" &&
        r.scope === "candidate-qualification-only" &&
        r.profile === "seaweedfs-go-s-w-production-candidate-v1" &&
        r.repository_id === REPOSITORY_ID &&
        ["H", "B", "M", "TH", "TM"].every((k) => r[k] === c[k]) &&
        [
          "expected_elf_sha256",
          "K",
          "L",
          "policy_sha256",
          "registry_sha256",
          "inventory_sha256",
        ].every((k) => digest(r[k])) &&
        sha(r.reviewed_source.commit) &&
        sha(r.reviewed_source.tree) &&
        r.trusted_workflow_sha === c.B &&
        id(r.file_count) &&
        r.file_count <= 20000 &&
        id(r.upstream_run) &&
        r.upstream_attempt === 1,
      "ATTESTATION_AUTHORIZATION_REJECTED",
    );
  } else {
    exact(r, [
      "schema",
      "TH",
      "TB",
      "TM",
      "source_inventory_sha256",
      "decision",
      "source_authorization",
      "authorization_sha256",
      "authority_key_id",
      "policy_sha256",
      "observed_at",
      "expires_at",
      "repository_id",
      "pr",
      "H",
      "B",
      "M",
      "head_repository_id",
      "state",
      "draft",
      "merged",
      "trusted_main_sha",
      "candidate_admission_authorized",
      "release_authorized",
    ]);
    need(
      r.schema === "pc100-authorized-source-change-v1" &&
        r.decision === "AUTHORIZED_SOURCE_CHANGE" &&
        r.head_repository_id === REPOSITORY_ID &&
        r.repository_id === REPOSITORY_ID &&
        r.trusted_main_sha === c.B &&
        r.TH === c.TH &&
        r.TM === c.TM &&
        r.TB === c.TB &&
        r.state === "open" &&
        r.merged === false &&
        typeof r.draft === "boolean" &&
        digest(r.source_inventory_sha256) &&
        digest(r.authorization_sha256) &&
        digest(r.authority_key_id),
      "ATTESTATION_AUTHORIZATION_REJECTED",
    );
  }
}
/** Issuer-host only: caller uses the separately authenticated read-only protection capability. */
export async function createConsumerAttestation(
  read,
  anchors,
  context,
  authorization,
  runs,
  requiredRoles,
  now = Date.now(),
) {
  need(
    anchored.has(anchors) &&
      anchors.trust.consumer_attestation_enabled === true &&
      anchors.app.consumer_attestation === true,
    "CONSUMER_ATTESTATION_DISABLED",
  );
  await liveContext(read, context);
  await verifyRuns(read, runs, context, requiredRoles, anchors);
  const scope = context.pr === 100 ? "security-candidate" : "ordinary-source-change";
  need(
    authorization?.release_authorized === false &&
      authorization.candidate_admission_authorized === (scope === "security-candidate") &&
      authorization.H === context.H &&
      authorization.B === context.B &&
      authorization.M === context.M &&
      authorization.pr === context.pr,
    "ATTESTATION_AUTHORIZATION_REJECTED",
  );
  authorizationShape(authorization, context);
  if (scope === "ordinary-source-change") {
    const tree = await read(`git/trees/${context.TH}?recursive=1`);
    verifySourceAuthorization(authorization.source_authorization, anchors, context, tree, now);
  }
  const protection = await collectProtectionAttestation(read, anchors.app);
  await verifyRuns(read, runs, context, requiredRoles, anchors);
  await liveContext(read, context);
  return {
    schema: "pc100-app-consumer-attestation-v1",
    context,
    scope,
    authorization,
    issuer: {
      app_id: anchors.app.app_id,
      installation_id: anchors.app.installation_id,
      slug: anchors.app.slug,
      check_name: CHECK,
    },
    reader: anchors.app.protection_reader,
    control_source: anchors.controls,
    policy_sha256: anchors.policy_sha256,
    protection,
    protection_sha256: hash(canonical(protection)),
    runs,
    observed_at: new Date(now).toISOString(),
    expires_at: new Date(now + 600000).toISOString(),
    candidate_admission_authorized: scope === "security-candidate",
    release_authorized: false,
  };
}
/** Actions-side read-only path. Never reads private branch-protection or ruleset endpoints. */
async function verifyConsumer(
  read,
  expected,
  { requiredRoles = expected.pr === 100 ? ["preflight"] : ["ci"], now = Date.now() } = {},
) {
  const anchors = await readAppTrust(read, expected.B);
  need(
    anchors.trust.consumer_attestation_enabled === true &&
      anchors.app.consumer_attestation === true,
    "CONSUMER_ATTESTATION_DISABLED",
  );
  await liveContext(read, expected);
  const route = `commits/${expected.H}/check-runs?check_name=${encodeURIComponent(CHECK)}&filter=all`;
  const list = await completePages(read, route, "check_runs"),
    own = list.filter((c) => c.name === CHECK && c.app?.id === anchors.app.app_id);
  need(own.length === 1, "ATTESTATION_CHECK_AMBIGUOUS");
  const check = await read(`check-runs/${own[0].id}`),
    suite = await read(`check-suites/${check.check_suite?.id}`);
  need(
    check.id === own[0].id &&
      id(check.id) &&
      check.name === CHECK &&
      check.head_sha === expected.H &&
      check.app?.id === anchors.app.app_id &&
      check.app.slug === anchors.app.slug &&
      check.status === "completed" &&
      check.conclusion === "success" &&
      id(suite.id) &&
      suite.id === check.check_suite?.id &&
      suite.head_sha === expected.H &&
      suite.app?.id === anchors.app.app_id &&
      suite.repository?.id === REPOSITORY_ID,
    "ATTESTATION_ISSUER_REJECTED",
  );
  need(
    typeof check.output?.summary === "string" &&
      check.output.title === "PC100 consumer attestation",
    "ATTESTATION_RECORD_MISSING",
  );
  const r = decodeAuthorityJSON(Buffer.from(check.output.summary));
  exact(r, [
    "schema",
    "context",
    "scope",
    "authorization",
    "issuer",
    "reader",
    "control_source",
    "policy_sha256",
    "protection",
    "protection_sha256",
    "runs",
    "observed_at",
    "expires_at",
    "candidate_admission_authorized",
    "release_authorized",
  ]);
  need(
    r.schema === "pc100-app-consumer-attestation-v1" &&
      canonical(r.context) === canonical(expected) &&
      canonical(r.issuer) ===
        canonical({
          app_id: anchors.app.app_id,
          installation_id: anchors.app.installation_id,
          slug: anchors.app.slug,
          check_name: CHECK,
        }) &&
      canonical(r.reader) === canonical(anchors.app.protection_reader) &&
      canonical(r.control_source) === canonical(anchors.controls) &&
      r.policy_sha256 === anchors.policy_sha256 &&
      check.external_id === hash(canonical(r)) &&
      r.protection_sha256 === hash(canonical(r.protection)) &&
      r.release_authorized === false,
    "ATTESTATION_BINDING_REJECTED",
  );
  const scope = expected.pr === 100 ? "security-candidate" : "ordinary-source-change";
  need(
    r.scope === scope &&
      r.candidate_admission_authorized === (scope === "security-candidate") &&
      r.authorization?.release_authorized === false &&
      r.authorization.candidate_admission_authorized === r.candidate_admission_authorized &&
      r.authorization.H === expected.H &&
      r.authorization.B === expected.B &&
      r.authorization.M === expected.M &&
      r.authorization.pr === expected.pr,
    "ATTESTATION_SCOPE_REJECTED",
  );
  authorizationShape(r.authorization, expected);
  fresh(r, now);
  if (scope === "ordinary-source-change") {
    need(r.authorization.decision === "AUTHORIZED_SOURCE_CHANGE", "ATTESTATION_SCOPE_REJECTED");
    const h = await read(`git/trees/${expected.TH}?recursive=1`);
    verifySourceAuthorization(r.authorization.source_authorization, anchors, expected, h, now);
  }
  const completed = Date.parse(check.completed_at);
  need(
    Number.isFinite(completed) && Math.abs(completed - Date.parse(r.observed_at)) <= 30000,
    "ATTESTATION_EXPIRED",
  );
  const rules = await completePages(read, "rules/branches/main");
  validateProtection(r.protection, rules, anchors.app, expected.B);
  await verifyRuns(read, r.runs, expected, requiredRoles, anchors);
  // Re-read both immutable anchors and mutable check state after all expensive reads.
  const current = await readAppTrust(read, expected.B),
    again = await read(`check-runs/${check.id}`);
  need(
    current.policy_sha256 === anchors.policy_sha256 && canonical(again) === canonical(check),
    "ATTESTATION_REVOKED_OR_DRIFTED",
  );
  await verifyRuns(read, r.runs, expected, requiredRoles, anchors);
  await liveContext(read, expected);
  const result = {
    schema: "pc100-consumer-verification-v1",
    attestation: r,
    check_id: check.id,
    suite_id: suite.id,
    record_sha256: hash(canonical(r)),
    source_evidence_verified: true,
    candidate_admission_authorized: false,
    release_authorized: false,
  };
  immutable(result);
  verifiedConsumers.add(result);
  return result;
}
export async function verifyConsumerAttestation(read, expected, options) {
  try {
    return await verifyConsumer(read, expected, options);
  } catch (error) {
    throw new AttestationError(
      error instanceof AttestationError ? error.message : "ATTESTATION_OPERATION_REJECTED",
    );
  }
}
export function isVerifiedConsumerEvidence(proof, context) {
  return (
    verifiedConsumers.has(proof) &&
    proof.attestation.candidate_admission_authorized === true &&
    ["H", "B", "M", "TH", "TM"].every((k) => proof.attestation.context[k] === context[k])
  );
}
