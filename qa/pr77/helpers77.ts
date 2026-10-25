/** QA-authored helpers for PR #77 independent black-box probes (real Compose stack). No secrets or private media recorded. */
import { expect, request as pwRequest, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const APP = process.env.QA_APP_ROOT!, OUT = process.env.QA_OUT!, INPUTS = process.env.QA_INPUTS!, PRIVATE = process.env.QA_PRIVATE!;
export const API = "http://localhost:3001", WEB = "http://localhost:3000";
export const appRequire = createRequire(path.join(APP, "apps/api/package.json"));
const { Pool } = appRequire("pg");
export const PG = "postgresql://editagent:editagent-dev-password@localhost:5432/editagent";
export const pool = new Pool({ connectionString: PG, max: 6 });
mkdirSync(OUT, { recursive: true }); mkdirSync(PRIVATE, { recursive: true });

type Status = "PASS" | "FAIL" | "ERROR" | "NOT_RUN";
const RESULTS = path.join(OUT, "qa77-results.json");
export const results: { id: string; title: string; status: Status; expected: string; actual: unknown; ms: number; mode: string }[] =
  existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")).results : [];
const save = () => writeFileSync(RESULTS, JSON.stringify({ appSha: process.env.QA_APP_SHA, generatedAt: new Date().toISOString(), results }, null, 2));
/** mode: "real-service" (HTTP to production containers) or "real-pg-driver" (QA driver over real PG/ToolExecutor). */
export async function probe(id: string, title: string, expected: string, fn: () => Promise<{ pass: boolean | null; actual: unknown }>, mode = "real-service") {
  const start = Date.now();
  try {
    const r = await fn();
    results.push({ id, title, status: r.pass === null ? "NOT_RUN" : r.pass ? "PASS" : "FAIL", expected, actual: r.actual, ms: Date.now() - start, mode });
  } catch (e) {
    results.push({ id, title, status: "ERROR", expected, actual: String((e as Error)?.stack ?? e).slice(0, 900), ms: Date.now() - start, mode });
  }
  save();
  console.log(`[QA77] ${id} ${results.at(-1)!.status} ${title}`);
}
export const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as any[];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const uuid7 = () => randomUUID().replace(/^(.{14})./, "$17");
export const docker = (...args: string[]) => execFileSync("docker", args, { cwd: APP, encoding: "utf8", env: process.env, timeout: 900_000 });
export async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string, every = 250): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v as T; await sleep(every); }
  throw new Error(`timeout waiting for ${label}`);
}
export const terminal = (s: string) => ["Completed", "Failed", "Cancelled"].includes(s);

export type User = { ctx: BrowserContext; page: Page; email: string; password: string; id: string };
export async function newUser(browser: Browser, label: string): Promise<User> {
  const ctx = await browser.newContext({ baseURL: WEB, acceptDownloads: true });
  const page = await ctx.newPage();
  const email = `qa77-${label}-${randomUUID()}@example.test`, password = `Qa-only-${randomUUID()}!`;
  await page.goto("/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const [row] = await q("SELECT id FROM users WHERE lower(email)=lower($1)", [email]);
  return { ctx, page, email, password, id: row.id };
}
export async function cookieHeader(u: User) {
  return (await u.ctx.cookies(API)).map((c) => `${c.name}=${c.value}`).join("; ");
}
export async function refresh(u: User) {
  const token = (await u.ctx.cookies(API)).find((c) => c.name === "editagent_csrf")?.value;
  await u.ctx.request.fetch(API + "/auth/refresh", { method: "POST", headers: { origin: WEB, ...(token ? { "x-editagent-csrf": token } : {}) }, failOnStatusCode: false });
}
export async function call(u: User | null, method: "GET" | "POST" | "DELETE", url: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
  const csrf = opts.csrf ?? true;
  const ctx = u ? u.ctx.request : await pwRequest.newContext();
  const send = async () => {
    const headers: Record<string, string> = { origin: WEB, ...(opts.headers ?? {}) };
    if (u && method !== "GET" && csrf) {
      const token = (await u.ctx.cookies(API)).find((c) => c.name === "editagent_csrf")?.value;
      if (token) headers["x-editagent-csrf"] = token;
    }
    return ctx.fetch(API + url, { method, headers, data: body, failOnStatusCode: false, timeout: 60_000 });
  };
  let res = await send();
  if (u && res.status() === 401) { await refresh(u); res = await send(); }
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
  const out = { status: res.status(), json, text, headers: res.headers() };
  if (!u) await ctx.dispose();
  return out;
}
/** Administrative membership changes respect the Project aggregate chronology invariant. */
export async function setMembership(project: string, user: string, role: "viewer" | "editor" | "owner" | null) {
  const now = Date.now();
  if (role === null) await q("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [project, user]);
  else await q(`INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (project_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [project, user, role, now]);
  await q("UPDATE projects SET updated_at=GREATEST(updated_at,$2), revision=revision+1 WHERE id=$1", [project, now]);
}
/** Creates through the product API and returns THAT project's id (never "the first project link"). */
export async function newProject(u: User, name: string): Promise<string> {
  const r = await call(u, "POST", "/projects", { name });
  if (r.status !== 201 || typeof r.json?.id !== "string") throw new Error(`project create failed ${r.status}`);
  return r.json.id as string;
}
/** Product canonical-JSON SHA-256 (tool-sdk contentHash) of a JSON value. */
export const contentSha = (v: unknown) => sha(JSON.stringify(v));
export async function upload(page: Page, project: string, file: string, known: string[]) {
  await page.goto(`/projects/${project}`);
  await page.locator("#media-file").setInputFiles(file);
  return until(async () => (await q("SELECT id FROM media_assets WHERE project_id=$1 AND id<>ALL($2::uuid[]) ORDER BY id DESC LIMIT 1", [project, known]))[0]?.id as string, 180_000, "new asset");
}
/** A real Timeline created through the product API from an inspected asset. */
export async function newTimeline(u: User, project: string, media: string) {
  const r = await until(async () => {
    const res = await call(u, "POST", `/projects/${project}/timelines`, { mediaAssetId: media });
    return res.status < 300 ? res : null;
  }, 240_000, "timeline create", 2000);
  return { id: r.json.timeline.id as string, sha: r.json.stateSha256 as string, snapshot: r.json.timeline };
}
export type SseResult = { status: number; headers: Record<string, unknown>; events: { id: string; data: any }[]; comments: number; closed: "end" | "reset" | "timeout" | "error"; ms: number; body: string };
/** Raw SSE client (no auto-reconnect) so server-side termination is observable. */
export function sse(cookie: string, pathAndQuery: string, opts: { lastEventId?: string | string[]; timeoutMs?: number; onEvent?: (e: { id: string; data: any }) => void; stopAfter?: number } = {}): Promise<SseResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const headers: Record<string, string | string[]> = { cookie, accept: "text/event-stream", origin: WEB };
    if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
    const out: SseResult = { status: 0, headers: {}, events: [], comments: 0, closed: "timeout", ms: 0, body: "" };
    let buf = "", done = false;
    const finish = (how: SseResult["closed"]) => { if (done) return; done = true; out.closed = how; out.ms = Date.now() - start; clearTimeout(timer); req.destroy(); resolve(out); };
    const req = http.request(API + pathAndQuery, { method: "GET", headers }, (res) => {
      out.status = res.statusCode ?? 0; out.headers = res.headers;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (out.status !== 200) { out.body += chunk; return; }
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(":")) { out.comments++; continue; }
          const id = /^id: (.*)$/m.exec(block)?.[1] ?? "", data = /^data: (.*)$/m.exec(block)?.[1];
          if (data !== undefined) { const e = { id, data: JSON.parse(data) }; out.events.push(e); opts.onEvent?.(e); if (opts.stopAfter && out.events.length >= opts.stopAfter) finish("timeout"); }
        }
      });
      res.on("end", () => finish("end"));
      res.on("error", () => finish("reset"));
      res.on("aborted", () => finish("reset"));
    });
    req.on("error", () => finish("reset"));
    const timer = setTimeout(() => finish("timeout"), opts.timeoutMs ?? 20_000);
    req.end();
  });
}
/** Response must expose only allowlisted shapes/strings (no stack, path, SQL, key or identity). */
export function leakScan(text: string, extra: string[] = []) {
  const bad = [/Traceback/i, /at [\w.<>]+ \(/, /\/app\//, /\/tmp\//, /psycopg|SQLSTATE|23514|constraint|relation "/i, /editagent-dev-secret/, /x-amz-/i, /projects\/[0-9a-f-]{36}\/(media|derived)/i, /@example\.test/, /storage_?key/i, /transcript/i, /prompt/i];
  return [...bad.filter((r) => r.test(text)).map(String), ...extra.filter((s) => s && text.includes(s)).map((s) => `private:${s.slice(0, 6)}`)];
}
