/** Dedicated external App controller. Never run by a PR workflow. No third-party dependencies. */
import { createPrivateKey, createHash, randomBytes, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URLSearchParams } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  readAppTrust,
  verifySourceAuthorization,
  decodeAuthorityJSON,
  createConsumerAttestation,
  TRUST_CONFIG,
  ATTESTATION_ENGINE,
} from "./pc100-app-attestation.mjs";
import {
  APP_CONFIG,
  APP_ENGINE,
  ENGINE,
  REGISTRY,
  CANDIDATE_TITLE,
  APP_CHECK,
  validateAppConfig,
  validateProtectionReaderConfig,
  inspectProtectionVisibility,
  readPolicyJSON,
  verifyCandidateEvent,
  readGitSourceBytes,
  withoutQualificationCredentials,
} from "./pc100-candidate-policy.mjs";
import {
  REPO,
  REPOSITORY_ID,
  canonical,
  hash,
  treeEntries,
  sourceInventory,
  completePages,
  selectUpstreamRun,
} from "./pc100-source-verifier.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const need = (v, code) => {
  if (!v) throw Error(code);
};
const safeError = (e) =>
  /^[A-Z][A-Z_]{2,100}$/.test(e?.message ?? "") ? e.message : "APP_OPERATION_FAILED";
export function assertExternalHost(env) {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "PWD",
    "SHLVL",
    "_",
    "TERM",
  ]);
  for (const k of Object.keys(env)) {
    need(
      !/^(GITHUB_|ACTIONS_|RUNNER_|GH_TOKEN$|PC100_METADATA_TOKEN$|NODE_OPTIONS$|NODE_PATH$)/i.test(
        k,
      ),
      "APP_PR_RUNNER_FORBIDDEN",
    );
    need(allowed.has(k), "APP_HOST_ENV_REJECTED");
  }
}
export function validateAppRoute(route, method = "GET") {
  need(
    typeof route === "string" && route.length <= 2048 && !/[\\#\r\n]/.test(route),
    "APP_ROUTE_REJECTED",
  );
  const [pathname, query = ""] = route.split("?");
  need(
    !pathname.includes("%") &&
      !pathname.split("/").some((p) => p === "." || p === "..") &&
      route.split("?").length <= 2,
    "APP_ROUTE_REJECTED",
  );
  const repo = "/repos/" + REPO + "/";
  const relative = pathname.startsWith(repo) ? pathname.slice(repo.length) : null;
  const readPath =
    /^(?:branches\/main(?:\/protection)?|rules\/branches\/main|rulesets(?:\/[1-9][0-9]*)?|pulls(?:\/[1-9][0-9]*)?|git\/(?:commits|trees|blobs)\/[a-f0-9]{40}|commits\/[a-f0-9]{40}\/check-runs|check-runs(?:\/[1-9][0-9]*(?:\/annotations)?)?|check-suites\/[1-9][0-9]*|actions\/(?:workflows\/(?:[a-z0-9-]+\.yml|[1-9][0-9]*)(?:\/runs)?|runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*\/jobs)?))$/;
  need(
    (method === "GET" &&
      (["/app", "/installation/repositories"].includes(pathname) ||
        /^\/app\/installations\/[1-9][0-9]*$/.test(pathname) ||
        (relative !== null && readPath.test(relative)))) ||
      (method === "POST" && /^\/app\/installations\/[1-9][0-9]*\/access_tokens$/.test(pathname)) ||
      (method === "POST" && relative === "check-runs") ||
      (method === "PATCH" && /^check-runs\/[1-9][0-9]*$/.test(relative ?? "")),
    "APP_ROUTE_REJECTED",
  );
  const values = {
    per_page: /^100$/,
    page: /^(?:[1-9]|[1-3][0-9]|40)$/,
    recursive: /^1$/,
    filter: /^all$/,
    event: /^(?:pull_request|workflow_run)$/,
    head_sha: /^[a-f0-9]{40}$/,
    state: /^open$/,
    base: /^main$/,
  };
  const seen = new Set();
  for (const [k, v] of new URLSearchParams(query)) {
    need(
      !seen.has(k) &&
        (k === "check_name" ? v === APP_CHECK : Object.hasOwn(values, k) && values[k].test(v)),
      "APP_ROUTE_REJECTED",
    );
    seen.add(k);
  }
  need(method === "GET" || !query, "APP_ROUTE_REJECTED");
}
export async function appRequest(route, token, method = "GET", body, cap = 24 * 1024 ** 2) {
  validateAppRoute(route, method);
  need(Number.isSafeInteger(cap) && cap >= 1024 && cap <= 24 * 1024 ** 2, "APP_RESPONSE_TOO_LARGE");
  const r = await globalThis.fetch("https://api.github.com" + route, {
    method,
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  need(r.status === (method === "POST" ? 201 : 200), "APP_API_REJECTED");
  const chunks = [];
  let size = 0;
  for await (const b of r.body) {
    size += b.length;
    need(size <= cap, "APP_RESPONSE_TOO_LARGE");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function appJWT(config, key, now = Date.now()) {
  validateAppConfig(config);
  return signedAppJWT(config.app_id, key, now);
}
function signedAppJWT(appID, key, now = Date.now()) {
  const parsed = createPrivateKey(key);
  need(
    parsed.asymmetricKeyType === "rsa" && parsed.asymmetricKeyDetails.modulusLength >= 2048,
    "APP_KEY_REJECTED",
  );
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    payload = Buffer.from(
      JSON.stringify({
        iat: Math.floor(now / 1000) - 30,
        exp: Math.floor(now / 1000) + 540,
        iss: String(appID),
      }),
    ).toString("base64url");
  return (
    header +
    "." +
    payload +
    "." +
    sign("RSA-SHA256", Buffer.from(header + "." + payload), parsed).toString("base64url")
  );
}
const protectionReaders = new WeakMap();
const readerPermissions = Object.freeze({ administration: "read", metadata: "read" });
const protectionPath = (route) =>
  /^(?:branches\/main(?:\/protection)?|rules\/branches\/main|rulesets\/[1-9][0-9]*)$/.test(
    route.split("?")[0],
  );
export function validateProtectionRoute(route, method = "GET", body) {
  need(
    typeof route === "string" && method === "GET" && body === undefined && protectionPath(route),
    "PROTECTION_READER_ROUTE_REJECTED",
  );
  validateAppRoute(`/repos/${REPO}/${route}`, method);
  const [pathname, query] = route.split("?");
  need(
    query === undefined || pathname === "rules/branches/main",
    "PROTECTION_READER_ROUTE_REJECTED",
  );
  if (query !== undefined) {
    const q = new URLSearchParams(query);
    need(
      [...q.keys()].every((k) => ["per_page", "page"].includes(k)) &&
        q.get("per_page") === "100" &&
        /^(?:[1-9]|[1-3][0-9]|40)$/.test(q.get("page") ?? ""),
      "PROTECTION_READER_ROUTE_REJECTED",
    );
  }
}
// A distinct, Owner-installed App must itself have ONLY these read permissions.
// Narrowing a token minted by an overprivileged reader App is not sufficient.
// This constructor performs no installation/permission update and never writes
// a check. Null protected-main configuration leaves the capability unavailable.
export async function protectionReaderClient(writer, key, request = appRequest) {
  validateAppConfig(writer);
  need(writer.protection_reader != null, "PROTECTION_READER_NOT_CONFIGURED");
  const config = validateProtectionReaderConfig(writer.protection_reader, writer),
    jwt = signedAppJWT(config.app_id, key),
    actual = await request("/app", jwt, "GET", undefined, 2 * 1024 ** 2);
  need(
    actual.id === config.app_id &&
      actual.slug === config.slug &&
      canonical(actual.permissions) === canonical(readerPermissions),
    "PROTECTION_READER_ISSUER_REJECTED",
  );
  const installation = await request(
    `/app/installations/${config.installation_id}`,
    jwt,
    "GET",
    undefined,
    2 * 1024 ** 2,
  );
  need(
    installation.id === config.installation_id &&
      installation.app_id === config.app_id &&
      installation.app_slug === config.slug &&
      installation.repository_selection === "selected" &&
      installation.suspended_at === null &&
      canonical(installation.permissions) === canonical(readerPermissions),
    "PROTECTION_READER_INSTALLATION_REJECTED",
  );
  const token = await request(
    `/app/installations/${config.installation_id}/access_tokens`,
    jwt,
    "POST",
    { repository_ids: [REPOSITORY_ID], permissions: { ...readerPermissions } },
    2 * 1024 ** 2,
  );
  need(
    typeof token.token === "string" &&
      /^[A-Za-z0-9_.-]{1,4096}$/.test(token.token) &&
      Date.parse(token.expires_at) > Date.now() + 60000 &&
      Date.parse(token.expires_at) <= Date.now() + 3660000 &&
      canonical(token.permissions) === canonical(readerPermissions),
    "PROTECTION_READER_TOKEN_REJECTED",
  );
  const repos = await request(
    "/installation/repositories?per_page=100&page=1",
    token.token,
    "GET",
    undefined,
    2 * 1024 ** 2,
  );
  need(
    repos.total_count === 1 &&
      repos.repositories?.length === 1 &&
      repos.repositories[0].id === REPOSITORY_ID &&
      repos.repositories[0].full_name === REPO,
    "PROTECTION_READER_REPOSITORY_REJECTED",
  );
  const client = async (route, method = "GET", body) => {
    validateProtectionRoute(route, method, body);
    need(Date.parse(token.expires_at) > Date.now() + 15000, "PROTECTION_READER_TOKEN_EXPIRED");
    return request(`/repos/${REPO}/${route}`, token.token, "GET", undefined, 2 * 1024 ** 2);
  };
  protectionReaders.set(client, canonical(config));
  return client;
}
export async function probeProtectionReader(writer, key, request = appRequest) {
  const reader = await protectionReaderClient(writer, key, request),
    main = await reader("branches/main");
  need(
    main.protected === true && /^[a-f0-9]{40}$/.test(main.commit?.sha),
    "APP_MAIN_NOT_PROTECTED",
  );
  const evidence = await inspectProtectionVisibility(reader),
    finalMain = await reader("branches/main");
  need(finalMain.protected === true && finalMain.commit?.sha === main.commit.sha, "APP_LIVE_DRIFT");
  return {
    schema: evidence.schema,
    outcome: "READ_ONLY_PROTECTION_VISIBILITY_OBSERVED",
    repository_id: REPOSITORY_ID,
    B: main.commit.sha,
    ruleset_count: evidence.ruleset_count,
    reader_app_id: writer.protection_reader.app_id,
    candidate_admission_authorized: false,
    release_authorized: false,
    live_a6_enforced: false,
  };
}
export async function installationClient(config, key, request = appRequest, reader) {
  validateAppConfig(config);
  need(config.protection_reader == null || reader !== undefined, "PROTECTION_READER_REQUIRED");
  if (reader !== undefined)
    need(
      config.protection_reader != null &&
        protectionReaders.get(reader) === canonical(config.protection_reader),
      "PROTECTION_READER_BINDING_REJECTED",
    );
  const jwt = appJWT(config, key),
    actual = await request("/app", jwt);
  need(actual.id === config.app_id && actual.slug === config.slug, "APP_ISSUER_REJECTED");
  const token = await request(
    `/app/installations/${config.installation_id}/access_tokens`,
    jwt,
    "POST",
    {
      repository_ids: [REPOSITORY_ID],
      permissions: { contents: "read", pull_requests: "read", actions: "read", checks: "write" },
    },
  );
  need(
    typeof token.token === "string" &&
      /^[A-Za-z0-9_.-]{1,4096}$/.test(token.token) &&
      Date.parse(token.expires_at) > Date.now() + 60000 &&
      Date.parse(token.expires_at) <= Date.now() + 3660000 &&
      canonical(token.permissions) ===
        canonical({
          contents: "read",
          pull_requests: "read",
          actions: "read",
          checks: "write",
          metadata: "read",
        }),
    "APP_TOKEN_SCOPE_REJECTED",
  );
  const repos = await request("/installation/repositories", token.token);
  need(
    repos.total_count === 1 &&
      repos.repositories?.length === 1 &&
      repos.repositories[0].id === REPOSITORY_ID,
    "APP_TOKEN_REPOSITORY_REJECTED",
  );
  const dispatch = (route, method = "GET", body) => {
    validateAppRoute(route, method);
    const prefix = `/repos/${REPO}/`,
      relative = route.startsWith(prefix) ? route.slice(prefix.length) : "";
    if (relative.split("?")[0] === "rulesets" || protectionPath(relative)) {
      need(reader !== undefined, "PROTECTION_READER_REQUIRED");
      return reader(relative, method, body);
    }
    return request(route, token.token, method, body);
  };
  const client = (route, method = "GET", body) => dispatch(`/repos/${REPO}/${route}`, method, body);
  // Source revalidation cannot accidentally route a private protection request
  // through the writer credential either.
  client.trustedSourceRead = (route) => dispatch(route);
  return client;
}
function contextOf(p, number) {
  need(
    Number.isSafeInteger(number) &&
      number > 0 &&
      p?.number === number &&
      p.base?.repo?.id === REPOSITORY_ID &&
      p.base.ref === "main" &&
      ((Number.isSafeInteger(p.head?.repo?.id) && p.head.repo.id > 0) ||
        (p.state === "closed" && p.head?.repo === null)) &&
      [p.head.sha, p.base.sha].every((v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v)) &&
      ["open", "closed"].includes(p.state) &&
      typeof p.draft === "boolean" &&
      typeof p.merged === "boolean" &&
      (p.merge_commit_sha === null || /^[a-f0-9]{40}$/.test(p.merge_commit_sha)),
    "APP_LIVE_DRIFT",
  );
  return {
    repository_id: REPOSITORY_ID,
    pr: number,
    H: p.head.sha,
    B: p.base.sha,
    M: p.merge_commit_sha,
    // GitHub can retain the immutable head SHA after a fork is deleted. Only
    // closed-PR bookkeeping may omit that repository; this never admits an
    // open source or writes an authorization for a missing repository.
    head_repository_id: p.head.repo?.id ?? null,
    state: p.state,
    draft: p.draft,
    merged: p.merged,
  };
}
function samePR(p, expected) {
  need(canonical(contextOf(p, expected.pr)) === canonical(expected), "APP_LIVE_DRIFT");
}
export async function invalidateAppCheck(read, item, reason = "APP_REVALIDATION_REQUIRED") {
  const before = await read(`check-runs/${item.check}`);
  need(
    before?.id === item.check &&
      before.name === APP_CHECK &&
      (item.H === undefined || before.head_sha === item.H),
    "APP_REVOCATION_UNCONFIRMED",
  );
  if (before.status === "completed" && before.conclusion === "failure") return before;
  const result = await read(`check-runs/${item.check}`, "PATCH", {
    status: "completed",
    conclusion: "failure",
    output: { title: CANDIDATE_TITLE, summary: reason },
  });
  need(
    result?.id === item.check &&
      result.status === "completed" &&
      result.conclusion === "failure" &&
      (item.H === undefined || result.head_sha === item.H),
    "APP_REVOCATION_UNCONFIRMED",
  );
}
// The required check API has no TTL. Persist observed heads BEFORE issuing any
// verdict so restart can reconcile old SHA checks; never claim outage-time
// revocation. The private journal grants no approval or check authority.
export function validateAppJournal(value, config) {
  validateAppConfig(config);
  need(
    value?.schema === "pc100-app-journal-v1" &&
      value.repository_id === REPOSITORY_ID &&
      value.app_id === config.app_id &&
      value.installation_id === config.installation_id &&
      Object.keys(value).sort().join(",") ===
        "app_id,entries,installation_id,repository_id,schema" &&
      Array.isArray(value.entries) &&
      value.entries.length <= 4000,
    "APP_JOURNAL_REJECTED",
  );
  const seen = new Set();
  for (const c of value.entries) {
    need(
      c &&
        Object.keys(c).sort().join(",") ===
          "B,H,M,draft,head_repository_id,merged,pr,repository_id,state" &&
        c.repository_id === REPOSITORY_ID &&
        Number.isSafeInteger(c.pr) &&
        c.pr > 0 &&
        Number.isSafeInteger(c.head_repository_id) &&
        c.head_repository_id > 0 &&
        [c.H, c.B].every((x) => typeof x === "string" && /^[a-f0-9]{40}$/.test(x)) &&
        (c.M === null || (typeof c.M === "string" && /^[a-f0-9]{40}$/.test(c.M))) &&
        ["open", "closed"].includes(c.state) &&
        typeof c.draft === "boolean" &&
        typeof c.merged === "boolean",
      "APP_JOURNAL_REJECTED",
    );
    const k = c.pr + ":" + c.H;
    need(!seen.has(k), "APP_JOURNAL_REJECTED");
    seen.add(k);
  }
  return value;
}
export async function openAppJournal(file, config) {
  need(process.platform === "linux", "APP_JOURNAL_REQUIRES_LINUX");
  assertExternalKeyPath(file);
  const dir = path.dirname(file),
    d = await lstat(dir);
  need(
    d.isDirectory() &&
      !d.isSymbolicLink() &&
      d.uid === process.geteuid() &&
      (d.mode & 0o077) === 0 &&
      (await realpath(dir)) === dir,
    "APP_JOURNAL_PERMISSIONS_REJECTED",
  );
  const fresh = {
    schema: "pc100-app-journal-v1",
    repository_id: REPOSITORY_ID,
    app_id: config.app_id,
    installation_id: config.installation_id,
    entries: [],
  };
  const read = async () => {
    let st;
    try {
      st = await lstat(file);
    } catch (e) {
      if (e.code === "ENOENT") return fresh;
      throw e;
    }
    need(
      st.isFile() &&
        !st.isSymbolicLink() &&
        st.nlink === 1 &&
        st.uid === process.geteuid() &&
        (st.mode & 0o077) === 0 &&
        st.size <= 2 * 1024 ** 2,
      "APP_JOURNAL_PERMISSIONS_REJECTED",
    );
    const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const now = await f.stat();
      need(
        now.ino === st.ino && now.dev === st.dev && now.size <= 2 * 1024 ** 2,
        "APP_JOURNAL_PERMISSIONS_REJECTED",
      );
      const bytes = Buffer.alloc(2 * 1024 ** 2 + 1);
      let count = 0;
      while (count < bytes.length) {
        const r = await f.read(bytes, count, bytes.length - count, count);
        if (r.bytesRead === 0) break;
        count += r.bytesRead;
      }
      need(count <= 2 * 1024 ** 2, "APP_JOURNAL_REJECTED");
      return validateAppJournal(readPolicyJSON(bytes.subarray(0, count)), config);
    } finally {
      await f.close();
    }
  };
  let value = await read();
  const update = async (change) => {
    const lock = file + ".lock";
    let handle;
    try {
      handle = await open(
        lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw Error("APP_JOURNAL_BUSY");
    }
    const temp = file + "." + randomBytes(12).toString("hex") + ".tmp";
    try {
      const next = validateAppJournal(change(await read()), config);
      const bytes = Buffer.from(canonical(next) + "\n");
      need(bytes.length <= 2 * 1024 ** 2, "APP_JOURNAL_REJECTED");
      const out = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await out.writeFile(bytes);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(temp, file);
      const directory = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      value = next;
    } finally {
      await unlink(temp).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      await handle.close();
      await unlink(lock);
    }
  };
  return {
    entries: () => globalThis.structuredClone(value.entries),
    record: async (c) => {
      if (value.entries.some((x) => canonical(x) === canonical(c))) return;
      await update((v) => ({
        ...v,
        entries: [...v.entries.filter((x) => x.pr !== c.pr || x.H !== c.H), c],
      }));
    },
    remove: async (c) =>
      update((v) => ({ ...v, entries: v.entries.filter((x) => x.pr !== c.pr || x.H !== c.H) })),
  };
}
export async function reconcileJournal(
  read,
  config,
  journal,
  revokeAll = false,
  visited = new Set(),
) {
  for (const prior of journal.entries()) {
    let current;
    try {
      current = contextOf(await read(`pulls/${prior.pr}`), prior.pr);
    } catch (e) {
      if (!revokeAll) throw e;
    }
    if (current?.state === "closed" && current.merged) {
      await journal.remove(prior);
      continue;
    }
    if (!revokeAll && canonical(current) === canonical(prior)) continue;
    const rows = await completePages(
      read,
      `commits/${prior.H}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all`,
      "check_runs",
    );
    for (const c of rows.filter((c) => c.name === APP_CHECK && c.app?.id === config.app_id)) {
      need(
        c.head_sha === prior.H &&
          c.app.slug === config.slug &&
          Number.isSafeInteger(c.id) &&
          c.id > 0,
        "APP_CHECK_ISSUER_REJECTED",
      );
      const key = `${c.id}:${prior.H}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (c.status !== "completed" || c.conclusion !== "failure")
        await invalidateAppCheck(
          read,
          { check: c.id, H: prior.H },
          "APP_RESTART_REVALIDATION_REQUIRED",
        );
    }
    await journal.remove(prior);
  }
  return visited;
}
/** Transport is an external dedicated App; never a PR GITHUB_TOKEN. */
export async function reconcileAppCheck(
  read,
  config,
  authorize = verifyCandidateEvent,
  number = 100,
  journal,
) {
  validateAppConfig(config);
  let pr = await read(`pulls/${number}`);
  const requested = contextOf(pr, number);
  if (number !== 100) {
    const candidate = await read("pulls/100"),
      identity = contextOf(candidate, 100);
    // Checks belong to commits, not PR aliases. A fork cannot invalidate or
    // authorize the canonical candidate merely by opening the same SHA.
    if (identity.state === "open" && !identity.merged && identity.H === requested.H) {
      pr = candidate;
      number = 100;
    }
  }
  const context = contextOf(pr, number);
  if (context.merged && context.state === "closed")
    return { ...context, terminal: true, conclusion: null, outcome: "APP_MERGED_TERMINAL" };
  if (journal) await journal.record(context);
  const rows = await completePages(
    read,
    `commits/${context.H}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all`,
    "check_runs",
  );
  const own = rows.filter((c) => c.name === APP_CHECK && c.app?.id === config.app_id);
  for (const c of own) {
    need(
      Number.isSafeInteger(c.id) &&
        c.id > 0 &&
        c.head_sha === context.H &&
        c.app.slug === config.slug,
      "APP_CHECK_ISSUER_REJECTED",
    );
  }
  if (own.length > 1) {
    for (const c of own)
      await invalidateAppCheck(read, { check: c.id }, "APP_DUPLICATE_CHECK_REJECTED");
    throw Error("APP_DUPLICATE_CHECK_REJECTED");
  }
  let record, failure, changedTree;
  try {
    need(pr.state === "open" && !pr.merged, "APP_PR_INACTIVE");
    if (number === 100) {
      need(
        context.head_repository_id === REPOSITORY_ID && /^[a-f0-9]{40}$/.test(context.M),
        "APP_LIVE_DRIFT",
      );
      const upstream = await selectUpstreamRun(read, pr);
      record = await authorize({ workflow_run: { id: upstream.id } }, context.B, read);
      need(
        record.H === context.H &&
          record.B === context.B &&
          record.M === context.M &&
          record.pr === 100 &&
          record.candidate_admission_authorized === true &&
          record.release_authorized === false,
        "APP_POLICY_RECORD_REJECTED",
      );
    } else {
      const candidate = contextOf(await read("pulls/100"), 100);
      need(
        candidate.state !== "open" || candidate.H !== context.H,
        "APP_HEAD_SHARED_WITH_CANDIDATE",
      );
      const main = await read("branches/main");
      need(
        main.protected === true && /^[a-f0-9]{40}$/.test(main.commit.sha),
        "APP_MAIN_NOT_PROTECTED",
      );
      // A required neutral check is a passing check. Never derive it from the
      // PR number: authenticate the complete immutable source closure first.
      // All tracked files are conservatively in scope, including new paths,
      // modes and transitive configuration. Changed source needs independent
      // registry authorization; an unfamiliar extension is not an exemption.
      need(context.B === main.commit.sha, "APP_LIVE_DRIFT");
      const [head, base] = await Promise.all([
        read(`git/commits/${context.H}`),
        read(`git/commits/${context.B}`),
      ]);
      need(
        head.sha === context.H &&
          base.sha === context.B &&
          /^[a-f0-9]{40}$/.test(head.tree?.sha) &&
          base.tree?.sha === main.commit.commit?.tree?.sha,
        "APP_SOURCE_IDENTITY_REJECTED",
      );
      const [headTree, baseTree] = await Promise.all([
        read(`git/trees/${head.tree.sha}?recursive=1`),
        read(`git/trees/${base.tree.sha}?recursive=1`),
      ]);
      need(
        headTree.sha === head.tree.sha && baseTree.sha === base.tree.sha,
        "APP_SOURCE_IDENTITY_REJECTED",
      );
      const inventory = sourceInventory(headTree),
        trusted = sourceInventory(baseTree);
      let sourceAuthority;
      if (canonical(inventory) !== canonical(trusted)) {
        need(typeof read.sourceAuthorization === "function", "APP_UNREVIEWED_SOURCE");
        sourceAuthority = await authorizeOrdinarySource(read, config, context, headTree);
        changedTree = headTree;
      }
      record = {
        schema: sourceAuthority
          ? "pc100-authorized-source-change-v1"
          : "pc100-app-not-applicable-v2",
        TH: head.tree.sha,
        TB: base.tree.sha,
        source_inventory_sha256: hash(canonical(inventory)),
        decision: sourceAuthority ? "AUTHORIZED_SOURCE_CHANGE" : "NOT_APPLICABLE",
        ...(sourceAuthority ?? {}),
        ...context,
        trusted_main_sha: main.commit.sha,
        candidate_admission_authorized: false,
        release_authorized: false,
      };
    }
    samePR(await read(`pulls/${number}`), context);
  } catch (e) {
    failure = safeError(e);
    record = undefined;
  }
  let publicRecord = record,
    publicTitle = CANDIDATE_TITLE;
  if (!failure && config.consumer_attestation === true && record.decision !== "NOT_APPLICABLE") {
    try {
      publicRecord = await appConsumerRecord(read, config, context, record, own[0]);
      publicTitle = "PC100 consumer attestation";
    } catch (error) {
      failure = safeError(error);
      record = undefined;
      publicRecord = undefined;
    }
  }
  const body = {
    name: APP_CHECK,
    head_sha: context.H,
    external_id: hash(canonical(publicRecord ?? context)),
    status: "completed",
    conclusion: failure
      ? "failure"
      : number === 100 || record.decision === "AUTHORIZED_SOURCE_CHANGE"
        ? "success"
        : "neutral",
    completed_at: new Date().toISOString(),
    output: {
      title: publicTitle,
      summary:
        canonical(
          publicRecord ?? {
            outcome: failure,
            ...context,
            candidate_admission_authorized: false,
            release_authorized: false,
          },
        ) + "\n",
    },
  };
  const existing = own[0],
    age = Date.now() - Date.parse(existing?.completed_at);
  const unchanged =
    existing?.status === "completed" &&
    existing.conclusion === body.conclusion &&
    existing.external_id === body.external_id &&
    existing.output?.title === body.output.title &&
    existing.output?.summary === body.output.summary &&
    (body.conclusion === "failure" || (Number.isFinite(age) && age >= 0 && age < 300000));
  // Revalidate every poll, but refresh a stable positive at most every five
  // minutes. This is consumer evidence freshness, NOT a native GitHub check TTL.
  const result = unchanged
    ? existing
    : await read(
        own.length ? `check-runs/${own[0].id}` : "check-runs",
        own.length ? "PATCH" : "POST",
        body,
      );
  need(
    Number.isSafeInteger(result.id) &&
      result.id > 0 &&
      result.app?.id === config.app_id &&
      result.app.slug === config.slug &&
      result.head_sha === context.H &&
      result.name === APP_CHECK &&
      result.conclusion === body.conclusion,
    "APP_CHECK_ISSUER_REJECTED",
  );
  try {
    samePR(await read(`pulls/${number}`), context);
    if (!failure) {
      if (number === 100) {
        const current = await authorize(
          { workflow_run: { id: record.upstream_run } },
          context.B,
          read,
        );
        need(canonical(current) === canonical(record), "APP_POLICY_REVOKED");
      } else {
        if (changedTree) {
          const current = await authorizeOrdinarySource(read, config, context, changedTree);
          need(current.authorization_sha256 === record.authorization_sha256, "APP_POLICY_REVOKED");
        }
        const candidate = contextOf(await read("pulls/100"), 100);
        need(
          candidate.state !== "open" || candidate.H !== context.H,
          "APP_HEAD_SHARED_WITH_CANDIDATE",
        );
        const main = await read("branches/main");
        need(
          main.protected === true && main.commit.sha === record.trusted_main_sha,
          "APP_LIVE_DRIFT",
        );
      }
    }
  } catch (e) {
    await invalidateAppCheck(read, { check: result.id }, "APP_LIVE_DRIFT");
    throw e;
  }
  return {
    check: result.id,
    ...context,
    conclusion: body.conclusion,
    outcome: failure ?? record.decision,
  };
}
export async function appConsumerRecord(
  read,
  config,
  context,
  authorization,
  existing,
  now = Date.now(),
) {
  const anchors = await readAppTrust(read, context.B);
  need(canonical(anchors.app) === canonical(config), "APP_SOURCE_ISSUER_DRIFT");
  const base = await read(`git/commits/${context.B}`),
    head = await read(`git/commits/${context.H}`),
    merge = await read(`git/commits/${context.M}`);
  const full = {
      repository_id: REPOSITORY_ID,
      pr: context.pr,
      H: context.H,
      B: context.B,
      M: context.M,
      TH: head.tree.sha,
      TB: base.tree.sha,
      TM: merge.tree.sha,
    },
    runs = {};
  if (context.pr === 100) {
    const r = await read(`actions/runs/${authorization.upstream_run}`);
    runs.preflight = { id: r.id, attempt: r.run_attempt, workflow_id: r.workflow_id };
  }
  for (const [role, path] of [
    ["supply", "supply-chain.yml"],
    ["ci", "ci.yml"],
    ["walking", "e2e.yml"],
  ]) {
    const rows = await completePages(
      read,
      `actions/workflows/${path}/runs?event=pull_request&head_sha=${context.H}`,
      "workflow_runs",
    );
    const candidates = rows.filter((r) => r.pull_requests?.some((p) => p.number === context.pr));
    need(candidates.length <= 1, "APP_UPSTREAM_AMBIGUOUS");
    const r = candidates[0];
    if (r?.status === "completed" && r.conclusion === "success")
      runs[role] = { id: r.id, attempt: r.run_attempt, workflow_id: r.workflow_id };
  }
  let record = await createConsumerAttestation(
    read,
    anchors,
    full,
    authorization,
    runs,
    context.pr === 100 ? ["preflight"] : ["ci"],
    now,
  );
  if (existing?.output?.title === "PC100 consumer attestation") {
    const old = decodeAuthorityJSON(Buffer.from(existing.output.summary));
    const { observed_at, expires_at, ...prior } = old;
    const { observed_at: _observed, expires_at: _expires, ...current } = record;
    const age = now - Date.parse(observed_at);
    if (
      canonical(prior) === canonical(current) &&
      age >= 0 &&
      age < 300000 &&
      Date.parse(expires_at) - Date.parse(observed_at) === 600000
    )
      record = old;
  }
  return record;
}
export async function authorizeOrdinarySource(read, config, context, headTree) {
  need(
    context.pr !== 100 && context.head_repository_id === REPOSITORY_ID,
    "APP_SOURCE_ALIAS_REJECTED",
  );
  const anchors = await readAppTrust(read, context.B);
  need(canonical(anchors.app) === canonical(config), "APP_SOURCE_ISSUER_DRIFT");
  need(anchors.trust.source_authority !== null, "APP_SOURCE_AUTHORITY_NOT_CONFIGURED");
  const aliases = (await completePages(read, "pulls?state=open&base=main")).filter(
    (p) => p.head?.sha === context.H,
  );
  need(aliases.length === 1 && aliases[0].number === context.pr, "APP_SOURCE_ALIAS_REJECTED");
  const raw = await read.sourceAuthorization(context);
  return verifySourceAuthorization(
    decodeAuthorityJSON(raw, 4 * 1024 ** 2),
    anchors,
    context,
    headTree,
  );
}
/** Every open main PR receives this context, including registry and Dependabot PRs. */
async function reconcileCycle(read, config, tracked, journal) {
  const listed = await completePages(read, "pulls?state=open&base=main");
  const numbers = new Set([100, ...tracked.keys()]),
    seen = new Set();
  for (const p of listed) {
    need(
      Number.isSafeInteger(p.number) &&
        p.number > 0 &&
        p.state === "open" &&
        p.base?.ref === "main" &&
        p.base.repo?.id === REPOSITORY_ID,
      "APP_LIVE_DRIFT",
    );
    need(!seen.has(p.number), "APP_DUPLICATE_PR");
    seen.add(p.number);
    numbers.add(p.number);
  }
  const current = new Map(),
    groups = new Map(),
    results = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const c = contextOf(await read(`pulls/${n}`), n);
    current.set(n, c);
    if (c.state === "open" && !c.merged) {
      const g = groups.get(c.H) ?? [];
      g.push(n);
      groups.set(c.H, g);
    }
  }
  for (const [n, c] of current) {
    const old = tracked.get(n);
    if (c.merged && c.state === "closed") {
      tracked.delete(n);
      results.push({ ...c, terminal: true, conclusion: null, outcome: "APP_MERGED_TERMINAL" });
      continue;
    }
    if (
      old &&
      !groups.has(old.H) &&
      (old.H !== c.H || old.B !== c.B || old.M !== c.M || c.state !== "open")
    )
      await invalidateAppCheck(read, old, "APP_LIVE_DRIFT");
    if (c.state !== "open") tracked.delete(n);
  }
  for (const members of groups.values()) {
    const n = members.includes(100) ? 100 : members[0];
    const result = await reconcileAppCheck(read, config, verifyCandidateEvent, n, journal);
    for (const alias of members) {
      const item = { ...result, pr: alias };
      tracked.set(alias, item);
      results.push(item);
    }
  }
  return results;
}
export async function reconcileAppCycle(read, config, tracked = new Map(), journal) {
  try {
    if (journal) await reconcileJournal(read, config, journal);
    return await reconcileCycle(read, config, tracked, journal);
  } catch (error) {
    const visited = new Set();
    if (journal) {
      try {
        await reconcileJournal(read, config, journal, true, visited);
      } catch {
        console.error("APP_REVOCATION_UNCONFIRMED");
      }
    }
    for (const item of tracked.values()) {
      const key = `${item.check}:${item.H}`;
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        await invalidateAppCheck(read, item, safeError(error));
      } catch {
        /* API outage: caller must fail; never report successful revocation. */
      }
    }
    throw error;
  }
}
async function trustedHostSource(request = appRequest) {
  assertExternalHost(process.env);
  need(process.platform === "linux", "APP_TRUSTED_HOST_REQUIRES_LINUX");
  need(
    process.versions.node.split(".")[0] === "24" && process.execArgv.length === 0,
    "APP_RUNTIME_REJECTED",
  );
  const main = await request(`/repos/${REPO}/branches/main`);
  need(main.protected === true, "APP_MAIN_NOT_PROTECTED");
  const B = main.commit.sha,
    git = (args) =>
      execFileSync(
        "git",
        ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
        {
          cwd: root,
          env: withoutQualificationCredentials(process.env),
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 16 * 1024 ** 2,
        },
      );
  need(
    git(["rev-parse", "HEAD"]).trim() === B &&
      !git(["status", "--porcelain", "--untracked-files=all"]).trim(),
    "APP_CHECKOUT_NOT_PROTECTED_MAIN",
  );
  const commit = await request(`/repos/${REPO}/git/commits/${B}`),
    tree = treeEntries(await request(`/repos/${REPO}/git/trees/${commit.tree.sha}?recursive=1`));
  for (const p of [
    APP_ENGINE,
    ENGINE,
    REGISTRY,
    APP_CONFIG,
    "tools/test/pc100-source-verifier.mjs",
    TRUST_CONFIG,
    ATTESTATION_ENGINE,
  ]) {
    const e = tree.get(p),
      b = await readFile(path.join(root, p));
    need(
      e?.mode === "100644" &&
        createHash("sha1")
          .update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]))
          .digest("hex") === e.sha,
      "APP_BOOTSTRAP_SOURCE_DRIFT",
    );
  }
  return validateAppConfig(readPolicyJSON(await readFile(path.join(root, APP_CONFIG))));
}
export function assertExternalKeyPath(file, checkout = root) {
  const relative = path.relative(checkout, file);
  need(
    path.isAbsolute(file) && (relative === ".." || relative.startsWith(".." + path.sep)),
    "APP_KEY_INSIDE_REPOSITORY",
  );
}
export async function readExternalKeyFile(file, cap = 65536) {
  need([65536, 4 * 1024 ** 2].includes(cap), "APP_FILE_LIMIT_REJECTED");
  assertExternalKeyPath(file);
  const parent = await lstat(path.dirname(file));
  need(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      parent.uid === process.geteuid() &&
      (parent.mode & 0o077) === 0,
    "APP_KEY_DIRECTORY_REJECTED",
  );
  const s = await lstat(file);
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1 &&
      s.size <= cap &&
      (s.mode & 0o077) === 0 &&
      s.uid === process.geteuid(),
    "APP_KEY_PERMISSIONS_REJECTED",
  );
  need((await realpath(file)) === file, "APP_KEY_PATH_REJECTED");
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const t = await f.stat();
    need(t.ino === s.ino && t.dev === s.dev, "APP_KEY_PATH_REJECTED");
    const buffer = Buffer.alloc(cap + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const r = await f.read(buffer, bytes, buffer.length - bytes, null);
      if (!r.bytesRead) break;
      bytes += r.bytesRead;
    }
    need(bytes <= cap, "APP_FILE_LIMIT_REJECTED");
    return buffer.subarray(0, bytes);
  } finally {
    await f.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = new Map();
  let client, journal, config;
  try {
    need(
      [4, 5].includes(process.argv.length) &&
        ["--once", "--watch", "--probe-protection"].includes(process.argv[2]),
      "APP_ARGUMENTS_REJECTED",
    );
    config = await trustedHostSource();
    if (process.argv[2] === "--probe-protection") {
      need(process.argv.length === 4, "APP_ARGUMENTS_REJECTED");
      const result = await probeProtectionReader(
        config,
        await readExternalKeyFile(process.argv[3]),
      );
      need(
        canonical(await trustedHostSource()) === canonical(config),
        "APP_BASE_CHANGED_RESTART_REQUIRED",
      );
      console.log(canonical(result));
      process.exit(0);
    }
    need(
      process.argv.length === (config.protection_reader == null ? 4 : 5),
      "PROTECTION_READER_KEY_REQUIRED",
    );
    need(process.argv[3] !== process.argv[4], "PROTECTION_READER_KEY_REUSE_REJECTED");
    const key = await readExternalKeyFile(process.argv[3]);
    const readerKey =
      config.protection_reader == null ? undefined : await readExternalKeyFile(process.argv[4]);
    need(readerKey === undefined || !readerKey.equals(key), "PROTECTION_READER_KEY_REUSE_REJECTED");
    journal = await openAppJournal(
      path.join(
        path.dirname(process.argv[3]),
        `pc100-${config.app_id}-${config.installation_id}.checks.json`,
      ),
      config,
    );
    let stopping = false;
    const wake = new globalThis.AbortController();
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        stopping = true;
        wake.abort();
      });
    do {
      const reader =
        readerKey === undefined ? undefined : await protectionReaderClient(config, readerKey);
      client = await installationClient(config, key, appRequest, reader);
      // Revalidate the installed source/base before every operation, not just startup.
      try {
        need(
          canonical(await trustedHostSource(client.trustedSourceRead)) === canonical(config),
          "APP_BASE_CHANGED_RESTART_REQUIRED",
        );
      } catch (e) {
        for (const item of tracked.values()) await invalidateAppCheck(client, item, safeError(e));
        throw e;
      }
      client.sourceBytes = readGitSourceBytes;
      // Signed public review records live outside the checkout. No private key
      // for this independent authority is loaded by this controller. The main
      // trust config remains null until separately reviewed Owner installation.
      client.sourceAuthorization = (c) => {
        need(
          /^[a-f0-9]{40}$/.test(c.H) &&
            /^[a-f0-9]{40}$/.test(c.B) &&
            Number.isSafeInteger(c.pr) &&
            c.pr > 0,
          "SOURCE_AUTHORIZATION_REJECTED",
        );
        return readExternalKeyFile(
          path.join(path.dirname(process.argv[3]), `${c.H}-${c.B}-${c.pr}.source-review.json`),
          4 * 1024 ** 2,
        );
      };
      const results = await reconcileAppCycle(client, config, tracked, journal);
      console.log(JSON.stringify(results));
      if (process.argv[2] === "--once" && results.some((r) => r.conclusion === "failure"))
        process.exitCode = 1;
      if (process.argv[2] === "--once") break;
      if (!stopping)
        await sleep(60000, undefined, { signal: wake.signal }).catch((e) => {
          if (e.name !== "AbortError") throw e;
        });
    } while (process.argv[2] === "--watch" && !stopping);
    if (stopping) await reconcileJournal(client, config, journal, true);
  } catch (e) {
    if (client && journal) {
      try {
        await reconcileJournal(client, config, journal, true);
      } catch {
        console.error("APP_REVOCATION_UNCONFIRMED");
      }
    }
    if (client)
      for (const item of tracked.values()) {
        try {
          await invalidateAppCheck(client, item, safeError(e));
        } catch {
          console.error("APP_REVOCATION_UNCONFIRMED");
        }
      }
    console.error(JSON.stringify({ outcome: safeError(e) }));
    process.exitCode = 1;
  }
}
