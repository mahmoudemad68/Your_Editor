/** Dedicated external App controller. Never run by a PR workflow. No third-party dependencies. */
import { createPrivateKey, createHash, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, lstat, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";
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
  for (const k of Object.keys(env))
    need(
      !/^(GITHUB_|ACTIONS_|RUNNER_|GH_TOKEN$|PC100_METADATA_TOKEN$|NODE_OPTIONS$|NODE_PATH$)/i.test(
        k,
      ),
      "APP_PR_RUNNER_FORBIDDEN",
    );
}
export async function appRequest(route, token, method = "GET", body) {
  need(
    /^\/(app(?:\/installations\/[1-9][0-9]*\/access_tokens)?|repos\/mahmoudemad68\/Your_Editor(?:\/[^#\r\n]*)?|installation\/repositories)$/.test(
      route,
    ) && !route.includes(".."),
    "APP_ROUTE_REJECTED",
  );
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
function samePR(p, expected) {
  need(
    [expected.H, expected.B, expected.M].every(
      (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
    ) &&
      p.number === 100 &&
      p.state === "open" &&
      p.draft &&
      !p.merged &&
      p.head.repo.id === REPOSITORY_ID &&
      p.base.repo.id === REPOSITORY_ID &&
      p.head.sha === expected.H &&
      p.base.sha === expected.B &&
      p.merge_commit_sha === expected.M,
    "APP_LIVE_DRIFT",
  );
}
/** The supplied transport owns a dedicated App token; PR GITHUB_TOKEN is never used. */
export async function reconcileAppCheck(read, config, authorize = verifyCandidateEvent) {
  validateAppConfig(config);
  const pr = await read("pulls/100"),
    context = { H: pr.head.sha, B: pr.base.sha, M: pr.merge_commit_sha };
  samePR(pr, context);
  let record, failure;
  try {
    const upstream = await selectUpstreamRun(read, pr);
    record = await authorize({ workflow_run: { id: upstream.id } }, context.B, read);
    need(
      record.H === context.H &&
        record.B === context.B &&
        record.M === context.M &&
        record.candidate_admission_authorized === true &&
        record.release_authorized === false,
      "APP_POLICY_RECORD_REJECTED",
    );
  } catch (e) {
    failure = safeError(e);
  }
  samePR(await read("pulls/100"), context);
  const rows = await completePages(
    read,
    `commits/${context.H}/check-runs?check_name=${encodeURIComponent(APP_CHECK)}&filter=all`,
    "check_runs",
  );
  const own = rows.filter((c) => c.name === APP_CHECK && c.app?.id === config.app_id);
  need(own.length <= 1, "APP_DUPLICATE_CHECK_REJECTED");
  const body = {
    name: APP_CHECK,
    head_sha: context.H,
    external_id: record ? hash(canonical(record)) : hash(canonical(context)),
    status: "completed",
    conclusion: failure ? "failure" : "success",
    completed_at: new Date().toISOString(),
    output: {
      title: CANDIDATE_TITLE,
      summary:
        (record
          ? canonical(record)
          : canonical({ outcome: failure, ...context, release_authorized: false })) + "\n",
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
      result.head_sha === context.H &&
      result.name === APP_CHECK &&
      result.conclusion === body.conclusion,
    "APP_CHECK_ISSUER_REJECTED",
  );
  try {
    samePR(await read("pulls/100"), context);
  } catch (e) {
    await read(`check-runs/${result.id}`, "PATCH", {
      status: "completed",
      conclusion: "failure",
      output: { title: CANDIDATE_TITLE, summary: "APP_LIVE_DRIFT" },
    });
    throw e;
  }
  return {
    check: result.id,
    H: context.H,
    conclusion: body.conclusion,
    outcome: failure ?? "SECURITY_CANDIDATE_ADMISSION_AUTHORIZED",
  };
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
async function privateKey(file) {
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
  try {
    need(
      process.argv.length === 4 && ["--once", "--watch"].includes(process.argv[2]),
      "APP_ARGUMENTS_REJECTED",
    );
    const config = await trustedHostSource(),
      key = await privateKey(process.argv[3]);
    do {
      const client = await installationClient(config, key);
      // Revalidate the installed source/base before every operation, not just startup.
      need(
        canonical(await trustedHostSource(client.trustedSourceRead)) === canonical(config),
        "APP_BASE_CHANGED_RESTART_REQUIRED",
      );
      client.sourceBytes = readGitSourceBytes;
      console.log(JSON.stringify(await reconcileAppCheck(client, config)));
      if (process.argv[2] === "--once") break;
      await sleep(60000);
    } while (process.argv[2] === "--watch");
  } catch (e) {
    console.error(JSON.stringify({ outcome: safeError(e) }));
    process.exitCode = 1;
  }
}
