/** PR #77 independent QA, part S: AgentRun API/SSE/audit/export against PRODUCTION containers
 * (api + agent-worker images built from the frozen SHA, real PostgreSQL/Redis/S3). QA-authored. */
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  API, INPUTS, OUT, PRIVATE, call, cookieHeader, docker, leakScan, newProject, newTimeline, newUser, pool, probe, q, refresh,
  setMembership, sha, contentSha, sleep, sse, terminal, until, upload, uuid7, type User,
} from "./helpers77";

const base = (p: string) => `/projects/${p}/agent-runs`;
const key = () => `qa77-${randomUUID().replaceAll("-", "")}`;
const worker = {
  stop: () => docker("compose", "stop", "-t", "5", "agent-worker"),
  start: () => docker("compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "agent-worker"),
};
const run = async (id: string) => (await q("SELECT * FROM agent_runs WHERE id=$1", [id]))[0];
const events = async (id: string) => (await q("SELECT sequence, event FROM agent_events WHERE run_id=$1 ORDER BY sequence", [id])).map((r) => r.event);
const settledRun = (id: string, ms = 60_000) => until(async () => { const r = await run(id); return r && terminal(r.state) ? r : null; }, ms, `run ${id} terminal`);
const contiguous = (evs: { sequence: number }[]) => evs.every((e, i) => e.sequence === i + 1);
const workerReady = () => { try { docker("exec", "editagent-agent-worker", "node", "-e", "fetch('http://127.0.0.1:3200/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"); return true; } catch { return false; } };
const apiReady = async () => { try { return (await fetch(API + "/ready", { signal: AbortSignal.timeout(4000) })).ok; } catch { return false; } };

test("PR77 part S: AgentRun service probes", async ({ browser }) => {
  const owner = await newUser(browser, "owner"), editor = await newUser(browser, "editor"), viewer = await newUser(browser, "viewer");
  const outsider = await newUser(browser, "outsider"), viewer2 = await newUser(browser, "viewer2");
  const P = await newProject(owner, "QA77 agent runs");
  const P2 = await newProject(outsider, "QA77 foreign");
  await setMembership(P, editor.id, "editor"); await setMembership(P, viewer.id, "viewer"); await setMembership(P, viewer2.id, "viewer");
  const M = await upload(owner.page, P, path.join(INPUTS, "qa-source.mp4"), []);
  const timelines = [] as { id: string; sha: string; snapshot: any }[];
  for (let i = 0; i < 6; i++) timelines.push(await newTimeline(owner, P, M));
  // Fixture project for the QA driver (part D): its own timelines, owner actor, editor member.
  const PD = await newProject(owner, "QA77 driver");
  await setMembership(PD, editor.id, "editor");
  const MD = await upload(owner.page, PD, path.join(INPUTS, "qa-source.mp4"), []);
  const driverTimelines = [] as { id: string; sha: string; snapshot: any }[];
  for (let i = 0; i < 24; i++) driverTimelines.push(await newTimeline(owner, PD, MD));
  writeFileSync(path.join(PRIVATE, "state77.json"), JSON.stringify({ P, P2, PD, owner: owner.id, editor: editor.id, viewer: viewer.id, outsider: outsider.id, driverTimelines }));
  const T = timelines[0]!;

  // ---------------- US-303 lifecycle ----------------
  let lifeRun = "";
  await probe("S1", "Production driver: authenticated start -> worker -> honest Failed/PLANNER_NOT_CONFIGURED; never Completed; no LLM tokens", "201; terminal Failed with PLANNER_NOT_CONFIGURED; states Pending->Observing->Planning->Failed; every event tokens=null, tokenMeasurement=not_applicable, decision=no_llm; runtime infrastructure-v1/not_configured; source snapshot hash captured", async () => {
    const withSource = await call(owner, "POST", base(P), { idempotencyKey: key(), timelineId: T.id, stateSha256: T.sha });
    const noSource = await call(editor, "POST", base(P), { idempotencyKey: key() });
    lifeRun = withSource.json?.id;
    const a = await settledRun(lifeRun), b = await settledRun(noSource.json?.id);
    const ea = await events(lifeRun), eb = await events(noSource.json.id);
    const g = await call(owner, "GET", `${base(P)}/${lifeRun}`);
    const states = ea.map((e) => `${e.kind}:${e.state}`);
    const honest = [...ea, ...eb].every((e) => e.tokens === null && e.tokenMeasurement === "not_applicable" && e.decision === "no_llm");
    const job = (await q("SELECT status FROM jobs WHERE id=$1", [lifeRun]))[0];
    return { pass: withSource.status === 201 && noSource.status === 201 && a.state === "Failed" && a.stop_reason === "PLANNER_NOT_CONFIGURED" && b.stop_reason === "PLANNER_NOT_CONFIGURED" &&
        ea.some((e) => e.state === "Observing") && ea.some((e) => e.state === "Planning") && !ea.some((e) => ["Executing", "Completed"].includes(e.state)) && contiguous(ea) && honest &&
        g.json?.runtime?.driver === "infrastructure-v1" && g.json?.runtime?.planner === "not_configured" && a.source_sha256 === T.sha && sha(JSON.stringify(a.source_snapshot)) !== "" ,
      actual: { start: [withSource.status, noSource.status], final: [a.state, a.stop_reason, b.state, b.stop_reason], states, honestTokens: honest, runtime: g.json?.runtime, job: job?.status, sourceCaptured: a.source_sha256 === T.sha } };
  });

  await probe("S2", "Authorization matrix and 404 privacy (owner/editor/viewer/outsider/unauth/CSRF/foreign/invalid ids)", "owner+editor start 201; viewer start/cancel 403; viewer get/audit/export 200; outsider & nonexistent & foreign-project 404 with identical bodies; unauth 401; missing CSRF 403; invalid UUID 400", async () => {
    const r: Record<string, number> = {};
    r.viewerStart = (await call(viewer, "POST", base(P), { idempotencyKey: key() })).status;
    r.viewerCancel = (await call(viewer, "POST", `${base(P)}/${lifeRun}/cancel`)).status;
    for (const p of ["", "/audit", "/export"]) r[`viewerGet${p}`] = (await call(viewer, "GET", `${base(P)}/${lifeRun}${p}`)).status;
    const ghostId = uuid7();
    const out = await call(outsider, "GET", `${base(P)}/${lifeRun}`), ghost = await call(owner, "GET", `${base(P)}/${ghostId}`);
    const foreign = await call(outsider, "GET", `${base(P2)}/${lifeRun}`); // run exists, but in another project
    const outAudit = await call(outsider, "GET", `${base(P)}/${lifeRun}/audit`), outExport = await call(outsider, "GET", `${base(P)}/${lifeRun}/export`);
    const outCancel = await call(outsider, "POST", `${base(P)}/${lifeRun}/cancel`), outStart = await call(outsider, "POST", base(P), { idempotencyKey: key() });
    const outSse = await sse(await cookieHeader(outsider), `${base(P)}/${lifeRun}/events`, { timeoutMs: 5000 });
    r.outsider = out.status; r.ghost = ghost.status; r.foreign = foreign.status; r.outsiderAudit = outAudit.status; r.outsiderExport = outExport.status; r.outsiderCancel = outCancel.status; r.outsiderStart = outStart.status; r.outsiderSse = outSse.status;
    r.unauthGet = (await call(null, "GET", `${base(P)}/${lifeRun}`)).status;
    r.unauthStart = (await call(null, "POST", base(P), { idempotencyKey: key() })).status;
    r.noCsrfStart = (await call(owner, "POST", base(P), { idempotencyKey: key() }, { csrf: false })).status;
    r.noCsrfCancel = (await call(owner, "POST", `${base(P)}/${lifeRun}/cancel`, undefined, { csrf: false })).status;
    r.badProject = (await call(owner, "GET", `/projects/not-a-uuid/agent-runs/${lifeRun}`)).status;
    r.badRun = (await call(owner, "GET", `${base(P)}/not-a-uuid`)).status;
    r.v4Run = (await call(owner, "GET", `${base(P)}/${randomUUID()}`)).status;
    const bodies = new Set([out.text, ghost.text, foreign.text, outAudit.text, outExport.text, outCancel.text, outStart.text]);
    return { pass: r.viewerStart === 403 && r.viewerCancel === 403 && r.viewerGet === 200 && r["viewerGet/audit"] === 200 && r["viewerGet/export"] === 200 && r.outsider === 404 && r.ghost === 404 && r.foreign === 404 &&
        r.outsiderAudit === 404 && r.outsiderExport === 404 && r.outsiderCancel === 404 && r.outsiderStart === 404 && r.outsiderSse === 404 && bodies.size === 1 && r.unauthGet === 401 && r.unauthStart === 401 &&
        r.noCsrfStart === 403 && r.noCsrfCancel === 403 && r.badProject === 400 && r.badRun === 400 && [400, 404].includes(r.v4Run!),
      actual: { ...r, identical404Bodies: bodies.size === 1, sample404: out.text.slice(0, 100) } };
  });

  await probe("S3", "Admission idempotency scoped to project+actor; 409 on source mismatch; strict input; injection-shaped values refused", "same key/actor/body -> same run; different source -> 409; same key other actor -> distinct run; extra fields/prompt/tool/bad key/bad hash/SQL-shaped -> 400; hash mismatch -> 409; foreign timeline -> 404; 1 MiB body refused", async () => {
    const k = key();
    const a = await call(owner, "POST", base(P), { idempotencyKey: k, timelineId: T.id, stateSha256: T.sha });
    const b = await call(owner, "POST", base(P), { idempotencyKey: k, timelineId: T.id, stateSha256: T.sha });
    const c = await call(owner, "POST", base(P), { idempotencyKey: k });
    const d = await call(owner, "POST", base(P), { idempotencyKey: k, timelineId: timelines[1]!.id, stateSha256: timelines[1]!.sha });
    const e = await call(editor, "POST", base(P), { idempotencyKey: k, timelineId: T.id, stateSha256: T.sha });
    const bad: Record<string, number> = {};
    const cases: Record<string, unknown> = {
      prompt: { idempotencyKey: key(), prompt: "remove silences" }, tool: { idempotencyKey: key(), tool: "editing.trim-video" },
      shortKey: { idempotencyKey: "short" }, longKey: { idempotencyKey: "a".repeat(97) }, sqlKey: { idempotencyKey: "abcdefghijklmnop'; DROP TABLE agent_runs;--" },
      onlyTimeline: { idempotencyKey: key(), timelineId: T.id }, badHash: { idempotencyKey: key(), timelineId: T.id, stateSha256: "Z".repeat(64) },
      sqlTimeline: { idempotencyKey: key(), timelineId: "' OR 1=1 --", stateSha256: T.sha }, array: [{ idempotencyKey: key() }], nullBody: null,

    };
    for (const [name, body] of Object.entries(cases)) bad[name] = (await call(owner, "POST", base(P), body)).status;
    const mismatch = (await call(owner, "POST", base(P), { idempotencyKey: key(), timelineId: T.id, stateSha256: "0".repeat(64) })).status;
    const foreignTl = (await call(owner, "POST", base(P), { idempotencyKey: key(), timelineId: uuid7(), stateSha256: T.sha })).status;
    bad.rawProtoJson = (await call(owner, "POST", base(P), `{"idempotencyKey":"${key()}","__proto__":{"admin":true}}`, { headers: { "content-type": "application/json" } })).status;
    bad.constructorKey = (await call(owner, "POST", base(P), `{"idempotencyKey":"${key()}","constructor":{"prototype":{"x":1}}}`, { headers: { "content-type": "application/json" } })).status;
    const hugeRes = await call(owner, "POST", base(P), { idempotencyKey: key(), pad: "x".repeat(1_048_576) });
    const huge = hugeRes.status;
    const hugeControl = await call(owner, "POST", "/projects", { name: "x".repeat(1_048_576) });
    const tables = (await q("SELECT count(*)::int AS n FROM agent_runs"))[0].n;
    for (const id of [a.json?.id, e.json?.id]) if (id) await call(owner, "POST", `${base(P)}/${id}/cancel`);
    return { pass: a.status === 201 && b.json?.id === a.json?.id && [200, 201].includes(b.status) && c.status === 409 && d.status === 409 && e.status === 201 && e.json?.id !== a.json?.id &&
        Object.values(bad).every((s) => s === 400) && mismatch === 409 && foreignTl === 404 && ([400, 413].includes(huge) || huge === hugeControl.status) && leakScan(hugeRes.text).length === 0 && tables > 0,
      actual: { first: a.status, replay: [b.status, b.json?.id === a.json?.id], noSourceSameKey: c.status, otherSource: d.status, otherActor: [e.status, e.json?.id !== a.json?.id], bad, mismatch, foreignTimeline: foreignTl, hugeBody: [huge, hugeRes.text.slice(0, 80)], hugeBodyControlExistingRoute: [hugeControl.status, hugeControl.text.slice(0, 80)] } };
  });

  await probe("S4", "Concurrent PostgreSQL admission (worker stopped): project cap of 8 nonterminal runs; concurrent same-key admissions collapse to one run", "12 parallel distinct-key starts -> exactly 8x201 + 4x409 and DB nonterminal=8; 10 parallel same-key starts -> one run id", async () => {
    worker.stop();
    const P3 = await newProject(owner, "QA77 cap");
    const res = await Promise.all(Array.from({ length: 12 }, () => call(owner, "POST", base(P3), { idempotencyKey: key() })));
    const codes = res.map((r) => r.status).sort();
    const nonterminal = (await q("SELECT count(*)::int AS n FROM agent_runs WHERE project_id=$1 AND state NOT IN ('Completed','Failed','Cancelled')", [P3]))[0].n;
    for (const r of res) if (r.json?.id) await call(owner, "POST", `${base(P3)}/${r.json.id}/cancel`);
    const k = key();
    const same = await Promise.all(Array.from({ length: 10 }, () => call(editor, "POST", base(P), { idempotencyKey: k })));
    const ids = new Set(same.filter((r) => r.status < 300).map((r) => r.json.id));
    const rows = (await q("SELECT count(*)::int AS n FROM agent_runs WHERE project_id=$1 AND actor_id=$2 AND admission_key=$3", [P, editor.id, contentSha(k)]))[0].n;
    for (const id of ids) await call(editor, "POST", `${base(P)}/${id}/cancel`);
    return { pass: codes.filter((c) => c === 201).length === 8 && codes.filter((c) => c === 409).length === 4 && nonterminal === 8 && ids.size === 1 && rows === 1 && same.every((r) => r.status < 300),
      actual: { codes, nonterminal, sameKeyIds: ids.size, sameKeyCodes: same.map((r) => r.status), rows } };
  });

  await probe("S5", "Cancellation at Queued (worker stopped): durable terminal Cancelled, generation fenced, idempotent; restarted worker never resurrects it", "cancel 201 Cancelled/CANCELLED gen 1; second cancel unchanged; viewer cancel 403; after worker restart: still Cancelled, no new events, job not Running/Completed", async () => {
    const s = await call(owner, "POST", base(P), { idempotencyKey: key(), timelineId: T.id, stateSha256: T.sha });
    const c1 = await call(owner, "POST", `${base(P)}/${s.json.id}/cancel`), c2 = await call(owner, "POST", `${base(P)}/${s.json.id}/cancel`, {});
    const cBody = await call(owner, "POST", `${base(P)}/${s.json.id}/cancel`, { reason: "x" });
    const before = await events(s.json.id);
    worker.start();
    await sleep(8000);
    const after = await events(s.json.id), r = await run(s.json.id);
    const job = (await q("SELECT status FROM jobs WHERE id=$1", [s.json.id]))[0];
    // Terminal run that already failed honestly cannot be cancelled into a different state.
    const t = await call(owner, "POST", `${base(P)}/${lifeRun}/cancel`);
    return { pass: c1.status === 201 && c1.json?.state === "Cancelled" && c1.json?.stopReason === "CANCELLED" && c1.json?.generation === 1 && c2.json?.revision === c1.json?.revision &&
        cBody.status === 400 && after.length === before.length && r.state === "Cancelled" && (!job || job.status === "Cancelled") && t.json?.state === "Failed" && t.json?.stopReason === "PLANNER_NOT_CONFIGURED",
      actual: { cancel: [c1.status, c1.json?.state, c1.json?.stopReason, c1.json?.generation], repeat: [c2.status, c2.json?.revision === c1.json?.revision], payloadRejected: cBody.status, eventsBefore: before.length, eventsAfter: after.length, final: r.state, job: job?.status ?? "none", terminalCancel: [t.status, t.json?.state, t.json?.stopReason] } };
  });

  await probe("S6", "Redis outage: admission is durable in PostgreSQL (outbox), worker readiness drops, run completes after recovery; no false success", "while Redis paused: start 201, worker /ready false; after unpause: run reaches Failed/PLANNER_NOT_CONFIGURED; never Completed", async () => {
    docker("pause", "editagent-redis");
    let s: Awaited<ReturnType<typeof call>>, readyDuring = true;
    try {
      s = await call(owner, "POST", base(P), { idempotencyKey: key() });
      await sleep(6000);
      readyDuring = workerReady();
    } finally { docker("unpause", "editagent-redis"); }
    const r = await settledRun(s!.json.id, 120_000);
    const readyAfter = await until(async () => workerReady(), 90_000, "worker ready", 2000);
    return { pass: s!.status === 201 && readyDuring === false && r.state === "Failed" && r.stop_reason === "PLANNER_NOT_CONFIGURED" && readyAfter,
      actual: { start: s!.status, workerReadyDuringOutage: readyDuring, final: [r.state, r.stop_reason], readyAfter } };
  });

  await probe("S7", "PostgreSQL outage: API answers safely (no stack/SQL), readiness false for API and worker; recovery afterwards", "during PG pause: start returns 5xx with safe body, /ready false (API and worker); after unpause: start 201 and run terminal", async () => {
    const ck = await cookieHeader(owner);
    const csrf = (await owner.ctx.cookies(API)).find((c) => c.name === "editagent_csrf")?.value ?? "";
    const timed = async (method: string, url: string, body?: unknown) => {
      const t = Date.now();
      try {
        const res = await fetch(API + url, { method, headers: { cookie: ck, origin: "http://localhost:3000", "content-type": "application/json", "x-editagent-csrf": csrf }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
        return { status: res.status, ms: Date.now() - t, text: (await res.text()).slice(0, 200) };
      } catch (e) { return { status: -1, ms: Date.now() - t, text: String((e as Error).name) }; }
    };
    docker("pause", "editagent-postgres");
    let agent: Awaited<ReturnType<typeof timed>>, control: Awaited<ReturnType<typeof timed>>, apiR = true, wR = true;
    try {
      [agent, control] = await Promise.all([timed("POST", base(P), { idempotencyKey: key() }), timed("GET", "/projects")]);
      apiR = await apiReady(); wR = workerReady();
    } finally { docker("unpause", "editagent-postgres"); }
    await until(async () => apiReady(), 120_000, "api ready", 2000);
    const s = await until(async () => { const r = await call(owner, "POST", base(P), { idempotencyKey: key() }); return r.status === 201 ? r : null; }, 60_000, "start after PG recovery", 2000);
    const r = await settledRun(s.json.id, 120_000);
    // A hang/timeout during the outage is judged against the pre-existing control route (same API, same pool).
    const sameAsControl = (agent!.status === -1) === (control!.status === -1);
    return { pass: leakScan(agent!.text).length === 0 && apiR === false && wR === false && r.stop_reason === "PLANNER_NOT_CONFIGURED" && (agent!.status >= 500 || sameAsControl),
      actual: { agentDuringOutage: agent!, existingRouteControl: control!, leaks: leakScan(agent!.text), apiReadyDuring: apiR, workerReadyDuring: wR, afterRecovery: [r.state, r.stop_reason] } };
  });

  // ---------------- US-306 SSE ----------------
  await probe("S8", "SSE: ordered PG-backed catch-up, resume via Last-Event-ID / after, conflicting/tampered/cross-run cursors refused", "full stream ids seq.uuid contiguous and equal to audit; resume after seq2 yields seq3..n exactly; header+query equal ok, conflicting 400; forged uuid/malformed/cross-run 400; multi-valued header 400", async () => {
    const ck = await cookieHeader(viewer);
    const full = await sse(ck, `${base(P)}/${lifeRun}/events`, { timeoutMs: 4000 });
    const audit = await call(viewer, "GET", `${base(P)}/${lifeRun}/audit`);
    const ids = full.events.map((e) => e.id);
    const ordered = full.events.every((e, i) => e.data.sequence === i + 1 && e.id === `${e.data.sequence}.${e.data.id}`);
    const sameAsAudit = JSON.stringify(full.events.map((e) => e.data)) === JSON.stringify(audit.json?.events);
    const viaHeader = await sse(ck, `${base(P)}/${lifeRun}/events`, { lastEventId: ids[1], timeoutMs: 3000 });
    const viaQuery = await sse(ck, `${base(P)}/${lifeRun}/events?after=${encodeURIComponent(ids[1]!)}`, { timeoutMs: 3000 });
    const both = await sse(ck, `${base(P)}/${lifeRun}/events?after=${encodeURIComponent(ids[1]!)}`, { lastEventId: ids[1], timeoutMs: 3000 });
    const conflict = await sse(ck, `${base(P)}/${lifeRun}/events?after=${encodeURIComponent(ids[0]!)}`, { lastEventId: ids[1], timeoutMs: 3000 });
    const forged = await sse(ck, `${base(P)}/${lifeRun}/events`, { lastEventId: `2.${uuid7()}`, timeoutMs: 3000 });
    const malformed = await sse(ck, `${base(P)}/${lifeRun}/events?after=2;DROP`, { timeoutMs: 3000 });
    const otherRun = (await q("SELECT id FROM agent_runs WHERE project_id=$1 AND id<>$2 LIMIT 1", [P, lifeRun]))[0].id;
    const otherFirst = (await events(otherRun))[0];
    const crossRun = await sse(ck, `${base(P)}/${lifeRun}/events`, { lastEventId: `1.${otherFirst.id}`, timeoutMs: 3000 });
    const multi = await sse(ck, `${base(P)}/${lifeRun}/events`, { lastEventId: [ids[0]!, ids[1]!], timeoutMs: 3000 });
    const tail = viaHeader.events.map((e) => e.id);
    return { pass: full.status === 200 && ordered && sameAsAudit && JSON.stringify(tail) === JSON.stringify(ids.slice(2)) && JSON.stringify(viaQuery.events.map((e) => e.id)) === JSON.stringify(ids.slice(2)) &&
        both.status === 200 && conflict.status === 400 && forged.status === 400 && malformed.status === 400 && crossRun.status === 400 && [200, 400].includes(multi.status) &&
        String(full.headers["content-type"]).startsWith("text/event-stream") && /no-store/.test(String(full.headers["cache-control"])),
      actual: { status: full.status, ids, ordered, sameAsAudit, resumeHeader: tail, resumeQuery: viaQuery.events.map((e) => e.id), both: both.status, conflict: conflict.status, forged: forged.status, malformed: malformed.status, crossRun: crossRun.status, multiValuedHeader: [multi.status, multi.events.length], headers: [full.headers["content-type"], full.headers["cache-control"]] } };
  });

  await probe("S9", "SSE membership revocation mid-stream closes before protected bytes (new events appended after revocation are never delivered)", "worker stopped; viewer2 streams Pending run and receives seq1; revoke viewer2; worker processes run (new events in PG); viewer2 stream is reset and receives no event with sequence>1; reconnect 404", async () => {
    worker.stop();
    const s = await call(owner, "POST", base(P), { idempotencyKey: key() });
    const ck = await cookieHeader(viewer2);
    const streaming = sse(ck, `${base(P)}/${s.json.id}/events`, { timeoutMs: 45_000 });
    await sleep(2500);
    await setMembership(P, viewer2.id, null);
    worker.start();
    await settledRun(s.json.id, 60_000);
    const r = await streaming;
    const reconnect = await sse(ck, `${base(P)}/${s.json.id}/events`, { timeoutMs: 3000 });
    await setMembership(P, viewer2.id, "viewer");
    const total = (await events(s.json.id)).length;
    return { pass: r.events.length >= 1 && r.events.every((e) => e.data.sequence === 1) && r.closed !== "timeout" && total > 1 && reconnect.status === 404,
      actual: { delivered: r.events.map((e) => e.id.split(".")[0]), closedBy: r.closed, afterMs: r.ms, totalEventsInPg: total, reconnect: reconnect.status } };
  });

  await probe("S10", "SSE after sign-out (stateless access JWT): observe whether an open stream / reconnect continues", "informational: record behaviour; access tokens are stateless 15-minute JWTs (pre-existing design)", async () => {
    worker.stop();
    const s = await call(owner, "POST", base(P), { idempotencyKey: key() });
    const ck = await cookieHeader(editor);
    const streaming = sse(ck, `${base(P)}/${s.json.id}/events`, { timeoutMs: 30_000 });
    await sleep(1500);
    const logout = await call(editor, "POST", "/auth/logout");
    worker.start();
    await settledRun(s.json.id, 60_000);
    const r = await streaming;
    const reconnect = await sse(ck, `${base(P)}/${s.json.id}/events`, { timeoutMs: 3000 });
    return { pass: null, observed: true, actual: { logout: logout.status, deliveredAfterLogout: r.events.map((e) => e.data.sequence), closedBy: r.closed, reconnectWithOldAccessCookie: [reconnect.status, reconnect.events.length] } };
  });

  await probe("S11", "SSE across API restart and Redis outage: PG-backed reconnect resumes exactly once (no gap, no duplicate, no false Redis replay)", "stream terminated by API restart; reconnect with last id after restart returns only later sequences; while Redis paused the catch-up still serves PG history", async () => {
    worker.stop();
    const s = await call(owner, "POST", base(P), { idempotencyKey: key() });
    const ck = await cookieHeader(owner);
    const first = sse(ck, `${base(P)}/${s.json.id}/events`, { timeoutMs: 120_000 });
    await sleep(2000);
    docker("compose", "restart", "-t", "10", "api");
    const r1 = await first;
    await until(async () => apiReady(), 120_000, "api ready after restart", 1000);
    worker.start();
    await settledRun(s.json.id, 60_000);
    await refresh(owner);
    const ck2 = await cookieHeader(owner);
    const lastId = r1.events.at(-1)?.id;
    const r2 = await sse(ck2, `${base(P)}/${s.json.id}/events`, { lastEventId: lastId, timeoutMs: 4000 });
    docker("pause", "editagent-redis");
    let r3: Awaited<ReturnType<typeof sse>>;
    try { r3 = await sse(ck2, `${base(P)}/${s.json.id}/events`, { timeoutMs: 4000 }); } finally { docker("unpause", "editagent-redis"); }
    const all = [...r1.events, ...r2.events].map((e) => e.data.sequence);
    const pg = (await events(s.json.id)).map((e) => e.sequence);
    return { pass: r1.closed !== "timeout" && JSON.stringify(all) === JSON.stringify(pg) && r3!.status === 200 && JSON.stringify(r3!.events.map((e) => e.data.sequence)) === JSON.stringify(pg),
      actual: { firstClosedBy: r1.closed, beforeRestart: r1.events.map((e) => e.data.sequence), afterRestart: r2.events.map((e) => e.data.sequence), pg, redisPausedCatchUp: r3!.events.map((e) => e.data.sequence) } };
  });

  await probe("S12", "SSE per-actor stream limit", "4 concurrent streams for one actor accepted; 5th -> 429; after closing, a new stream is accepted", async () => {
    const ck = await cookieHeader(viewer);
    const open = [0, 1, 2, 3].map(() => sse(ck, `${base(P)}/${lifeRun}/events`, { timeoutMs: 6000 }));
    await sleep(1500);
    const fifth = await sse(ck, `${base(P)}/${lifeRun}/events`, { timeoutMs: 2000 });
    const four = await Promise.all(open);
    await sleep(500);
    const again = await sse(ck, `${base(P)}/${lifeRun}/events`, { timeoutMs: 2000 });
    return { pass: four.every((r) => r.status === 200) && fifth.status === 429 && again.status === 200, actual: { four: four.map((r) => r.status), fifth: fifth.status, afterClose: again.status } };
  });

  // ---------------- US-306 audit / export ----------------
  await probe("S13", "Audit/export pagination: fixed through-sequence, stable order, bounds, forged/cross-run/tampered cursors refused, revocation between pages", "limit=2 pages concatenate to the full ordered log; through fixed; default 50; limit 0/101/abc -> 400; tampered/cross-run/garbage cursors -> 400; viewer revoked after page 1 -> 404", async () => {
    const all = await call(viewer, "GET", `${base(P)}/${lifeRun}/audit`);
    const pages = [] as any[];
    let cursor: string | null = null;
    do {
      const r = await call(viewer, "GET", `${base(P)}/${lifeRun}/export?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      pages.push(r.json); cursor = r.json?.nextCursor ?? null;
    } while (cursor && pages.length < 20);
    const concat = pages.flatMap((p) => p.events.map((e: any) => e.sequence));
    const through = new Set(pages.map((p) => p.throughSequence));
    const bounds: Record<string, number> = {};
    for (const l of ["0", "101", "abc", "-1", "1e2", "50.5"]) bounds[l] = (await call(viewer, "GET", `${base(P)}/${lifeRun}/audit?limit=${l}`)).status;
    const c1 = pages[0].nextCursor as string;
    const decoded = JSON.parse(Buffer.from(c1, "base64url").toString());
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const otherRun = (await q("SELECT id FROM agent_runs WHERE project_id=$1 AND id<>$2 AND sequence>2 LIMIT 1", [P, lifeRun]))[0].id;
    const forged: Record<string, number> = {};
    const variants: Record<string, string> = {
      throughBeyond: enc([decoded[0], decoded[1], decoded[2], decoded[3] + 5, decoded[4]]), anchorForged: enc([decoded[0], decoded[1], uuid7(), decoded[3], decoded[4]]),
      afterGtThrough: enc([decoded[0], decoded[3] + 1, decoded[2], decoded[3], decoded[4]]), wrongRunInCursor: enc([otherRun, ...decoded.slice(1)]), garbage: "!!notbase64!!", tooLong: "A".repeat(300),
      notArray: enc({ a: 1 }), sqlish: enc([decoded[0], "1 OR 1=1", decoded[2], decoded[3], decoded[4]]),
    };
    for (const [n, c] of Object.entries(variants)) forged[n] = (await call(viewer, "GET", `${base(P)}/${lifeRun}/audit?cursor=${encodeURIComponent(c)}`)).status;
    forged.crossRunUse = (await call(viewer, "GET", `${base(P)}/${otherRun}/audit?cursor=${c1}`)).status;
    await setMembership(P, viewer.id, null);
    const revoked = await call(viewer, "GET", `${base(P)}/${lifeRun}/export?limit=2&cursor=${c1}`);
    await setMembership(P, viewer.id, "viewer");
    const full = all.json.events.map((e: any) => e.sequence);
    return { pass: JSON.stringify(concat) === JSON.stringify(full) && through.size === 1 && all.json.throughSequence === full.length && Object.values(bounds).every((s) => s === 400) &&
        Object.values(forged).every((s) => s === 400) && revoked.status === 404 && pages.at(-1).nextCursor === null,
      actual: { pages: pages.length, concat, full, through: [...through], bounds, forged, revokedNextPage: revoked.status } };
  });

  await probe("S14", "Audit snapshot isolation: first page captures through-sequence; events appended later are excluded from that pagination", "page 1 (limit 1) through=n; run then progresses; following pages stop at n; a fresh request sees the new events", async () => {
    worker.stop();
    const s = await call(owner, "POST", base(P), { idempotencyKey: key() });
    const p1 = await call(owner, "GET", `${base(P)}/${s.json.id}/audit?limit=1`);
    worker.start();
    await settledRun(s.json.id, 60_000);
    // n=1 means no nextCursor; use the persisted first event as the only page and request again
    const later = await call(owner, "GET", `${base(P)}/${s.json.id}/audit?limit=1`);
    let cursor = later.json.nextCursor, seen = [later.json.events[0].sequence], throughs = new Set([later.json.throughSequence]);
    while (cursor) { const r = await call(owner, "GET", `${base(P)}/${s.json.id}/audit?limit=1&cursor=${cursor}`); seen.push(...r.json.events.map((e: any) => e.sequence)); throughs.add(r.json.throughSequence); cursor = r.json.nextCursor; }
    return { pass: p1.json.throughSequence === 1 && p1.json.nextCursor === null && throughs.size === 1 && seen.length === later.json.throughSequence && later.json.throughSequence > 1,
      actual: { firstThrough: p1.json.throughSequence, laterThrough: [...throughs], seen } };
  });

  await probe("S15", "Export redaction: no prompt/transcript/storage key/raw input/secret/stack/PII/arbitrary correlation text; unknowns explicit", "x-request-id marker absent from audit/export, present only as SHA-256; no emails, keys, stacks; tokens null/not_applicable/no_llm; correlationId server-generated UUID", async () => {
    const marker = `QA77marker${randomUUID().replaceAll("-", "")}`;
    const s = await call(owner, "POST", base(P), { idempotencyKey: key(), timelineId: T.id, stateSha256: T.sha }, { headers: { "x-request-id": marker } });
    await settledRun(s.json.id);
    const ex = await call(owner, "GET", `${base(P)}/${s.json.id}/export?limit=100`);
    const au = await call(owner, "GET", `${base(P)}/${s.json.id}/audit?limit=100`);
    const text = ex.text + au.text;
    const ev = ex.json.events as any[];
    const storageKeys = (await q("SELECT storage_key FROM media_assets WHERE project_id=$1", [P])).map((r) => r.storage_key);
    const leaks = leakScan(text, [marker, owner.email, editor.email, ...storageKeys]);
    return { pass: leaks.length === 0 && ev.every((e) => e.requestCorrelationSha256 === contentSha(marker) && e.correlationId !== marker && /^[0-9a-f-]{36}$/.test(e.correlationId) && e.tokens === null && e.tokenMeasurement === "not_applicable" && e.decision === "no_llm") &&
        ex.json.replay?.effects === "never_reexecute_tools" && !("source_snapshot" in ex.json) && !JSON.stringify(ex.json).includes('"tracks"'),
      actual: { leaks, correlationHashed: ev.every((e) => e.requestCorrelationSha256 === contentSha(marker)), keys: Object.keys(ex.json), eventKeys: Object.keys(ev[0] ?? {}), replayMode: ex.json.replay?.mode, snapshotIncluded: JSON.stringify(ex.json).includes('"tracks"') } };
  });

  await probe("S16", "Durable schema invariants under direct SQL: append-only events, immutable step identity, UUIDv7 ids, stop-reason/state coupling", "UPDATE/DELETE agent_events rejected; v4 run id rejected; terminal state without stop reason rejected; bogus stop reason rejected", async () => {
    const tryq = async (sql: string, p: unknown[] = []) => { try { await q(sql, p); return "ACCEPTED"; } catch (e) { return String((e as any).code ?? "error"); } };
    const ev = (await events(lifeRun))[0];
    const r: Record<string, string> = {
      updateEvent: await tryq("UPDATE agent_events SET event=event WHERE id=$1", [ev.id]),
      deleteEvent: await tryq("DELETE FROM agent_events WHERE id=$1", [ev.id]),
      v4Run: await tryq(`INSERT INTO agent_runs(id,project_id,actor_id,admission_key,correlation_id,request_correlation_sha256,created_at_ms,updated_at_ms,deadline_at_ms) VALUES($1,$2,$3,$4,$5,$4,1,1,2)`, [randomUUID(), P, owner.id, "a".repeat(64), uuid7()]),
      terminalNoReason: await tryq("UPDATE agent_runs SET state='Failed', stop_reason=NULL WHERE id=$1", [lifeRun]),
      bogusReason: await tryq("UPDATE agent_runs SET stop_reason='LLM_DONE' WHERE id=$1", [lifeRun]),
      completedWithReason: await tryq("UPDATE agent_runs SET state='Completed' WHERE id=$1", [lifeRun]),
    };
    const unchanged = (await run(lifeRun)).state === "Failed";
    return { pass: Object.values(r).every((v) => v !== "ACCEPTED") && unchanged, actual: { ...r, unchanged } };
  });

  await probe("S17", "Competing production workers + SIGKILL of a worker: every run reaches exactly one honest terminal state; no duplicate transitions; contiguous sequences", "20 runs with 2 workers (one SIGKILLed mid-batch, then restarted): 20 Failed/PLANNER_NOT_CONFIGURED, each exactly one Planning and one Failed transition, sequences 1..n", async () => {
    const net = JSON.parse(docker("inspect", "editagent-agent-worker"))[0].HostConfig.NetworkMode;
    docker("run", "-d", "--name", "qa77-worker2", "--network", net, "-e", "DATABASE_URL=postgresql://editagent:editagent-dev-password@postgres:5432/editagent", "-e", "REDIS_URL=redis://redis:6379/0", "editagent-agent-worker:local");
    const P4 = await newProject(owner, "QA77 workers");
    const ids: string[] = [];
    try {
      for (let batch = 0; batch < 3; batch++) {
        const r = await Promise.all(Array.from({ length: batch < 2 ? 8 : 4 }, () => call(owner, "POST", base(P4), { idempotencyKey: key() })));
        ids.push(...r.filter((x) => x.status === 201).map((x) => x.json.id));
        if (batch === 0) { await sleep(300); docker("kill", "-s", "KILL", "editagent-agent-worker"); }
        await until(async () => (await q("SELECT count(*)::int n FROM agent_runs WHERE project_id=$1 AND state NOT IN ('Completed','Failed','Cancelled')", [P4]))[0].n === 0, 120_000, "batch terminal", 500);
        if (batch === 0) worker.start();
      }
    } finally { docker("rm", "-f", "qa77-worker2"); }
    const rows = await q("SELECT id,state,stop_reason,sequence FROM agent_runs WHERE id=ANY($1::uuid[])", [ids]);
    const bad: string[] = [];
    for (const r of rows) {
      const ev = await events(r.id);
      const planning = ev.filter((e) => e.kind === "transition" && e.state === "Planning").length, failed = ev.filter((e) => e.state === "Failed").length;
      if (r.state !== "Failed" || r.stop_reason !== "PLANNER_NOT_CONFIGURED" || planning !== 1 || failed !== 1 || !contiguous(ev) || ev.length !== r.sequence) bad.push(`${r.id.slice(-6)}:${r.state}/${r.stop_reason}/p${planning}/f${failed}/n${ev.length}`);
    }
    const recovered = (await q("SELECT count(*)::int n FROM agent_events WHERE run_id=ANY($1::uuid[]) AND event->>'kind'='recovered'", [ids]))[0].n;
    return { pass: ids.length === 20 && rows.length === 20 && bad.length === 0, actual: { runs: ids.length, anomalies: bad, recoveredEvents: recovered } };
  });

  await probe("S18", "Project deletion: run reads become 404; a pending run is fenced as ACCESS_REVOKED by the worker (no work on a deleted project)", "DELETE project 2xx; GET run 404; worker settles pending run Failed/ACCESS_REVOKED", async () => {
    worker.stop();
    const P5 = await newProject(owner, "QA77 delete");
    const s = await call(owner, "POST", base(P5), { idempotencyKey: key() });
    const del = await call(owner, "DELETE", `/projects/${P5}`);
    const g = await call(owner, "GET", `${base(P5)}/${s.json.id}`);
    worker.start();
    const r = await settledRun(s.json.id, 60_000);
    return { pass: del.status < 300 && g.status === 404 && r.state === "Failed" && r.stop_reason === "ACCESS_REVOKED", actual: { delete: del.status, get: g.status, final: [r.state, r.stop_reason] } };
  });

  await probe("S19", "SSE bounded duration: an idle stream is closed by the server at ~120 s (client resumes from last id)", "stream ends normally between 115 and 135 s with all events delivered once", async () => {
    const ck = await cookieHeader(viewer);
    const r = await sse(ck, `${base(P)}/${lifeRun}/events`, { timeoutMs: 170_000 });
    const n = (await events(lifeRun)).length;
    return { pass: r.status === 200 && r.closed === "end" && r.ms > 115_000 && r.ms < 135_000 && r.events.length === n, actual: { closedBy: r.closed, ms: r.ms, events: r.events.length, heartbeats: r.comments } };
  });
  await pool.end();
});
