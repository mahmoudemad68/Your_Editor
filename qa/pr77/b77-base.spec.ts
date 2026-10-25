/** PR #77 independent QA: BASELINE on unmodified main 00074f2 (before PR #77) for findings L1/L3/L4.
 * Shows whether each behaviour pre-exists the PR. Runs on the base stack inside the upgrade job. QA-authored. */
import { test } from "@playwright/test";
import { API, call, cookieHeader, docker, leakScan, newUser, pool, probe, until } from "./helpers77";

test("PR77 baseline on main: L1/L3/L4", async ({ browser }) => {
  const u = await newUser(browser, "baseline");
  const ck = await cookieHeader(u);
  const csrf = (await u.ctx.cookies(API)).find((c) => c.name === "editagent_csrf")?.value ?? "";
  const raw = async (method: string, url: string, body?: string, ms = 20_000) => {
    const t = Date.now();
    try {
      const r = await fetch(API + url, { method, headers: { cookie: ck, origin: "http://localhost:3000", "content-type": "application/json", "x-editagent-csrf": csrf }, body, signal: AbortSignal.timeout(ms) });
      return { status: r.status, ms: Date.now() - t, text: (await r.text()).slice(0, 160) };
    } catch (e) { return { status: -1, ms: Date.now() - t, text: String((e as Error).name) }; }
  };

  await probe("B1", "Baseline L1 (main, before PR #77): after sign-out the still-unexpired access cookie keeps authorizing reads", "observed on main: GET /projects with the pre-logout access cookie after POST /auth/logout", async () => {
    const before = await raw("GET", "/projects");
    const logout = await raw("POST", "/auth/logout");
    const after = await raw("GET", "/projects");
    return { pass: null, observed: true, actual: { before: before.status, logout: logout.status, afterLogoutWithOldAccessCookie: after.status } };
  });

  await probe("B2", "Baseline L3 (main): oversized JSON body on an existing route", "observed on main: POST /projects with a 1 MiB name", async () => {
    const u2 = await newUser(browser, "baseline2");
    const r = await call(u2, "POST", "/projects", { name: "x".repeat(1_048_576) });
    return { pass: null, observed: true, actual: { status: r.status, body: r.text.slice(0, 120), leaks: leakScan(r.text) } };
  });

  await probe("B3", "Baseline L4 (main): request behaviour while PostgreSQL is paused", "observed on main: GET /projects during a PG pause (20 s client bound); readiness during and recovery after", async () => {
    const u3 = await newUser(browser, "baseline3");
    const ck3 = await cookieHeader(u3);
    docker("pause", "editagent-postgres");
    let during: { status: number; ms: number; text: string }, ready = true;
    try {
      const t = Date.now();
      during = await fetch(API + "/projects", { headers: { cookie: ck3 }, signal: AbortSignal.timeout(20_000) }).then(async (r) => ({ status: r.status, ms: Date.now() - t, text: (await r.text()).slice(0, 80) }), (e) => ({ status: -1, ms: Date.now() - t, text: String(e.name) }));
      ready = await fetch(API + "/ready", { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
    } finally { docker("unpause", "editagent-postgres"); }
    await until(async () => fetch(API + "/ready", { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false), 120_000, "ready", 2000);
    return { pass: null, observed: true, actual: { duringOutage: during!, readyDuringOutage: ready, recovered: true } };
  });
  await pool.end();
});
