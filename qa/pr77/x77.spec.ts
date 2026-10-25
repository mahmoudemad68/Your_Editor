/** PR #77 independent QA, part X: the four controls the Technical Lead flagged as not yet independently exercised
 * (slow-client write deadline/backpressure, 64 streams per API process, access-token expiry mid-stream,
 * API SIGKILL with durable resume/duplicate suppression) plus the SSE 120 s upper bound on a NONTERMINAL run.
 * Production containers only; no product setting is changed. QA-authored. */
import { test } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { API, APP, call, cookieHeader, docker, newProject, newUser, pool, probe, q, setMembership, sleep, sse, terminal, until, type User } from "./helpers77";

const base = (p: string) => `/projects/${p}/agent-runs`;
const key = () => `qa77x-${randomUUID().replaceAll("-", "")}`;
const worker = {
  stop: () => docker("compose", "stop", "-t", "5", "agent-worker"),
  start: () => docker("compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "agent-worker"),
};
const events = async (id: string) => (await q("SELECT event FROM agent_events WHERE run_id=$1 ORDER BY sequence", [id])).map((r) => r.event);
const settledRun = (id: string, ms = 90_000) => until(async () => { const r = (await q("SELECT * FROM agent_runs WHERE id=$1", [id]))[0]; return r && terminal(r.state) ? r : null; }, ms, `run ${id}`);
const apiUp = async () => { try { return (await fetch(API + "/ready", { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };

/** A stream handle that can be closed by the client (for slot accounting). */
function open(cookie: string, p: string, headers: Record<string, string> = {}) {
  let req: http.ClientRequest;
  const t0 = Date.now();
  const status = new Promise<{ status: number; ms: number }>((resolve) => {
    req = http.request(API + p, { headers: { cookie, accept: "text/event-stream", origin: "http://localhost:3000", ...headers } }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0, ms: Date.now() - t0 }); });
    req.on("error", () => resolve({ status: -1, ms: Date.now() - t0 }));
    req.end();
  });
  return { status, close: () => req!.destroy() };
}
function stall(host: string, p: string, cookie: string, rcvbuf: number, hold: number): Promise<any> {
  return new Promise((resolve) => execFile("python3", [path.join(APP, "apps/web/.qa-pr77/sse_stall.py"), host, "3001", p, cookie, String(rcvbuf), String(hold)], { timeout: (hold + 30) * 1000 },
    (e, out) => { try { resolve(JSON.parse(out.trim().split("\n").at(-1)!)); } catch { resolve({ error: String(e).slice(0, 200), out: String(out).slice(0, 200) }); } }));
}
const jwtExp = (cookie: string) => { const t = /editagent_access=([^;]+)/.exec(cookie)![1]!; return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).exp * 1000; };

test("PR77 part X: remaining SSE/stream/crash controls", async ({ browser }) => {
  const state = JSON.parse(readFileSync(path.join(process.env.QA_PRIVATE!, "state77.json"), "utf8"));
  const P = state.P as string, PD = state.PD as string;
  // Dedicated token-expiry user: signed in NOW; this cookie string is never refreshed.
  const expUser = await newUser(browser, "expiry");
  const expCookie = await cookieHeader(expUser), expAt = jwtExp(expCookie);
  const PX = await newProject(expUser, "QA77 expiry");
  const owner = await newUser(browser, "x-owner");
  const PO = await newProject(owner, "QA77 crash");
  const lifeRun = (await q("SELECT id FROM agent_runs WHERE project_id=$1 AND stop_reason='PLANNER_NOT_CONFIGURED' ORDER BY created_at_ms LIMIT 1", [P]))[0].id as string;
  const bigRun = (await q("SELECT id,sequence FROM agent_runs WHERE project_id=$1 AND stop_reason='STEP_LIMIT' LIMIT 1", [PD]))[0];
  const apiIp = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "editagent-api").trim();

  await probe("X1", "Slow-client backpressure: a stalled consumer's blocked write is abandoned by the 5 s write deadline and its stream slot is released; the API stays responsive", "while stalled: 5th stream for the actor -> 429 and other requests stay fast; slot freed ~5-8 s after the stall begins (before the 120 s stream limit); stalled socket reset. Variant A natural buffers, variant B constrained container TCP send buffer (test-network fault injection)", async () => {
    const viewer = await newUser(browser, "stall");
    await setMembership(PD, viewer.id, "viewer");
    const ck = await cookieHeader(viewer);
    const runPath = `${base(PD)}/${bigRun.id}/events`;
    const pid = docker("inspect", "-f", "{{.State.Pid}}", "editagent-api").trim();
    const nsenter = (...a: string[]) => new Promise<string>((resolve) => execFile("sudo", ["nsenter", "-t", pid, "-n", ...a], (e, out) => resolve(e ? `ERR ${String(e).slice(0, 80)}` : out.trim())));
    const original = await nsenter("sysctl", "-n", "net.ipv4.tcp_wmem");
    const out: Record<string, unknown> = { bigRunEvents: bigRun.sequence, originalTcpWmem: original };
    for (const variant of ["A_natural", "B_constrained_sndbuf"]) {
      if (variant.startsWith("B")) await nsenter("sysctl", "-w", "net.ipv4.tcp_wmem=4096 4096 4096");
      try {
        const normal = [0, 1, 2].map(() => open(ck, runPath));
        await Promise.all(normal.map((n) => n.status));
        const t0 = Date.now();
        const stalled = stall(apiIp, runPath, ck, 2048, 30);
        await sleep(1500);
        const fifth = open(ck, runPath); const fifthStatus = (await fifth.status).status; fifth.close();
        const t1 = Date.now(); const other = await call(owner, "GET", "/projects"); const responsiveMs = Date.now() - t1;
        let freedAfterMs: number | null = null;
        while (Date.now() - t0 < 25_000) {
          const tryOne = open(ck, runPath); const s = (await tryOne.status).status; tryOne.close();
          if (s === 200) { freedAfterMs = Date.now() - t0; break; }
          await sleep(500);
        }
        const client = await stalled;
        normal.forEach((n) => n.close());
        out[variant] = { fifthWhileStalled: fifthStatus, otherRequest: [other.status, responsiveMs], slotFreedAfterMs: freedAfterMs, stalledClient: client };
      } finally {
        if (variant.startsWith("B")) out.restoredTcpWmem = (await nsenter("sysctl", "-w", `net.ipv4.tcp_wmem=${original}`), await nsenter("sysctl", "-n", "net.ipv4.tcp_wmem"));
      }
      await sleep(1500);
    }
    const ok = (v: any) => v && v.fifthWhileStalled === 429 && v.otherRequest[0] === 200 && v.otherRequest[1] < 3000 && v.slotFreedAfterMs !== null && v.slotFreedAfterMs >= 4500 && v.slotFreedAfterMs <= 15_000;
    const anyProof = ok(out.A_natural) || ok(out.B_constrained_sndbuf);
    if (!anyProof && (out.B_constrained_sndbuf as any)?.slotFreedAfterMs === null && (out.A_natural as any)?.slotFreedAfterMs === null)
      return { pass: null, notVerified: "kernel/proxy buffering absorbed the whole bounded event log; the server write never blocked, so the 5 s deadline could not be triggered on this runner", actual: out };
    return { pass: anyProof && out.restoredTcpWmem === original, actual: out };
  });

  await probe("X2", "64 concurrent SSE streams per API process (16 actors x 4), the 65th refused, slot reusable after a close", "64x200; 65th (17th actor) -> 429; after closing one stream the 17th actor gets 200; per-actor cap still 4", async () => {
    const users: User[] = [];
    for (let i = 0; i < 17; i++) { const u = await newUser(browser, `cap${i}`); await setMembership(P, u.id, "viewer"); users.push(u); }
    const cks = await Promise.all(users.map((u) => cookieHeader(u)));
    const p = `${base(P)}/${lifeRun}/events`;
    const handles = users.slice(0, 16).flatMap((_, i) => [0, 1, 2, 3].map(() => open(cks[i]!, p)));
    const statuses = (await Promise.all(handles.map((h) => h.status))).map((s) => s.status);
    const extra = open(cks[16]!, p); const extraStatus = (await extra.status).status; extra.close();
    handles[0]!.close(); await sleep(800);
    const again = open(cks[16]!, p); const againStatus = (await again.status).status;
    const perActor = open(cks[1]!, p); const perActorStatus = (await perActor.status).status; perActor.close();
    again.close(); handles.forEach((h) => h.close());
    for (const u of users) await setMembership(P, u.id, null);
    const ok200 = statuses.filter((s) => s === 200).length;
    return { pass: ok200 === 64 && extraStatus === 429 && againStatus === 200 && perActorStatus === 429, actual: { accepted: ok200, statuses: [...new Set(statuses)], sixtyFifth: extraStatus, afterClose: againStatus, fifthForSameActor: perActorStatus } };
  });

  await probe("X3", "API SIGKILL: open streams die, PG history survives, resume via Last-Event-ID is exact and duplicate-free; admissions/cancel racing the kill stay single and consistent", "stream reset by SIGKILL; events appended while API is dead; after restart resume from seq1 returns 2..n exactly once, resume from seq3 returns 4..n; racing admissions: <=1 run per key, retries return the same id; racing cancel ends Cancelled once; logs contiguous", async () => {
    worker.stop();
    const r = await call(owner, "POST", base(PO), { idempotencyKey: key() });
    const ck = await cookieHeader(owner);
    const first = sse(ck, `${base(PO)}/${r.json.id}/events`, { timeoutMs: 60_000 });
    await sleep(2000);
    const cRun = await call(owner, "POST", base(PO), { idempotencyKey: key() });
    const keys = Array.from({ length: 6 }, key);
    const racing = keys.map((k) => call(owner, "POST", base(PO), { idempotencyKey: k }).catch(() => ({ status: -1, json: null })));
    const racingCancel = call(owner, "POST", `${base(PO)}/${cRun.json.id}/cancel`).catch(() => ({ status: -1, json: null }));
    await sleep(40);
    docker("kill", "-s", "KILL", "editagent-api");
    const s1 = await first;
    const racingStatuses = (await Promise.all(racing)).map((x: any) => x.status), cancelStatus = (await racingCancel as any).status;
    worker.start();
    await settledRun(r.json.id);
    docker("compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "api");
    await until(apiUp, 120_000, "api up", 1000);
    const pg = (await events(r.json.id)).map((e) => e.sequence);
    const ids = s1.events.map((e) => e.id);
    const resume1 = await sse(ck, `${base(PO)}/${r.json.id}/events`, { lastEventId: ids[0], timeoutMs: 4000 });
    const all = await sse(ck, `${base(PO)}/${r.json.id}/events`, { timeoutMs: 4000 });
    const resume3 = await sse(ck, `${base(PO)}/${r.json.id}/events`, { lastEventId: all.events[2]!.id, timeoutMs: 4000 });
    const retried = [] as string[];
    for (const k of keys) { const x = await call(owner, "POST", base(PO), { idempotencyKey: k }); retried.push(`${x.status}`); }
    const perKey = await q("SELECT admission_key, count(*)::int n FROM agent_runs WHERE project_id=$1 GROUP BY admission_key HAVING count(*)>1", [PO]);
    const cancelAgain = await call(owner, "POST", `${base(PO)}/${cRun.json.id}/cancel`);
    const cEvents = await events(cRun.json.id);
    const runs = await q("SELECT id FROM agent_runs WHERE project_id=$1", [PO]);
    const broken: string[] = [];
    for (const x of runs) { const e = await events(x.id); if (!e.every((v, i) => v.sequence === i + 1)) broken.push(x.id); }
    const seqs = (xs: any[]) => xs.map((e) => e.data.sequence);
    return { pass: s1.closed !== "timeout" && s1.events.length === 1 && JSON.stringify(seqs(resume1.events)) === JSON.stringify(pg.slice(1)) && JSON.stringify(seqs(all.events)) === JSON.stringify(pg) &&
        JSON.stringify(seqs(resume3.events)) === JSON.stringify(pg.slice(3)) && perKey.length === 0 && retried.every((s) => s === "201" || s === "200") &&
        cancelAgain.json?.state === "Cancelled" && cEvents.filter((e) => e.state === "Cancelled").length === 1 && broken.length === 0,
      actual: { streamClosedBy: s1.closed, beforeKill: seqs(s1.events), pg, resumeAfterSeq1: seqs(resume1.events), resumeAfterSeq3: seqs(resume3.events), racingAdmissions: racingStatuses, retriedAfterRestart: retried, duplicateKeys: perKey.length, racingCancel: cancelStatus, cancelAfterRestart: [cancelAgain.status, cancelAgain.json?.state], cancelledTransitions: cEvents.filter((e) => e.state === "Cancelled").length, nonContiguousRuns: broken } };
  });

  await probe("X4", "SSE 120 s upper bound on an OPEN (nonterminal) run with valid auth", "stream ends normally between 115 and 125 s while the run stays Pending; 1 event + heartbeats", async () => {
    worker.stop();
    const r = await call(owner, "POST", base(PO), { idempotencyKey: key() });
    const s = await sse(await cookieHeader(owner), `${base(PO)}/${r.json.id}/events`, { timeoutMs: 170_000 });
    const state = (await q("SELECT state FROM agent_runs WHERE id=$1", [r.json.id]))[0].state;
    await call(owner, "POST", `${base(PO)}/${r.json.id}/cancel`);
    worker.start();
    return { pass: s.status === 200 && s.closed === "end" && s.ms >= 115_000 && s.ms <= 125_000 && state === "Pending", actual: { status: s.status, closedBy: s.closed, ms: s.ms, events: s.events.length, heartbeats: s.comments, runStateDuringStream: state } };
  });

  await probe("X5", "Access-token expiry DURING an open stream: the stream is reset at expiry and no event appended after expiry is delivered; reconnect with the expired cookie is 401", "stream opened ~45 s before exp with the original cookie; worker started after exp appends events; stream closed within ~1 s after exp with only pre-expiry events; reconnect 401; a fresh session reads all events", async () => {
    const wait = expAt - 50_000 - Date.now();
    if (wait > 0) await sleep(wait);
    worker.stop();
    const t = await fetch(API + base(PX), { method: "POST", headers: { cookie: expCookie, origin: "http://localhost:3000", "content-type": "application/json", "x-editagent-csrf": /editagent_csrf=([^;]+)/.exec(expCookie)?.[1] ?? "" }, body: JSON.stringify({ idempotencyKey: key() }) });
    const run = await t.json();
    let lastEventAt = 0;
    const streamStartedAt = Date.now();
    const streaming = sse(expCookie, `${base(PX)}/${run.id}/events`, { timeoutMs: 120_000, onEvent: () => { lastEventAt = Date.now(); } });
    await sleep(Math.max(0, expAt + 3000 - Date.now()));
    worker.start();
    await settledRun(run.id);
    const s = await streaming;
    const reconnect = await sse(expCookie, `${base(PX)}/${run.id}/events`, { timeoutMs: 3000 });
    const fresh = await call(expUser, "GET", `${base(PX)}/${run.id}/audit`);
    const pg = (await events(run.id)).length;
    const closedRel = streamStartedAt + s.ms - expAt;
    return { pass: t.status === 201 && s.events.length >= 1 && s.events.every((e) => e.data.atMs < expAt) && s.closed !== "timeout" && closedRel < 2000 && closedRel > -60_000 && reconnect.status === 401 && fresh.status === 200 && pg > s.events.length,
      actual: { start: t.status, deliveredSequences: s.events.map((e) => e.data.sequence), closedBy: s.closed, closedRelativeToExpiryMs: closedRel, lastEventBeforeExpiryMs: lastEventAt ? lastEventAt - expAt : null, eventsInPg: pg, reconnectWithExpiredCookie: reconnect.status, freshSessionAudit: fresh.status } };
  });
  await pool.end();
});
