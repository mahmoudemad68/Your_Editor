/** QA-authored helpers for PR #68 black-box probes (real Compose stack). No transcript text or secrets are recorded. */
import { expect, request as pwRequest, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const APP = process.env.QA_APP_ROOT!, OUT = process.env.QA_OUT!, INPUTS = process.env.QA_INPUTS!, PRIVATE = process.env.QA_PRIVATE!;
export const API = "http://localhost:3001", WEB = "http://localhost:3000";
const rootRequire = createRequire(path.join(APP, "package.json"));
const { Pool, Client } = rootRequire("pg");
const { S3Client, GetObjectCommand, PutObjectCommand } = rootRequire("@aws-sdk/client-s3");
export const PG = "postgresql://editagent:editagent-dev-password@localhost:5432/editagent";
export const pool = new Pool({ connectionString: PG, max: 4 });
export const s3 = new S3Client({ endpoint: "http://localhost:9000", region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: "editagent", secretAccessKey: "editagent-dev-secret" } });
export { GetObjectCommand, PutObjectCommand };
mkdirSync(OUT, { recursive: true }); mkdirSync(PRIVATE, { recursive: true });

type Status = "PASS" | "FAIL" | "ERROR" | "NOT_RUN";
const RESULTS = path.join(OUT, "qa68-results.json");
export const results: { id: string; title: string; status: Status; expected: string; actual: unknown; ms: number }[] =
  existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")).results : [];
const save = () => writeFileSync(RESULTS, JSON.stringify({ appSha: process.env.QA_APP_SHA, generatedAt: new Date().toISOString(), results }, null, 2));
export async function probe(id: string, title: string, expected: string, fn: () => Promise<{ pass: boolean | null; actual: unknown }>) {
  const start = Date.now();
  try {
    const r = await fn();
    results.push({ id, title, status: r.pass === null ? "NOT_RUN" : r.pass ? "PASS" : "FAIL", expected, actual: r.actual, ms: Date.now() - start });
  } catch (e) {
    results.push({ id, title, status: "ERROR", expected, actual: String(e).slice(0, 700), ms: Date.now() - start });
  }
  save();
  console.log(`[QA68] ${id} ${results.at(-1)!.status} ${title}`);
}
export const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as any[];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export const docker = (...args: string[]) => execFileSync("docker", args, { cwd: APP, encoding: "utf8", env: process.env, timeout: 1_800_000 });
export const composeWith = (env: Record<string, string>, ...args: string[]) =>
  execFileSync("docker", ["compose", ...args], { cwd: APP, encoding: "utf8", env: { ...process.env, ...env }, timeout: 1_800_000 });
export async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string, every = 500): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v as T; await sleep(every); }
  throw new Error(`timeout waiting for ${label}`);
}
export const terminal = (s: string) => ["Completed", "Failed", "Cancelled"].includes(s);

export type User = { ctx: BrowserContext; page: Page; email: string; password: string; id: string };
export async function newUser(browser: Browser, label: string): Promise<User> {
  const ctx = await browser.newContext({ baseURL: WEB, acceptDownloads: true });
  const page = await ctx.newPage();
  const email = `qa68-${label}-${randomUUID()}@example.test`, password = `Qa-only-${randomUUID()}!`;
  await page.goto("/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const [row] = await q("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);
  return { ctx, page, email, password, id: row.id };
}
export async function call(u: User | null, method: "GET" | "POST" | "DELETE", url: string, body?: unknown, csrf = true) {
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
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  const out = { status: res.status(), json, text, headers: res.headers() };
  if (!u) await ctx.dispose();
  return out;
}
// Administrative membership changes respect the Project aggregate chronology invariant (as the product's commands do).
export async function setMembership(project: string, user: string, role: "viewer" | "editor" | null) {
  const now = Date.now();
  if (role === null) await q("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [project, user]);
  else await q(`INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (project_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [project, user, role, now]);
  await q("UPDATE projects SET updated_at=GREATEST(updated_at,$2), revision=revision+1 WHERE id=$1", [project, now]);
}
export const tasks = (m: string) => q(
  `SELECT t.job_id,t.analyzer,t.generation::int AS generation,t.applied,j.status,j.failure_reason,(t.result IS NOT NULL) AS has_result,
          t.failure_category,t.failure, (SELECT count(*)::int FROM job_attempts a WHERE a.job_id=t.job_id) AS attempts
     FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.media_asset_id=$1 ORDER BY t.analyzer,t.generation`, [m]);
export const latest = async (m: string, analyzer: string) => (await tasks(m)).filter((t) => t.analyzer === analyzer).at(-1);
export const dbDoc = async (m: string) => (await q("SELECT document,revision::int AS revision FROM media_analyses WHERE media_asset_id=$1", [m]))[0];
export async function settled(m: string, ms = 420_000) {
  return until(async () => {
    const t = await tasks(m), d = await dbDoc(m);
    return t.length > 0 && t.every((x) => terminal(x.status) && x.applied) && d &&
      ["completed", "failed"].includes(d.document.sections.transcript.status) && ["completed", "failed"].includes(d.document.sections.audio.status) ? { t, d } : null;
  }, ms, `analysis settled ${m}`);
}
export async function waitApplied(jobId: string, ms = 420_000) {
  return until(async () => {
    const [r] = await q("SELECT t.applied,j.status FROM analysis_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.job_id=$1", [jobId]);
    return r && r.applied && terminal(r.status) ? r.status : null;
  }, ms, `applied ${jobId}`);
}
export async function waitStatus(jobId: string, pred: (s: string) => boolean, ms: number, every = 100) {
  return until(async () => { const [r] = await q("SELECT status FROM jobs WHERE id=$1", [jobId]); return r && pred(r.status) ? r.status : null; }, ms, `job ${jobId}`, every);
}
export const retry = (u: User, m: string, analyzer: string, previousJobId: string) =>
  call(u, "POST", `/media/${m}/analysis/${analyzer}/retry`, { previousJobId });
export const failures = (u: User | null, p: string, m: string) => call(u, "GET", `/projects/${p}/media/${m}/analysis/failures`);

/**
 * Hold a row lock on the task so the worker's RESULT write blocks after inference finished
 * ("output generated, not yet published"). Other blocked statements (e.g. attempt bookkeeping) are released.
 */
export async function holdResultWrite(jobId: string, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query("BEGIN");
    await c.query("SELECT 1 FROM analysis_tasks WHERE job_id=$1 FOR UPDATE", [jobId]);
    for (let i = 0; i < 600 && Date.now() < end; i++) {
      const waiting = await q(`SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%analysis_tasks%'`);
      if (waiting.some((w) => /SET\s+result\s*=/i.test(w.query)))
        return { blockedStatement: "UPDATE analysis_tasks SET result=…", release: async () => { await c.query("ROLLBACK"); await c.end(); } };
      if (waiting.length) break; // a non-result statement is blocked: release and retake
      const [s] = await q("SELECT status FROM jobs WHERE id=$1", [jobId]);
      if (s && terminal(s.status)) { await c.query("ROLLBACK"); await c.end(); return null; }
      await sleep(100);
    }
    await c.query("ROLLBACK"); await c.end();
    await sleep(150);
  }
  return null;
}
export async function upload(page: Page, project: string, file: string, known: string[]) {
  await page.goto(`/projects/${project}`);
  await page.locator("#media-file").setInputFiles(file);
  return until(async () => (await q("SELECT id FROM media_assets WHERE project_id=$1 AND id<>ALL($2::uuid[]) ORDER BY id DESC LIMIT 1", [project, known]))[0]?.id as string, 180_000, "new asset");
}
export const ALLOW = {
  authorization_failed: "Analysis could not be published because authorization failed. Contact support.",
  authorization_revoked: "Analysis authorization is no longer valid. An editor can start a new analysis.",
  publication_fenced: "This analysis result is no longer current. Refresh the analysis.",
  untrustworthy_alignment: "Trustworthy word timing could not be established with the selected model. Choose a qualified model explicitly.",
  analyzer_unavailable: "The analyzer is unavailable. Try again later.",
  cancelled: "Analysis was cancelled.",
  timeout: "Analysis reached its time limit. Retry only on a qualified runtime.",
  invalid_input: "The analysis input is invalid. Check the media and try again.",
  internal: "Analysis failed unexpectedly. Try again or contact support.",
} as Record<string, string>;
/** Response must expose only allowlisted shapes/strings (no stack, path, SQL, key or identity). */
export function leakScan(text: string, extra: string[] = []) {
  const bad = [/Traceback/i, /at [\w.<>]+ \(/, /\/tmp\//, /\/app\//, /psycopg|SQLSTATE|EA001|23514|constraint/i, /editagent-dev-secret/, /x-amz-/i, /projects\/[0-9a-f-]{36}\/(media|derived)/i, /@example\.test/];
  return [...bad.filter((r) => r.test(text)).map(String), ...extra.filter((s) => s && text.includes(s)).map(() => "privateValue")];
}
