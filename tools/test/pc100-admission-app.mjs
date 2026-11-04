/** Dedicated external App controller. Never run by a PR workflow. No third-party dependencies. */
import { createPrivateKey, createHash, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, lstat, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath, URLSearchParams } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  APP_CONFIG,
  APP_ENGINE,
  ENGINE,
  REGISTRY,
  CANDIDATE_TITLE,
  APP_CHECK,
  validateAppConfig,
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
export async function appRequest(route, token, method = "GET", body) {
  validateAppRoute(route, method);
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
    need(size <= 24 * 1024 ** 2, "APP_RESPONSE_TOO_LARGE");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function appJWT(config, key, now = Date.now()) {
  validateAppConfig(config);
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
        iss: String(config.app_id),
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
export async function installationClient(config, key, request = appRequest) {
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
  const client = (route, method = "GET", body) =>
    request(`/repos/${REPO}/${route}`, token.token, method, body);
  client.trustedSourceRead = (route) => request(route, token.token);
  return client;
}
function contextOf(p, number) {
  need(
    Number.isSafeInteger(number) &&
      number > 0 &&
      p?.number === number &&
      p.base?.repo?.id === REPOSITORY_ID &&
      p.base.ref === "main" &&
      Number.isSafeInteger(p.head?.repo?.id) &&
      p.head.repo.id > 0 &&
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
    head_repository_id: p.head.repo.id,
    state: p.state,
    draft: p.draft,
    merged: p.merged,
  };
}
function samePR(p, expected) {
  need(canonical(contextOf(p, expected.pr)) === canonical(expected), "APP_LIVE_DRIFT");
}
export async function invalidateAppCheck(read, item, reason = "APP_REVALIDATION_REQUIRED") {
  await read(`check-runs/${item.check}`, "PATCH", {
    status: "completed",
    conclusion: "failure",
    output: { title: CANDIDATE_TITLE, summary: reason },
  });
}
/** Transport is an external dedicated App; never a PR GITHUB_TOKEN. */
export async function reconcileAppCheck(
  read,
  config,
  authorize = verifyCandidateEvent,
  number = 100,
) {
  validateAppConfig(config);
  const pr = await read(`pulls/${number}`),
    context = contextOf(pr, number);
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
    // Revoke old positives BEFORE policy/API evaluation can fail.
    await invalidateAppCheck(read, { check: c.id });
  }
  need(own.length <= 1, "APP_DUPLICATE_CHECK_REJECTED");
  let record, failure;
  try {
    need(pr.state === "open" && !pr.merged && (number !== 100 || pr.draft), "APP_PR_INACTIVE");
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
      record = {
        schema: "pc100-app-not-applicable-v1",
        decision: "NOT_APPLICABLE",
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
  const body = {
    name: APP_CHECK,
    head_sha: context.H,
    external_id: hash(canonical(record ?? context)),
    status: "completed",
    conclusion: failure ? "failure" : number === 100 ? "success" : "neutral",
    completed_at: new Date().toISOString(),
    output: {
      title: CANDIDATE_TITLE,
      summary:
        canonical(
          record ?? {
            outcome: failure,
            ...context,
            candidate_admission_authorized: false,
            release_authorized: false,
          },
        ) + "\n",
    },
  };
  const result = await read(
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
/** Every open main PR receives this context, including registry and Dependabot PRs. */
async function reconcileCycle(read, config, tracked) {
  const listed = await completePages(read, "pulls?state=open&base=main");
  const numbers = new Set([100, ...tracked.keys()]);
  const seen = new Set();
  for (const p of listed) {
    contextOf(p, p.number);
    need(!seen.has(p.number), "APP_DUPLICATE_PR");
    seen.add(p.number);
    numbers.add(p.number);
  }
  const results = [];
  for (const n of numbers) {
    const old = tracked.get(n);
    try {
      const current = contextOf(await read(`pulls/${n}`), n);
      if (
        old &&
        (old.H !== current.H ||
          old.B !== current.B ||
          old.M !== current.M ||
          current.state !== "open" ||
          (n === 100 && !current.draft))
      )
        await invalidateAppCheck(read, old, "APP_LIVE_DRIFT");
      const result = await reconcileAppCheck(read, config, verifyCandidateEvent, n);
      tracked.set(n, result);
      results.push(result);
    } catch (e) {
      if (old) await invalidateAppCheck(read, old, safeError(e));
      results.push({ pr: n, conclusion: "failure", outcome: safeError(e) });
    }
  }
  return results;
}
export async function reconcileAppCycle(read, config, tracked = new Map()) {
  try {
    return await reconcileCycle(read, config, tracked);
  } catch (error) {
    for (const item of tracked.values()) {
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
export async function readExternalKeyFile(file) {
  assertExternalKeyPath(file);
  const s = await lstat(file);
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1 &&
      s.size <= 65536 &&
      (s.mode & 0o077) === 0 &&
      s.uid === process.geteuid(),
    "APP_KEY_PERMISSIONS_REJECTED",
  );
  need((await realpath(file)) === file, "APP_KEY_PATH_REJECTED");
  const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const t = await f.stat();
    need(t.ino === s.ino && t.dev === s.dev, "APP_KEY_PATH_REJECTED");
    return await f.readFile();
  } finally {
    await f.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = new Map();
  let client;
  try {
    need(
      process.argv.length === 4 && ["--once", "--watch"].includes(process.argv[2]),
      "APP_ARGUMENTS_REJECTED",
    );
    const config = await trustedHostSource(),
      key = await readExternalKeyFile(process.argv[3]);
    do {
      client = await installationClient(config, key);
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
      const results = await reconcileAppCycle(client, config, tracked);
      console.log(JSON.stringify(results));
      if (process.argv[2] === "--once" && results.some((r) => r.conclusion === "failure"))
        process.exitCode = 1;
      if (process.argv[2] === "--once") break;
      await sleep(60000);
    } while (process.argv[2] === "--watch");
  } catch (e) {
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
