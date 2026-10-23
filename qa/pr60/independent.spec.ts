/**
 * Independent QA probes for PR #60 (QA-authored; not the Coding Agent's tests).
 * Black-box against the real Compose stack: real browser UI, real HTTP with session cookies,
 * direct PostgreSQL / Redis / S3 inspection, and Docker-level fault injection.
 * Evidence written to QA_OUT is sanitized: no transcript text, credentials, cookies or storage keys.
 */
import { test, expect, request as pwRequest, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP = process.env.QA_APP_ROOT!;
const OUT = process.env.QA_OUT!;
const INPUTS = process.env.QA_INPUTS!;
const PRIVATE = process.env.QA_PRIVATE!;
const PY = process.env.QA_PY!;
const API = "http://localhost:3001";
const WEB = "http://localhost:3000";
const SMALL_SHA = "4e456821bbeabf0923f07220a86c1c14a8820bc83e78ae638d4474207b70aedd";
const rootRequire = createRequire(path.join(APP, "package.json"));
const webRequire = createRequire(path.join(APP, "apps/web/package.json"));
const { Pool } = rootRequire("pg");
const { S3Client, GetObjectCommand } = rootRequire("@aws-sdk/client-s3");
const pool = new Pool({ connectionString: "postgresql://editagent:editagent-dev-password@localhost:5432/editagent", max: 4 });
const s3 = new S3Client({
  endpoint: "http://localhost:9000", region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: "editagent", secretAccessKey: "editagent-dev-secret" },
});

type Status = "PASS" | "FAIL" | "ERROR" | "NOT_RUN";
const results: { id: string; title: string; status: Status; expected: string; actual: unknown; ms: number }[] = [];
const save = () =>
  writeFileSync(path.join(OUT, "qa-results.json"),
    JSON.stringify({ appSha: process.env.QA_APP_SHA, generatedAt: new Date().toISOString(), results }, null, 2));
async function probe(id: string, title: string, expected: string, fn: () => Promise<{ pass: boolean | null; actual: unknown }>) {
  const start = Date.now();
  try {
    const r = await fn();
    results.push({ id, title, status: r.pass === null ? "NOT_RUN" : r.pass ? "PASS" : "FAIL", expected, actual: r.actual, ms: Date.now() - start });
  } catch (e) {
    results.push({ id, title, status: "ERROR", expected, actual: String(e).slice(0, 600), ms: Date.now() - start });
  }
  save();
  console.log(`[QA] ${id} ${results.at(-1)!.status} ${title}`);
}

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const docker = (...args: string[]) => execFileSync("docker", args, { cwd: APP, encoding: "utf8", env: process.env, timeout: 600_000 });
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string, every = 500): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${label}`);
}

type User = { ctx: BrowserContext; page: Page; email: string; password: string; id: string };
async function newUser(browser: Browser, label: string): Promise<User> {
  const ctx = await browser.newContext({ baseURL: WEB, acceptDownloads: true });
  const page = await ctx.newPage();
  const email = `qa-${label}-${randomUUID()}@example.test`, password = `Qa-only-${randomUUID()}!`;
  await page.goto("/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const [row] = await q("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);
  return { ctx, page, email, password, id: row.id };
}
async function call(u: User | null, method: "GET" | "POST", url: string, body?: unknown, csrf = true) {
  const ctx = u ? u.ctx.request : await pwRequest.newContext();
  const send = async () => {
    const headers: Record<string, string> = { origin: WEB };
    if (u && method !== "GET" && csrf) {
      const token = (await u.ctx.cookies(API)).find((c) => c.name === "editagent_csrf")?.value;
      if (token) headers["x-editagent-csrf"] = token;
    }
    return ctx.fetch(API + url, { method, headers, data: body, failOnStatusCode: false, timeout: 60_000 });
  };
  let res = await send();
  if (u && res.status() === 401) {
    const token = (await u.ctx.cookies(API)).find((c) => c.name === "editagent_csrf")?.value;
    await ctx.fetch(API + "/auth/refresh", { method: "POST", headers: { origin: WEB, ...(token ? { "x-editagent-csrf": token } : {}) }, failOnStatusCode: false });
    res = await send();
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  const out = { status: res.status(), json, headers: res.headers() };
  if (!u) await ctx.dispose();
  return out;
}
// Administrative membership changes must respect the Project aggregate's chronology invariant
// (membership.createdAt within [project.createdAt, project.updatedAt]), exactly as the product's own
// membership commands advance updated_at/revision. A raw insert without this makes the Project unloadable.
async function setMembership(project: string, user: string, role: "viewer" | "editor" | null) {
  const now = Date.now();
  if (role === null) await q("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [project, user]);
  else await q(`INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (project_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [project, user, role, now]);
  await q("UPDATE projects SET updated_at=GREATEST(updated_at,$2), revision=revision+1 WHERE id=$1", [project, now]);
}
const getDoc = async (u: User, p: string, m: string) => call(u, "GET", `/projects/${p}/media/${m}/analysis`);
const tasks = (m: string) => q(
  `SELECT t.job_id,t.analyzer,t.generation::int AS generation,t.applied,j.status,(t.result IS NOT NULL) AS has_result,
          t.failure->>'code' AS failure_code,(SELECT count(*)::int FROM job_attempts a WHERE a.job_id=t.job_id) AS attempts
     FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.media_asset_id=$1 ORDER BY t.analyzer,t.generation`, [m]);
const latest = async (m: string, analyzer: string) => (await tasks(m)).filter((t) => t.analyzer === analyzer).at(-1);
const dbDoc = async (m: string) => (await q("SELECT document,revision::int AS revision,source_sha256 FROM media_analyses WHERE media_asset_id=$1", [m]))[0];
const terminal = (s: string) => ["Completed", "Failed", "Cancelled"].includes(s);
async function settled(m: string, ms = 300_000) {
  return until(async () => {
    const t = await tasks(m);
    const d = await dbDoc(m);
    const ok = t.length > 0 && t.every((x) => terminal(x.status) && x.applied) && d &&
      ["completed", "failed"].includes(d.document.sections.transcript.status) && ["completed", "failed"].includes(d.document.sections.audio.status);
    return ok ? { t, d } : null;
  }, ms, `analysis settled for ${m}`);
}
async function retry(u: User, m: string, analyzer: string, previousJobId: string, csrf = true) {
  return call(u, "POST", `/media/${m}/analysis/${analyzer}/retry`, { previousJobId }, csrf);
}
async function waitJob(jobId: string, pred: (s: string) => boolean, ms: number, every = 100) {
  return until(async () => {
    const [r] = await q("SELECT status FROM jobs WHERE id=$1", [jobId]);
    return r && pred(r.status) ? r.status : null;
  }, ms, `job ${jobId}`, every);
}
async function waitApplied(jobId: string, ms = 300_000) {
  return until(async () => {
    const [r] = await q("SELECT t.applied,j.status FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.job_id=$1", [jobId]);
    return r && r.applied && terminal(r.status) ? r.status : null;
  }, ms, `applied ${jobId}`);
}
function wordChecks(doc: any) {
  const words = doc.sections.transcript.status === "completed" ? doc.sections.transcript.data.segments.flatMap((s: any) => s.words) : [];
  const dur = BigInt(doc.source.durationUs);
  let prev = 0n, bad = 0;
  for (const w of words) {
    const s = BigInt(w.startUs), e = BigInt(w.endUs);
    if (!(s >= prev && s < e && e <= dur && w.confidence >= 0 && w.confidence <= 1 && String(w.text).trim())) bad++;
    prev = e;
  }
  return { words: words.length, violations: bad };
}

test("PR60 independent QA: US-210 real services and browser-to-export", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PRIVATE, { recursive: true });
  const src = path.join(INPUTS, "qa-source.mp4"), noAudio = path.join(INPUTS, "qa-noaudio.mp4");
  const srcSha = sha(readFileSync(src));
  const schemasModule: any = await import(pathToFileURL(webRequire.resolve("@editagent/schemas")).href);
  const parseMediaAnalysis = schemasModule.parseMediaAnalysis ?? schemasModule.default?.parseMediaAnalysis;

  const owner = await newUser(browser, "owner");
  const member = await newUser(browser, "member");
  const outsider = await newUser(browser, "outsider");
  const hideAccount = (p: Page) => [p.locator("header .text-muted")];
  const apiRequests: string[] = [];
  owner.page.on("request", (r) => { if (r.url().startsWith(WEB + "/api/") || r.url().startsWith(API)) apiRequests.push(new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, ":id")); });
  const completes: { url: string; body: string }[] = [];
  owner.page.on("request", (r) => { if (r.method() === "POST" && /uploads\/complete/.test(r.url())) completes.push({ url: r.url(), body: r.postData() ?? "" }); });

  // ---------- Setup via the real UI ----------
  const page = owner.page;
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill("QA independent PR60");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Open project" }).first().click();
  await expect(page.locator("#media-file")).toBeAttached();
  const P = new URL(page.url()).pathname.split("/").pop()!;
  await page.locator("#media-file").setInputFiles(src);
  await expect(page.getByRole("region", { name: "Inspection job" }).getByText("Completed", { exact: true })).toBeVisible({ timeout: 120_000 });
  const library = page.getByRole("region", { name: "Media Library" });
  await expect(library.getByRole("link", { name: "Edit video" })).toBeVisible({ timeout: 120_000 });
  const M = new URL((await library.getByRole("link", { name: "Edit video" }).getAttribute("href"))!, page.url()).searchParams.get("media")!;
  let M3 = "";
  await page.screenshot({ path: path.join(OUT, "01-upload-inspection.png"), fullPage: true, mask: hideAccount(page) });

  // ---------- QA-F1: US-210 ----------
  await probe("F1-01", "Upload persisted with exact bytes in PostgreSQL and S3", "media_assets.content_sha256 and the stored S3 object both equal the uploaded file SHA-256", async () => {
    const [a] = await q("SELECT project_id,content_sha256,byte_size::bigint AS size,storage_key FROM media_assets WHERE id=$1", [M]);
    const obj = await s3.send(new GetObjectCommand({ Bucket: "editagent", Key: a.storage_key }));
    const objSha = sha(Buffer.from(await obj.Body.transformToByteArray()));
    return { pass: a.project_id === P && a.content_sha256 === srcSha && objSha === srcSha, actual: { projectMatches: a.project_id === P, dbShaMatches: a.content_sha256 === srcSha, s3ShaMatches: objSha === srcSha, sizeBytes: String(a.size) } };
  });

  let initial: any;
  await probe("F1-02", "Analysis admitted automatically and settles", "analysis_tasks created without manual trigger; all terminal+applied; transcript and audio sections completed", async () => {
    initial = await settled(M);
    const t = initial.t;
    return { pass: t.every((x: any) => x.status === "Completed") && initial.d.document.sections.transcript.status === "completed" && initial.d.document.sections.audio.status === "completed",
      actual: { tasks: t.map((x: any) => ({ analyzer: x.analyzer, generation: x.generation, status: x.status, applied: x.applied })), revision: initial.d.revision } };
  });

  let doc: any;
  await probe("F1-03", "Authenticated GET returns schema-valid, versioned, provenance-bound MediaAnalysis", "200, private no-store, parseMediaAnalysis OK, source SHA equals upload, Small model pinned, ordered in-bounds words with confidence", async () => {
    const r = await getDoc(owner, P, M);
    doc = r.json;
    let schemaOk = false, schemaError = null;
    try { parseMediaAnalysis(doc); schemaOk = true; } catch (e) { schemaError = String(e).slice(0, 200); }
    const tr = doc?.sections?.transcript, wc = doc ? wordChecks(doc) : null;
    const otherSections = Object.fromEntries(Object.entries(doc?.sections ?? {}).map(([k, v]: any) => [k, v.status]));
    const ok = r.status === 200 && /private/.test(r.headers["cache-control"] ?? "") && /no-store/.test(r.headers["cache-control"] ?? "") && schemaOk &&
      doc.mediaAssetId === M && doc.source.sha256 === srcSha && tr.status === "completed" && tr.data.language === "en" &&
      tr.provenance.model.name === "faster-whisper-small" && tr.provenance.model.sha256 === SMALL_SHA && wc!.words > 0 && wc!.violations === 0;
    return { pass: ok, actual: { status: r.status, cacheControl: r.headers["cache-control"], schemaVersion: doc?.schemaVersion, schemaOk, schemaError,
      mediaAssetIdMatches: doc?.mediaAssetId === M, sourceShaMatches: doc?.source?.sha256 === srcSha, sourceDurationUs: doc?.source?.durationUs,
      language: tr?.data?.language, model: tr?.provenance?.model, words: wc, sectionStatuses: otherSections } };
  });

  await probe("F1-04", "No fabricated outputs for unimplemented analyzers", "scenes/faces/objects are not 'completed'; metadata (implemented inspection) matches the real input (8 s, 320x240)", async () => {
    const s = Object.entries(doc.sections).filter(([k]) => !["transcript", "audio", "metadata"].includes(k));
    const meta = doc.sections.metadata;
    const metaText = JSON.stringify(meta?.data ?? {});
    const metaReal = meta?.status === "completed" && /320/.test(metaText) && /240/.test(metaText);
    return { pass: s.every(([, v]: any) => v.status !== "completed") && metaReal,
      actual: { unimplemented: Object.fromEntries(s.map(([k, v]: any) => [k, { status: v.status, code: v.failure?.code ?? v.reason ?? null }])),
        metadata: { status: meta?.status, mentionsInputDimensions: metaReal, provenance: meta?.provenance ? { analyzer: meta.provenance.analyzer, analyzerVersion: meta.provenance.analyzerVersion } : null } } };
  });

  await probe("F1-05", "API document equals durable PostgreSQL document; asset route equals project route", "canonical equality across GET routes and media_analyses.document", async () => {
    const d = await dbDoc(M);
    const byAsset = await call(owner, "GET", `/media/${M}/analysis`);
    return { pass: canon(d.document) === canon(doc) && byAsset.status === 200 && canon(byAsset.json) === canon(doc) && d.source_sha256 === srcSha,
      actual: { dbEqualsApi: canon(d.document) === canon(doc), assetRouteStatus: byAsset.status, assetRouteEqual: canon(byAsset.json) === canon(doc), revision: d.revision } };
  });

  await probe("F1-06", "No storage keys, credentials or internal URLs in the API document", "document JSON does not contain the storage key, S3 secret, signed-URL markers or local paths", async () => {
    const [a] = await q("SELECT storage_key FROM media_assets WHERE id=$1", [M]);
    const text = JSON.stringify(doc);
    const hits = { storageKey: text.includes(a.storage_key), secret: text.includes("editagent-dev-secret"), amz: /x-amz-/i.test(text), url: /https?:\/\//.test(text), tmp: /\/tmp\//.test(text) };
    return { pass: !Object.values(hits).some(Boolean), actual: hits };
  });

  await probe("F1-07", "Redis/BullMQ carried the jobs and holds no stuck/failed analysis work", "BullMQ keys exist; no active or failed entries remain for settled work", async () => {
    const keys = docker("compose", "exec", "-T", "redis", "redis-cli", "--scan", "--pattern", "bull:*").split("\n").filter(Boolean);
    const queues = [...new Set(keys.map((k) => k.split(":")[1]))].sort();
    const counts: Record<string, any> = {};
    for (const qn of queues) {
      const n = (cmd: string, key: string) => Number(docker("compose", "exec", "-T", "redis", "redis-cli", cmd, `bull:${qn}:${key}`).trim() || 0);
      counts[qn] = { active: n("LLEN", "active"), wait: n("LLEN", "wait"), failed: n("ZCARD", "failed"), completed: n("ZCARD", "completed") };
    }
    const analysisQueues = Object.entries(counts).filter(([k]) => /analysis|transcri|audio|speech|ai/i.test(k));
    return { pass: keys.length > 0 && analysisQueues.length > 0 && analysisQueues.every(([, c]: any) => c.active === 0 && c.failed === 0), actual: { keyCount: keys.length, queues: counts } };
  });

  // ---- Authorization matrix ----
  await probe("F1-08", "Unauthenticated access denied", "401 on both GET routes", async () => {
    const a = await call(null, "GET", `/projects/${P}/media/${M}/analysis`), b = await call(null, "GET", `/media/${M}/analysis`);
    return { pass: a.status === 401 && b.status === 401, actual: [a.status, b.status] };
  });
  await probe("F1-09", "Outsider (other account, no membership) denied read and retry", "no 2xx on GET routes or retry; no new task", async () => {
    const before = (await tasks(M)).length;
    const a = await getDoc(outsider, P, M), b = await call(outsider, "GET", `/media/${M}/analysis`);
    const c = await retry(outsider, M, "audio", (await latest(M, "audio")).job_id);
    const after = (await tasks(M)).length;
    return { pass: a.status >= 400 && b.status >= 400 && c.status >= 400 && before === after, actual: { get: a.status, getByAsset: b.status, retry: c.status, newTasks: after - before } };
  });
  await probe("F1-10", "Project isolation: same asset under another project of the owner is not readable", "non-2xx for /projects/<owner's other project>/media/<asset>/analysis", async () => {
    const p2 = await call(owner, "POST", "/projects", { name: "QA isolation project" });
    const p2id = p2.json?.id;
    const r = await getDoc(owner, p2id, M);
    return { pass: p2.status === 201 && r.status >= 400, actual: { createStatus: p2.status, crossProjectRead: r.status } };
  });
  await probe("F1-11", "Viewer may read but not retry; CSRF enforced for owner retries", "viewer GET 200, viewer retry denied, owner retry without CSRF header 403, no new task", async () => {
    await setMembership(P, member.id, "viewer");
    const before = (await tasks(M)).length;
    const g = await getDoc(member, P, M);
    const r = await retry(member, M, "audio", (await latest(M, "audio")).job_id);
    const n = await retry(owner, M, "audio", (await latest(M, "audio")).job_id, false);
    const after = (await tasks(M)).length;
    return { pass: g.status === 200 && r.status >= 400 && n.status === 403 && before === after, actual: { viewerGet: g.status, viewerRetry: r.status, ownerRetryNoCsrf: n.status, newTasks: after - before } };
  });
  await probe("F1-12", "Malformed retry requests rejected", "unknown analyzer, extra body field and non-UUID predecessor all 400", async () => {
    const prev = (await latest(M, "audio")).job_id;
    const a = await call(owner, "POST", `/media/${M}/analysis/scenes/retry`, { previousJobId: prev });
    const b = await call(owner, "POST", `/media/${M}/analysis/audio/retry`, { previousJobId: prev, model: "tiny" });
    const c = await call(owner, "POST", `/media/${M}/analysis/audio/retry`, { previousJobId: "not-a-uuid" });
    return { pass: a.status === 400 && b.status === 400 && c.status === 400, actual: [a.status, b.status, c.status] };
  });

  // ---- Analyzer-specific retry isolation ----
  for (const [id, analyzer, other] of [["F1-13", "audio", "transcript"], ["F1-14", "transcript", "audio"]] as const) {
    await probe(id, `Retry of ${analyzer} updates only its own section`, `${other} section byte-identical; ${analyzer} regenerated (generation+1, completed); revision increases`, async () => {
      const before = await dbDoc(M);
      const prev = await latest(M, analyzer);
      const r = await retry(owner, M, analyzer, prev.job_id);
      if (r.status !== 201 && r.status !== 200) return { pass: false, actual: { retryStatus: r.status } };
      const status = await waitApplied(r.json.jobId);
      const after = await dbDoc(M), now = await latest(M, analyzer);
      return { pass: status === "Completed" && canon(after.document.sections[other]) === canon(before.document.sections[other]) &&
          after.document.sections[analyzer].status === "completed" && now.generation === prev.generation + 1 && after.revision > before.revision,
        actual: { retryStatus: r.status, jobStatus: status, otherSectionIdentical: canon(after.document.sections[other]) === canon(before.document.sections[other]),
          generation: [prev.generation, now.generation], revision: [before.revision, after.revision], sectionStatus: after.document.sections[analyzer].status } };
    });
  }

  await probe("F1-15", "Concurrent retries are deduplicated", "8 simultaneous retries with the same predecessor -> every accepted response names the same stable job (contract: 'returns the stable new Job ID') and exactly one new generation", async () => {
    const prev = await latest(M, "transcript");
    const before = (await tasks(M)).filter((t) => t.analyzer === "transcript").length;
    const rs = await Promise.all(Array.from({ length: 8 }, () => retry(owner, M, "transcript", prev.job_id)));
    const ok = rs.filter((r) => r.status >= 200 && r.status < 300);
    const ids = [...new Set(ok.map((r) => r.json?.jobId))];
    if (ids[0]) await waitApplied(ids[0]);
    const after = (await tasks(M)).filter((t) => t.analyzer === "transcript").length;
    return { pass: ok.length >= 1 && ids.length === 1 && after - before === 1 && rs.every((r) => (r.status >= 200 && r.status < 300) || r.status === 403 || r.status === 409), actual: { statuses: rs.map((r) => r.status).sort(), distinctAcceptedJobs: ids.length, newGenerations: after - before } };
  });
  await probe("F1-16", "Stale predecessor rejected", "retry naming an older generation is refused and creates no task", async () => {
    const t = (await tasks(M)).filter((x) => x.analyzer === "transcript");
    const before = (await tasks(M)).length;
    const r = await retry(owner, M, "transcript", t[0].job_id);
    return { pass: t.length > 1 && r.status >= 400 && (await tasks(M)).length === before, actual: { stalePredecessorGeneration: t[0].generation, latestGeneration: t.at(-1).generation, status: r.status } };
  });

  // ---- Crash, timeout/cancellation and revocation (races retried until observed mid-flight) ----
  async function midFlight(u: User, analyzer: string, onRunning: (jobId: string) => Promise<void>) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await waitApplied((await latest(M, analyzer)).job_id);
      const prev = await latest(M, analyzer);
      const r = await retry(u, M, analyzer, prev.job_id);
      if (r.status < 200 || r.status >= 300) throw new Error(`retry refused ${r.status}`);
      const j = r.json.jobId;
      const s = await waitJob(j, (x) => x === "Running" || terminal(x), 180_000, 50);
      if (s === "Running") { await onRunning(j); return { jobId: j, attempt }; }
      await waitApplied(j);
    }
    return null;
  }
  await probe("F1-17", "AI worker SIGKILL during inference, then restart: job recovers without duplication", "job not completed while worker is dead; after restart it completes; one task row for the generation; other section intact", async () => {
    const before = await dbDoc(M);
    let killedAt = 0;
    const r = await midFlight(owner, "transcript", async () => { docker("kill", "--signal", "KILL", "editagent-ai-worker"); killedAt = Date.now(); });
    if (!r) return { pass: null, actual: "job finished before it could be observed Running in 4 attempts" };
    await sleep(5000);
    const [dead] = await q("SELECT status FROM jobs WHERE id=$1", [r.jobId]);
    const running = docker("inspect", "-f", "{{.State.Running}}", "editagent-ai-worker").trim();
    docker("compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "ai-worker");
    const final = await waitApplied(r.jobId, 600_000);
    const after = await dbDoc(M);
    const rows = (await tasks(M)).filter((t) => t.job_id === r.jobId);
    return { pass: dead.status !== "Completed" && running === "false" && final === "Completed" && rows.length === 1 && after.document.sections.transcript.status === "completed" &&
        canon(after.document.sections.audio) === canon(before.document.sections.audio),
      actual: { statusWhileWorkerDead: dead.status, workerRunningAfterKill: running, finalStatus: final, attempts: rows[0]?.attempts, taskRows: rows.length,
        audioIntact: canon(after.document.sections.audio) === canon(before.document.sections.audio), recoveryMs: Date.now() - killedAt, raceAttempts: r.attempt } };
  });

  await probe("F1-18", "Transcript deadline (operator timeout 4 s) fails closed and is isolated; no late result", "with EDITAGENT_ASR_TIMEOUT_MS=4000 on admission+AI worker, a new upload's transcript ends failed(timeout) with no data while audio completes; nothing changes 30 s later; DB refuses intent mutation", async () => {
    const immutable = await q("UPDATE analysis_tasks SET deadline_at_ms=0 WHERE job_id=$1", [(await latest(M, "audio")).job_id]).then(() => "mutated", (e) => String(e.message).slice(0, 80));
    const shortEnv = { ...process.env, EDITAGENT_ASR_TIMEOUT_MS: "4000" };
    execFileSync("docker", ["compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "media-worker", "ai-worker"], { cwd: APP, env: shortEnv, encoding: "utf8" });
    try {
      await page.goto(`/projects/${P}`);
      await page.locator("#media-file").setInputFiles(path.join(INPUTS, "qa-timeout.mp4"));
      M3 = await until(async () => (await q("SELECT id FROM media_assets WHERE project_id=$1 AND id<>$2 ORDER BY id DESC LIMIT 1", [P, M]))[0]?.id, 180_000, "timeout asset");
      const { t, d } = await settled(M3, 300_000);
      const tTask = t.filter((x: any) => x.analyzer === "transcript").at(-1);
      const [cfg] = await q("SELECT configuration->'asr'->>'timeout_ms' AS timeout FROM analysis_tasks WHERE job_id=$1", [tTask.job_id]);
      const mid = canon(d.document);
      await sleep(30_000);
      const [late] = await q("SELECT t.result IS NOT NULL AS has_result,j.status FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.job_id=$1", [tTask.job_id]);
      const after = await dbDoc(M3);
      const tr = d.document.sections.transcript, au = d.document.sections.audio;
      return { pass: tr.status === "failed" && tr.failure?.code === "timeout" && !tr.data && au.status === "completed" && !late.has_result &&
          canon(after.document) === mid && immutable !== "mutated",
        actual: { frozenTimeoutMs: cfg?.timeout, transcriptJob: tTask.status, attempts: tTask.attempts, section: { status: tr.status, code: tr.failure?.code, reason: tr.failure?.reason, retryable: tr.failure?.retryable, hasData: Boolean(tr.data) },
          audioSection: au.status, lateResultAfter30s: late.has_result, statusAfter30s: late.status, documentUnchangedAfter30s: canon(after.document) === mid, intentMutationAttempt: immutable } };
    } finally {
      execFileSync("docker", ["compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "media-worker", "ai-worker"], { cwd: APP, env: { ...process.env, EDITAGENT_ASR_TIMEOUT_MS: "600000" }, encoding: "utf8" });
    }
  });

  await probe("F1-19", "Membership revocation during an editor-initiated run: no result published, other section intact, access removed", "revoked editor's job does not publish a completed transcript; audio intact; revoked user GET denied; owner retry restores", async () => {
    await setMembership(P, member.id, "editor");
    const before = await dbDoc(M);
    const r = await midFlight(member, "transcript", async () => {
      await setMembership(P, member.id, null);
    });
    if (!r) return { pass: null, actual: "job finished before it could be observed Running in 4 attempts" };
    const status = await waitJob(r.jobId, terminal, 300_000, 500);
    await waitApplied(r.jobId, 180_000).catch(() => null);
    await sleep(5000);
    const mid = await dbDoc(M);
    const [task] = await q("SELECT result IS NOT NULL AS has_result FROM analysis_tasks WHERE job_id=$1", [r.jobId]);
    const g = await getDoc(member, P, M);
    const tr = mid.document.sections.transcript;
    const restore = await retry(owner, M, "transcript", r.jobId);
    const restored = restore.json?.jobId ? await waitApplied(restore.json.jobId) : null;
    return { pass: status !== "Completed" && tr.status === "failed" && !tr.data && canon(mid.document.sections.audio) === canon(before.document.sections.audio) && g.status >= 400 && restored === "Completed",
      actual: { revokedJobStatus: status, resultStored: task?.has_result, section: { status: tr.status, code: tr.failure?.code, reason: tr.failure?.reason },
        audioIntact: canon(mid.document.sections.audio) === canon(before.document.sections.audio), revokedUserGet: g.status, ownerRestore: restored } };
  });

  await probe("F1-20", "Durable state survives API and media-worker restart", "document identical before/after restarting api and media-worker containers", async () => {
    const before = (await getDoc(owner, P, M)).json;
    docker("compose", "restart", "api", "media-worker");
    docker("compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "api", "media-worker");
    const after = await until(async () => { const r = await getDoc(owner, P, M); return r.status === 200 ? r.json : null; }, 120_000, "api back");
    return { pass: canon(before) === canon(after), actual: { identical: canon(before) === canon(after) } };
  });

  await probe("F1-21", "Generation fencing invariant", "after all work settles, the transcript section equals the newest generation's result; no Failed/Cancelled task holds a result", async () => {
    await settled(M);
    const t = await tasks(M), d = await dbDoc(M);
    const [tr] = await q("SELECT result FROM analysis_tasks WHERE media_asset_id=$1 AND analyzer='transcript' ORDER BY generation DESC LIMIT 1", [M]);
    const badResults = t.filter((x) => x.status !== "Completed" && x.has_result).length;
    return { pass: canon(tr.result) === canon(d.document.sections.transcript) && badResults === 0,
      actual: { transcriptEqualsNewestGeneration: canon(tr.result) === canon(d.document.sections.transcript), nonCompletedTasksWithResults: badResults,
        generations: t.map((x) => `${x.analyzer}:${x.generation}:${x.status}${x.failure_code ? ":" + x.failure_code : ""}`) } };
  });

  await probe("F1-22", "Upload completion is idempotent", "replaying the browser's completion request returns the same asset; no new asset or analysis task", async () => {
    if (!completes.length) return { pass: null, actual: "browser completion request not observable (server-side); not replayed" };
    const assets = (await q("SELECT count(*)::int AS n FROM media_assets WHERE project_id=$1", [P]))[0].n;
    const nTasks = (await tasks(M)).length;
    const c = completes[0];
    const token = (await owner.ctx.cookies(API)).find((x) => x.name === "editagent_csrf")?.value;
    const res = await owner.ctx.request.fetch(c.url, { method: "POST", data: c.body, headers: { "content-type": "application/json", origin: WEB, ...(token ? { "x-editagent-csrf": token } : {}) }, failOnStatusCode: false });
    let body: any = null; try { body = await res.json(); } catch { /* */ }
    await sleep(10_000);
    const assets2 = (await q("SELECT count(*)::int AS n FROM media_assets WHERE project_id=$1", [P]))[0].n;
    const sameId = JSON.stringify(body ?? "").includes(M);
    const shape = body && typeof body === "object" ? { keys: Object.keys(body).sort(), ok: body.ok ?? null, status: body.status ?? null, dataKeys: body.data && typeof body.data === "object" ? Object.keys(body.data).sort() : null } : null;
    return { pass: res.status() < 300 && sameId && assets2 === assets && (await tasks(M)).length === nTasks, actual: { status: res.status(), returnsSameAsset: sameId, responseShape: shape, newAssets: assets2 - assets, newTasks: (await tasks(M)).length - nTasks } };
  });

  await probe("F1-23", "Video without an audio track: analysis is honest (no fabricated transcript)", "no 'completed' transcript/audio with data; explicit failed/not_available status or no document", async () => {
    await page.goto(`/projects/${P}`);
    await page.locator("#media-file").setInputFiles(noAudio);
    const m2 = await until(async () => (await q("SELECT id FROM media_assets WHERE project_id=$1 AND id<>ALL($2::uuid[])", [P, [M, M3].filter(Boolean)]))[0]?.id, 180_000, "no-audio asset");
    await sleep(60_000);
    const r = await getDoc(owner, P, m2);
    const [insp] = await q("SELECT status FROM jobs WHERE subject_id=$1 AND job_type LIKE '%inspect%' ORDER BY created_at DESC LIMIT 1", [m2]).catch(() => [{}] as any);
    const t = await tasks(m2);
    const s = r.json?.sections;
    const fabricated = s ? ["transcript", "audio"].some((k) => s[k]?.status === "completed") : false;
    return { pass: !fabricated && (r.status === 404 || (s && ["transcript", "audio"].every((k) => ["failed", "not_available"].includes(s[k].status)))),
      actual: { getStatus: r.status, inspection: insp?.status ?? null, sections: s ? Object.fromEntries(["transcript", "audio"].map((k) => [k, { status: s[k].status, code: s[k].failure?.code ?? null }])) : null,
        tasks: t.map((x) => `${x.analyzer}:${x.status}${x.failure_code ? ":" + x.failure_code : ""}`) } };
  });

  // ---------- QA-F2: browser-to-export ----------
  let exportPath = "";
  await probe("F2-01", "Saved editing persists (trim 0.5-7.0 s, split at 3.0 s)", "two clips (0.5-3 s, 3-7 s) shown, identical after reload, state hash equals editing_timelines.state_sha256", async () => {
    await page.goto(`/projects/${P}`);
    await page.locator(`a[href*="media=${M}"]`).first().click();
    await page.getByRole("button", { name: "Create timeline from video" }).click();
    const timeline = page.getByRole("region", { name: "Timeline" });
    await expect(timeline).toBeVisible();
    const original = await timeline.getAttribute("data-timeline-sha256");
    await page.getByLabel("Trim start (timeline seconds)").fill("0.5");
    await page.getByLabel("Trim end (timeline seconds)").fill("7");
    await page.getByRole("button", { name: "Apply trim", exact: true }).click();
    await expect.poll(async () => (await timeline.getAttribute("data-timeline-sha256")) !== original).toBe(true);
    await page.getByLabel("Split at (timeline seconds)").fill("3");
    await page.getByRole("button", { name: "Split clip", exact: true }).click();
    await expect(timeline.locator("[data-clip-id]")).toHaveCount(2);
    const tid = (await timeline.getAttribute("data-timeline-id"))!;
    const edited = await timeline.getAttribute("data-timeline-sha256");
    await page.reload();
    await expect(timeline.locator("[data-clip-id]")).toHaveCount(2);
    const reloaded = await timeline.getAttribute("data-timeline-sha256");
    const clipText = (await timeline.locator("[data-clip-id]").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());
    const [row] = await q("SELECT state_sha256,project_id FROM editing_timelines WHERE id=$1", [tid]);
    await page.screenshot({ path: path.join(OUT, "03-timeline.png"), fullPage: true, mask: hideAccount(page) });
    return { pass: edited === reloaded && row?.state_sha256 === edited && row?.project_id === P && clipText.length === 2 && /Source 0\.5\d*\D+3 s/.test(clipText[0]) && /Source 3\D+7 s/.test(clipText[1]),
      actual: { clips: clipText, persistedAfterReload: edited === reloaded, dbStateMatches: row?.state_sha256 === edited, timelineChangedFromOriginal: original !== edited } };
  });

  await probe("F2-02", "Real render, playback and download", "export job Completed in DB; video plays (currentTime advances); MP4 downloads", async () => {
    await page.getByRole("button", { name: "Render saved timeline" }).click();
    const job = page.getByRole("region", { name: "Export job" });
    await expect(job.getByRole("status")).toHaveText("Completed", { timeout: 300_000 });
    const jobId = (await job.getAttribute("data-export-job-id"))!;
    const [jr] = await q("SELECT status,job_type,queue_name FROM jobs WHERE id=$1", [jobId]);
    await page.getByRole("button", { name: "Open export", exact: true }).click();
    const video = page.getByLabel("Rendered export");
    await expect(video).toBeVisible();
    await video.evaluate(async (n) => { const v = n as HTMLVideoElement; v.muted = true; await v.play(); });
    await expect.poll(async () => video.evaluate((n) => (n as HTMLVideoElement).currentTime > 1.0), { timeout: 30_000 }).toBe(true);
    const media = await video.evaluate((n) => { const v = n as HTMLVideoElement; return { duration: v.duration, w: v.videoWidth, h: v.videoHeight, error: v.error?.code ?? null }; });
    await video.evaluate((n) => (n as HTMLVideoElement).pause());
    await page.screenshot({ path: path.join(OUT, "04-export-playback.png"), fullPage: true, mask: hideAccount(page) });
    const ev = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download MP4", exact: true }).click();
    const dl = await ev;
    exportPath = path.join(PRIVATE, "export.mp4");
    await dl.saveAs(exportPath);
    return { pass: jr?.status === "Completed" && media.error === null && (await dl.failure()) === null,
      actual: { dbJob: jr, browserMedia: media, downloadedSha256: sha(readFileSync(exportPath)) } };
  });

  await probe("F2-03", "Export integrity and source-to-output edit correspondence", "verify_media.py: 8 s, 200 frames; frames 0.5-7.0 s equal same-time source frames (zero offset); outside black; audio correlates in kept ranges and is silent elsewhere", async () => {
    if (!exportPath) return { pass: null, actual: "no export" };
    const out = path.join(OUT, "export-verification.json");
    try {
      execFileSync(PY, [path.join(APP, "apps/web/.qa-pr60/verify_media.py"), "--source", src, "--export", exportPath, "--keep", "0.5:7.0", "--duration", "8", "--out", out], { encoding: "utf8" });
    } catch { /* report holds the failing checks */ }
    const rep = JSON.parse(readFileSync(out, "utf8"));
    return { pass: rep.pass === true, actual: { checks: rep.checks, video: rep.video, audio: rep.audio, probe: rep.exportProbe, sourceSha256: rep.sourceSha256, exportSha256: rep.exportSha256 } };
  });

  await probe("F2-04", "Real backend only (mock data disabled)", "browser traffic reached the real web/API routes and every step has durable rows", async () => {
    const [counts] = await q(`SELECT (SELECT count(*) FROM media_assets WHERE project_id=$1)::int AS assets,
      (SELECT count(*) FROM editing_timelines WHERE project_id=$1)::int AS timelines,
      (SELECT count(*) FROM jobs WHERE status='Completed')::int AS completed_jobs`, [P]);
    const routes = [...new Set(apiRequests)].sort();
    return { pass: counts.assets >= 1 && counts.timelines >= 1 && counts.completed_jobs > 0 && routes.length > 0, actual: { durable: counts, observedApiRoutes: routes } };
  });

  await probe("F2-05", "Export cancellation", "a second render cancelled through the API ends Cancelled with no download offered", async () => {
    await page.getByRole("button", { name: "Render saved timeline" }).click();
    const job = page.getByRole("region", { name: "Export job" });
    const jobId = await until(async () => { const id = await job.getAttribute("data-export-job-id"); const [r] = id ? await q("SELECT status FROM jobs WHERE id=$1", [id]) : []; return r && r.status !== "Completed" ? id : null; }, 60_000, "new export job", 100).catch(() => null);
    if (!jobId) return { pass: null, actual: "second render completed before it could be cancelled" };
    const c = await call(owner, "POST", `/projects/${P}/exports/${jobId}/cancel`);
    const status = await waitJob(jobId, terminal, 120_000, 500);
    const dl = await call(owner, "GET", `/projects/${P}/exports/${jobId}/download`);
    return { pass: c.status < 300 && status === "Cancelled" && dl.status >= 400, actual: { cancelStatus: c.status, jobStatus: status, downloadStatus: dl.status } };
  });

  // Analysis screenshot (transcript masked).
  await page.goto(`/projects/${P}`);
  await page.getByRole("region", { name: "Media Library" }).getByRole("button", { name: "View analysis" }).first().click().catch(() => undefined);
  await sleep(2000);
  await page.screenshot({ path: path.join(OUT, "02-analysis-status.png"), fullPage: true, mask: [...hideAccount(page), page.locator('p[dir="auto"]')] });

  await pool.end();
  s3.destroy();
  const failed = results.filter((r) => r.status !== "PASS");
  console.log(JSON.stringify(results.map((r) => `${r.id}:${r.status}`)));
  expect(failed.map((r) => `${r.id} ${r.status}`)).toEqual([]);
});
