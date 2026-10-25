// PR #77 independent QA, part D: QA-authored driver over REAL PostgreSQL + the frozen build's ToolExecutor,
// Timeline and agent-core primitives (the production agent-worker is stopped while this runs, except D18).
// Exercises the guarded effect primitive the production planner does not reach yet. Nothing here is a product file.
import { createRequire } from "node:module";
import { fork, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";

const APP = process.env.QA_APP_ROOT, OUT = process.env.QA_OUT, PRIVATE = process.env.QA_PRIVATE;
const PG = "postgresql://editagent:editagent-dev-password@localhost:5432/editagent";
const req = createRequire(path.join(APP, "apps/api/package.json"));
const { Pool } = req("pg");
const AC = req("@editagent/agent-core");
const { PostgresAgentRuns, executeAgentTool, newAgentId, replayAgentCommands, publishAgentRun } = AC;
const { Timeline, applyCommand, parseCommand } = req("@editagent/domain");
const { PostgresToolAuditRepository, PostgresToolAuthority, ToolExecutor, ToolRegistry, registerEditingTools, contentHash, ToolError } = req("@editagent/tool-sdk");
const { BullMqJobQueue } = req("@editagent/job-queue");

const state = JSON.parse(readFileSync(path.join(PRIVATE, "state77.json"), "utf8"));
const pool = new Pool({ connectionString: PG, max: 10 });
const runs = new PostgresAgentRuns(pool);
const load = async (project, timeline) =>
  Timeline.restore((await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1 AND project_id=$2", [timeline, project])).rows[0].snapshot);
const authority = new PostgresToolAuthority(pool, load);
const executor = new ToolExecutor(registerEditingTools(new ToolRegistry(), authority), authority, new PostgresToolAuditRepository(pool, 1_000_000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const PD = state.PD, owner = state.owner, editor = state.editor;
const timelines = [...state.driverTimelines];
const nextTl = () => { const t = timelines.shift(); if (!t) throw new Error("fixture timelines exhausted"); return t; };

const RESULTS = path.join(OUT, "qa77-results.json");
const doc = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf8")) : { results: [] };
async function probe(id, title, expected, fn) {
  const start = Date.now();
  let r;
  try { const x = await fn(); r = { id, title, status: x.pass === null ? "NOT_RUN" : x.pass ? "PASS" : "FAIL", expected, actual: x.actual }; }
  catch (e) { r = { id, title, status: "ERROR", expected, actual: String(e?.stack ?? e).slice(0, 900) }; }
  doc.results.push({ ...r, ms: Date.now() - start, mode: "real-pg-driver" });
  doc.appSha = process.env.QA_APP_SHA; doc.generatedAt = new Date().toISOString();
  writeFileSync(RESULTS, JSON.stringify(doc, null, 2));
  console.log(`[QA77] ${id} ${r.status} ${title}`);
}
const err = async (p) => { try { await p; return "OK"; } catch (e) { return e?.code ?? e?.constructor?.name ?? "error"; } };
const run = async (id) => (await q("SELECT * FROM agent_runs WHERE id=$1", [id]))[0];
const steps = async (id) => q("SELECT * FROM agent_steps WHERE run_id=$1 ORDER BY ordinal", [id]);
const evs = async (id) => (await q("SELECT event FROM agent_events WHERE run_id=$1 ORDER BY sequence", [id])).map((r) => r.event);
const receiptsOf = async (id) => q("SELECT e.id,e.outcome FROM tool_executions e JOIN agent_steps s ON s.receipt_id=e.id WHERE s.run_id=$1", [id]);
const tlSha = async (tl) => (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [tl.id]))[0].state_sha256;
async function admit(tl, actor = owner) {
  return runs.start(actor, PD, { idempotencyKey: `qa77d-${randomUUID().replaceAll("-", "")}`, timelineId: tl.id, stateSha256: tl.sha }, "qa77-driver");
}
async function toExec(lease) { for (const s of ["Observing", "Planning", "Executing"]) await runs.move(lease, s); }
async function ctxFor(lease) {
  const view = await runs.workerView(lease), actor = await runs.workerActor(lease);
  const snap = (await load(view.projectId, view.source.timelineId)).toSnapshot();
  const clip = snap.tracks.find((t) => t.kind === "video").clips[0];
  return (k) => ({ name: "editing.trim-video", version: "1.0.0", callerId: actor, projectId: view.projectId, resource: { kind: "timeline", id: snap.id },
    input: { clipId: clip.id, startUs: String(200000 + k * 100000), endUs: String(7800000 - k * 100000) } });
}
const signal = () => new AbortController().signal;
async function exportAll(id, limit = 3, actor = owner) {
  const pages = []; let cursor;
  do { const p = await runs.export(actor, PD, id, cursor, limit); pages.push(p); cursor = p.nextCursor ?? undefined; } while (cursor && pages.length < 300);
  return pages;
}
function child(runId, mode) {
  const c = fork(path.join(path.dirname(new URL(import.meta.url).pathname), "d77child.mjs"), [], { env: { ...process.env, QA_RUN: runId, QA_MODE: mode, QA_PG: PG }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const first = new Promise((resolve) => c.once("message", resolve));
  return { c, first };
}
const kill = async (c) => { c.kill("SIGKILL"); await new Promise((r) => c.once("exit", r)); };
const waitLeaseExpiry = async (id) => { const r = await run(id); const left = r.lease_until ? new Date(r.lease_until).getTime() - Date.now() : 0; await sleep(Math.max(0, left) + 400); };
const invariant = (e) => e.every((x, i) => x.sequence === i + 1);
const worker = { start: () => execFileSync("docker", ["compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "agent-worker"], { cwd: APP, stdio: "ignore" }),
  stop: () => execFileSync("docker", ["compose", "stop", "-t", "5", "agent-worker"], { cwd: APP, stdio: "ignore" }) };

let d1 = null;
await probe("D1", "Happy path through the guarded primitive: 2 real trim tools -> Completed; receipts, checkpoints and canonical Timeline commit atomically", "Completed; 2 succeeded steps with distinct receipts; 2 succeeded tool_executions; DB timeline hash = last result hash; events contiguous with intent/result pairs; measured duration/cost recorded", async () => {
  const tl = nextTl(); const v = await admit(tl); const lease = await runs.claim(v.id, newAgentId()); await toExec(lease);
  const call = await ctxFor(lease);
  const ok = [await executeAgentTool(runs, lease, executor, call(0), signal()), await executeAgentTool(runs, lease, executor, call(1), signal())];
  await runs.move(lease, "Evaluating"); await runs.move(lease, "Completed");
  const r = await run(v.id), st = await steps(v.id), rc = await receiptsOf(v.id), e = await evs(v.id);
  d1 = { tl, id: v.id };
  const results = e.filter((x) => x.kind === "tool_result");
  // TL item 9: runtime passes `durationMs ?? 0`; the persisted/exported value must be the real receipt measurement.
  const measured = await q("SELECT id,(finished_at_ms-started_at_ms)::int AS d,cost_micros::bigint AS c,cost_basis FROM tool_executions WHERE id=ANY($1::uuid[])", [results.map((x) => x.tool.receiptId)]);
  const durationsFromReceipts = results.every((x) => { const m = measured.find((r) => r.id === x.tool.receiptId); return m && m.d === x.tool.durationMs && Number(m.c) === x.tool.costMicros; });
  return { pass: durationsFromReceipts && ok.every(Boolean) && r.state === "Completed" && st.length === 2 && st.every((s) => s.outcome === "succeeded") && new Set(st.map((s) => s.receipt_id)).size === 2 &&
      rc.length === 2 && rc.every((x) => x.outcome === "succeeded") && (await tlSha(tl)) === st[1].result_sha256 && st[1].basis_sha256 === st[0].result_sha256 && st[0].basis_sha256 === tl.sha && invariant(e) &&
      e.filter((x) => x.kind === "tool_intent").length === 2 && results.every((x) => Number.isInteger(x.tool.durationMs) && Number.isInteger(x.tool.costMicros)),
    actual: { state: r.state, steps: st.map((s) => s.outcome), receipts: rc.map((x) => x.outcome), kinds: e.map((x) => x.kind), toolResults: results.map((x) => ({ d: x.tool.durationMs, c: x.tool.costMicros })), receiptMeasurements: measured.map((m) => ({ d: m.d, c: Number(m.c), basis: m.cost_basis })), durationsFromReceipts } };
});

await probe("D2", "Offline replay of the paged export from the authorized original snapshot reproduces the committed Timeline and never executes tools", "replay(original, all pages limit=3) hash = DB timeline hash; tool_executions count and timeline rows unchanged by replay", async () => {
  const pages = await exportAll(d1.id, 3);
  const before = (await q("SELECT count(*)::int n FROM tool_executions"))[0].n, beforeTl = await tlSha(d1.tl);
  const out = replayAgentCommands(d1.tl.snapshot, pages);
  const after = (await q("SELECT count(*)::int n FROM tool_executions"))[0].n;
  d1.pages = pages;
  return { pass: contentHash(out.toSnapshot()) === (await tlSha(d1.tl)) && before === after && beforeTl === (await tlSha(d1.tl)) && contentHash(d1.tl.snapshot) === d1.tl.sha,
    actual: { pages: pages.length, replayHash: contentHash(out.toSnapshot()).slice(0, 12), dbHash: (await tlSha(d1.tl)).slice(0, 12), toolExecutionsBefore: before, after } };
});

await probe("D3", "Replay rejects tampered / incomplete / reordered / cross-run / wrong-original inputs; reports whether hash-recomputed tampering is detectable", "every structural or hash-inconsistent tamper rejected; recomputed-hash tamper result recorded (exports are unsigned)", async () => {
  const P = d1.pages, clone = () => JSON.parse(JSON.stringify(P));
  const other = timelines[0];
  const cmdPage = P.findIndex((p) => p.replay.commands.length > 0);
  const attempts = {
    wrongOriginal: () => replayAgentCommands(other.snapshot, P),
    reversed: () => replayAgentCommands(d1.tl.snapshot, [...P].reverse()),
    missingMiddle: () => replayAgentCommands(d1.tl.snapshot, P.filter((_, i) => i !== 1)),
    missingLast: () => replayAgentCommands(d1.tl.snapshot, P.slice(0, -1)),
    duplicatePage: () => replayAgentCommands(d1.tl.snapshot, [P[0], ...P]),
    empty: () => replayAgentCommands(d1.tl.snapshot, []),
    tamperedCoordinates: () => { const c = clone(); const cmd = c[cmdPage].replay.commands[0].commands[0]; cmd.payload.endUs = String(Number(cmd.payload.endUs) - 40000); return replayAgentCommands(d1.tl.snapshot, c); },
    tamperedResultHash: () => { const c = clone(); c[cmdPage].replay.commands[0].resultSha256 = "0".repeat(64); return replayAgentCommands(d1.tl.snapshot, c); },
    tamperedSequence: () => { const c = clone(); c[0].events[0].sequence = 2; return replayAgentCommands(d1.tl.snapshot, c); },
    droppedCommand: () => { const c = clone(); c[cmdPage].replay.commands = []; return replayAgentCommands(d1.tl.snapshot, c); },
    throughMismatch: () => { const c = clone(); c[1].throughSequence += 1; return replayAgentCommands(d1.tl.snapshot, c); },
    sourceSwap: () => { const c = clone(); c.forEach((p) => (p.run.source.stateSha256 = other.sha)); return replayAgentCommands(d1.tl.snapshot, c); },
    crossRunPage: () => { const c = clone(); c[1].run.id = newAgentId(); return replayAgentCommands(d1.tl.snapshot, c); },
  };
  const res = {};
  for (const [k, f] of Object.entries(attempts)) { try { f(); res[k] = "ACCEPTED"; } catch (e) { res[k] = e?.code ?? "rejected"; } }
  // Tamper that ALSO recomputes every downstream hash (attacker with the original snapshot). Exports are not signed.
  let recomputed;
  try {
    const c = clone(); let tl = Timeline.restore(d1.tl.snapshot);
    for (const page of c) for (const rc of page.replay.commands) {
      rc.basisSha256 = contentHash(tl.toSnapshot());
      for (const raw of rc.commands) { raw.payload.endUs = String(Number(raw.payload.endUs) - 40000); tl = applyCommand(tl, parseCommand(raw)).timeline; }
      rc.resultSha256 = contentHash(tl.toSnapshot());
    }
    replayAgentCommands(d1.tl.snapshot, c); recomputed = "ACCEPTED (self-consistent forgery not detectable offline)";
  } catch (e) { recomputed = `rejected:${e?.code ?? e?.message}`; }
  const structural = Object.values(res).every((v) => v !== "ACCEPTED");
  return { pass: structural, actual: { ...res, hashRecomputedTamper: recomputed } };
});

await probe("D4", "SIGKILL after a successful checkpoint: lease expires, a new owner resumes at the next ordinal; the completed effect is never re-executed", "child killed after checkpoint 1; claim before expiry -> null; after expiry generation+1 resumes at ordinal 1; 2 receipts total; final timeline = replay of both commands", async () => {
  const tl = nextTl(); const v = await admit(tl);
  const { c, first } = child(v.id, "checkpoint"); const m = await first; await kill(c);
  const early = await runs.claim(v.id, newAgentId());
  await waitLeaseExpiry(v.id);
  const lease = await runs.claim(v.id, newAgentId());
  const mid = await run(v.id);
  const call = await ctxFor(lease);
  const ok = await executeAgentTool(runs, lease, executor, call(1), signal());
  await runs.move(lease, "Evaluating"); await runs.move(lease, "Completed");
  const st = await steps(v.id), rc = await receiptsOf(v.id), pages = await exportAll(v.id, 4);
  const replayed = contentHash(replayAgentCommands(tl.snapshot, pages).toSnapshot());
  return { pass: m.phase === "checkpoint" && early === null && mid.checkpoint === 1 && lease.generation === m.lease.generation + 1 && ok && st.length === 2 && rc.length === 2 && replayed === (await tlSha(tl)) && (await run(v.id)).state === "Completed" && invariant(await evs(v.id)),
    actual: { childPhase: m.phase, earlyClaim: early, resumedCheckpoint: mid.checkpoint, generations: [m.lease.generation, lease.generation], steps: st.map((s) => s.outcome), receipts: rc.length, replayMatchesDb: replayed === (await tlSha(tl)) } };
});

await probe("D5", "SIGKILL after the ToolExecutor receipt succeeded but BEFORE the checkpoint commit: outcome unknown -> fail closed, no guessed effect, no re-execution", "after expiry: beginStep returns null; run Failed/EXECUTION_UNCONFIRMED; step 'unconfirmed'; timeline unchanged; exactly 1 tool_executions row; exported unknowns recorded", async () => {
  const tl = nextTl(); const v = await admit(tl);
  const { c, first } = child(v.id, "unconfirmed"); const m = await first; await kill(c);
  await waitLeaseExpiry(v.id);
  const lease = await runs.claim(v.id, newAgentId());
  const call = await ctxFor(lease);
  const again = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
  const r = await run(v.id), st = await steps(v.id), rc = await receiptsOf(v.id), e = await evs(v.id);
  const res = e.filter((x) => x.kind === "tool_result").at(-1)?.tool;
  return { pass: m.phase === "admitted_without_checkpoint" && again === null && r.state === "Failed" && r.stop_reason === "EXECUTION_UNCONFIRMED" && st.length === 1 && st[0].outcome === "unconfirmed" && rc.length === 1 && (await tlSha(tl)) === tl.sha && res?.outputSha256 === null,
    actual: { childPhase: m.phase, final: [r.state, r.stop_reason], step: st.map((s) => s.outcome), receipts: rc.map((x) => x.outcome), timelineUnchanged: (await tlSha(tl)) === tl.sha, exportedUnconfirmed: res } };
});

await probe("D6", "SIGKILL after the tool intent but before tool admission: no receipt exists, unknown is explicit (null timing/cost), fail closed", "run Failed/EXECUTION_UNCONFIRMED; 0 tool_executions; step unconfirmed with duration/cost/output null", async () => {
  const tl = nextTl(); const v = await admit(tl);
  const { c, first } = child(v.id, "intent"); const m = await first; await kill(c);
  await waitLeaseExpiry(v.id);
  const lease = await runs.claim(v.id, newAgentId());
  const call = await ctxFor(lease);
  const again = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
  const r = await run(v.id), st = await steps(v.id), rc = await receiptsOf(v.id);
  const res = (await evs(v.id)).filter((x) => x.kind === "tool_result").at(-1)?.tool;
  return { pass: m.phase === "intent" && again === null && r.stop_reason === "EXECUTION_UNCONFIRMED" && rc.length === 0 && st[0].outcome === "unconfirmed" && res?.durationMs === null && res?.costMicros === null && res?.outputSha256 === null && (await tlSha(tl)) === tl.sha,
    actual: { final: [r.state, r.stop_reason], receipts: rc.length, step: st[0].outcome, exported: res } };
});

await probe("D7", "Cancellation races at work start, after tool intent, after SDK receipt, and while the checkpoint commit is waiting on a lock", "work-start: worker move fenced; after intent: ToolExecutor admission fenced by trigger (no receipt); after receipt: checkpoint fenced, timeline unchanged; during lock wait: serialised (effect committed first, then Cancelled) with consistent events", async () => {
  const out = {};
  { const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId());
    await runs.cancel(owner, PD, v.id); out.workStart = { move: await err(runs.move(lease, "Observing")), state: (await run(v.id)).state }; }
  { const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
    const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
    await runs.cancel(owner, PD, v.id);
    out.afterIntent = { tool: await err(executor.executeWithIdentity(step.receiptId, call(0))), receipts: (await receiptsOf(v.id)).map((x) => x.outcome), step: (await steps(v.id))[0].outcome, timelineUnchanged: (await tlSha(tl)) === tl.sha }; }
  { const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
    const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
    const result = await executor.executeWithIdentity(step.receiptId, call(0));
    await runs.cancel(owner, PD, v.id);
    out.afterReceipt = { finish: await err(runs.finishStep(lease, step, { output: result.output, commands: result.commands, durationMs: 0, costMicros: 0 })), step: (await steps(v.id))[0].outcome, timelineUnchanged: (await tlSha(tl)) === tl.sha, state: (await run(v.id)).state }; }
  { const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
    const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
    const result = await executor.executeWithIdentity(step.receiptId, call(0));
    const blocker = await pool.connect(); await blocker.query("BEGIN"); await blocker.query("SELECT 1 FROM editing_timelines WHERE id=$1 FOR UPDATE", [tl.id]);
    const finishing = err(runs.finishStep(lease, step, { output: result.output, commands: result.commands, durationMs: 0, costMicros: 0 }));
    await sleep(700); const cancelling = err(runs.cancel(owner, PD, v.id)); await sleep(700);
    await blocker.query("ROLLBACK"); blocker.release();
    const [f, cn] = await Promise.all([finishing, cancelling]);
    const e = await evs(v.id);
    out.duringLockWait = { finish: f, cancel: cn, state: (await run(v.id)).state, step: (await steps(v.id))[0].outcome, timelineAdvanced: (await tlSha(tl)) === (await steps(v.id))[0].result_sha256, tail: e.slice(-2).map((x) => `${x.kind}:${x.state}`), contiguous: invariant(e) }; }
  const p = out.workStart.move !== "OK" && out.workStart.state === "Cancelled" && out.afterIntent.tool !== "OK" && out.afterIntent.receipts.every((o) => o !== "succeeded") && out.afterIntent.timelineUnchanged &&
    out.afterReceipt.finish !== "OK" && out.afterReceipt.timelineUnchanged && out.afterReceipt.step === "unconfirmed" && out.afterReceipt.state === "Cancelled" &&
    out.duringLockWait.finish === "OK" && out.duringLockWait.cancel === "OK" && out.duringLockWait.state === "Cancelled" && out.duringLockWait.timelineAdvanced && out.duringLockWait.contiguous;
  return { pass: p, actual: out };
});

await probe("D8", "Lost lease / stale worker: a resumed owner fences every late write of the old owner; no double effect", "old owner's beginStep/finishStep/move rejected after takeover; new owner fails closed on the old unconfirmed intent; exactly one receipt; timeline unchanged", async () => {
  const tl = nextTl(), v = await admit(tl), l1 = await runs.claim(v.id, newAgentId()); await toExec(l1); const call = await ctxFor(l1);
  const step = await runs.beginStep(l1, "editing.trim-video", "1.0.0", call(0).input);
  const result = await executor.executeWithIdentity(step.receiptId, call(0));
  await waitLeaseExpiry(v.id);
  const l2 = await runs.claim(v.id, newAgentId());
  const late = { finish: await err(runs.finishStep(l1, step, { output: result.output, commands: result.commands, durationMs: 0, costMicros: 0 })), move: await err(runs.move(l1, "Evaluating")), begin: await err(runs.beginStep(l1, "editing.trim-video", "1.0.0", call(1).input)), renew: await err(runs.renew(l1)) };
  const resumed = await runs.beginStep(l2, "editing.trim-video", "1.0.0", call(1).input);
  // Second variant: stale owner with NO intent; new owner proceeds and completes once.
  const tl2 = nextTl(), w = await admit(tl2), a = await runs.claim(w.id, newAgentId()); await toExec(a); const call2 = await ctxFor(a);
  await waitLeaseExpiry(w.id);
  const b = await runs.claim(w.id, newAgentId());
  const lateBegin = await err(runs.beginStep(a, "editing.trim-video", "1.0.0", call2(0).input));
  const okB = await executeAgentTool(runs, b, executor, call2(0), signal());
  return { pass: Object.values(late).every((x) => x !== "OK") && resumed === null && (await run(v.id)).stop_reason === "EXECUTION_UNCONFIRMED" && (await receiptsOf(v.id)).length === 1 && (await tlSha(tl)) === tl.sha &&
      lateBegin !== "OK" && okB && (await receiptsOf(w.id)).length === 1,
    actual: { late, resumedBegin: resumed, final: (await run(v.id)).stop_reason, receipts: (await receiptsOf(v.id)).length, variant2: { lateBegin, newOwner: okB, receipts: (await receiptsOf(w.id)).length } } };
});

await probe("D9", "Deferred commit fence: lease expiry while the checkpoint transaction waits on a lock rolls back the whole effect (deadline variant too)", "finishStep blocked >5 s on an event-sequence lock then fails at COMMIT; timeline, step and run sequence unchanged; with deadline expiring during the wait the same; later claim -> DEADLINE_EXCEEDED", async () => {
  const out = {};
  for (const variant of ["lease", "deadline"]) {
    const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
    const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
    const result = await executor.executeWithIdentity(step.receiptId, call(0));
    await runs.renew(lease);
    if (variant === "deadline") await q("UPDATE agent_runs SET deadline_at_ms=(extract(epoch FROM clock_timestamp())*1000)::bigint+2500 WHERE id=$1", [v.id]);
    const before = await run(v.id);
    // QA fault injection: an uncommitted row holding the next (run_id, sequence) key blocks the checkpoint's event insert.
    const blocker = await pool.connect();
    await blocker.query("SET session_replication_role = replica"); await blocker.query("BEGIN");
    const id = newAgentId(), seq = before.sequence + 1;
    await blocker.query("INSERT INTO agent_events(id,run_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)", [id, v.id, seq, JSON.stringify({ id, runId: v.id, sequence: seq })]);
    const finishing = err(runs.finishStep(lease, step, { output: result.output, commands: result.commands, durationMs: 0, costMicros: 0 }));
    await sleep(variant === "lease" ? 6500 : 3500);
    await blocker.query("ROLLBACK"); await blocker.query("SET session_replication_role = origin"); blocker.release();
    const f = await finishing;
    const after = await run(v.id);
    out[variant] = { finish: f, timelineUnchanged: (await tlSha(tl)) === tl.sha, step: (await steps(v.id))[0].outcome, sequenceUnchanged: after.sequence === before.sequence, checkpoint: after.checkpoint };
    if (variant === "deadline") { await runs.claim(v.id, newAgentId()); out.deadline.claimAfter = [(await run(v.id)).state, (await run(v.id)).stop_reason, (await steps(v.id))[0].outcome]; }
  }
  return { pass: ["lease", "deadline"].every((k) => out[k].finish !== "OK" && out[k].timelineUnchanged && out[k].sequenceUnchanged && out[k].checkpoint === 0) && out.deadline.claimAfter[1] === "DEADLINE_EXCEEDED", actual: out };
});

await probe("D10", "Actor revocation and project deletion fences (before tool admission, after receipt, and at claim)", "revoked before admission: ToolExecutor trigger rejects (no receipt); revoked after receipt: checkpoint fenced, timeline unchanged; next claim -> ACCESS_REVOKED; deleted project -> ACCESS_REVOKED", async () => {
  const out = {};
  { const tl = nextTl(), v = await admit(tl, editor), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
    const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
    await q("UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2", [PD, editor]);
    out.beforeAdmission = { tool: await err(executor.executeWithIdentity(step.receiptId, call(0))), receipts: (await receiptsOf(v.id)).filter((x) => x.outcome === "succeeded").length };
    await waitLeaseExpiry(v.id); await runs.claim(v.id, newAgentId());
    out.beforeAdmission.claim = [(await run(v.id)).state, (await run(v.id)).stop_reason, (await steps(v.id))[0].outcome];
    await q("UPDATE project_memberships SET role='editor' WHERE project_id=$1 AND user_id=$2", [PD, editor]); }
  { const tl = nextTl(), v = await admit(tl, editor), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
    const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
    const result = await executor.executeWithIdentity(step.receiptId, call(0));
    await q("UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2", [PD, editor]);
    out.afterReceipt = { finish: await err(runs.finishStep(lease, step, { output: result.output, commands: result.commands, durationMs: 0, costMicros: 0 })), timelineUnchanged: (await tlSha(tl)) === tl.sha };
    await q("UPDATE project_memberships SET role='editor' WHERE project_id=$1 AND user_id=$2", [PD, editor]); }
  { // deleted project: separate throwaway project row cloned from PD membership is not available; use a fresh project via SQL
    const P = newAgentId(), now = Date.now();
    await q("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'QA77 deleted',$2,$2)", [P, now]);
    await q("INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',$3)", [P, owner, now]);
    const v = await runs.start(owner, P, { idempotencyKey: `qa77d-${randomUUID().replaceAll("-", "")}` }, "qa77");
    await q("UPDATE projects SET deleted_at=$2, updated_at=$2, revision=revision+1 WHERE id=$1", [P, now + 1]).catch(async () => q("UPDATE projects SET deleted_at=now() WHERE id=$1", [P]));
    const l = await runs.claim(v.id, newAgentId());
    out.deletedProject = { lease: l, final: [(await run(v.id)).state, (await run(v.id)).stop_reason] }; }
  return { pass: out.beforeAdmission.tool !== "OK" && out.beforeAdmission.receipts === 0 && out.beforeAdmission.claim[1] === "ACCESS_REVOKED" && out.afterReceipt.finish !== "OK" && out.afterReceipt.timelineUnchanged &&
      out.deletedProject.lease === null && out.deletedProject.final[1] === "ACCESS_REVOKED", actual: out };
});

await probe("D11", "Stale source: an external Timeline change between steps fails closed with STALE_SOURCE and no tool execution", "after step 1, an external valid trim commits; beginStep returns null; run Failed/STALE_SOURCE; tool_executions unchanged (1)", async () => {
  const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
  await executeAgentTool(runs, lease, executor, call(0), signal());
  const cur = (await q("SELECT snapshot FROM editing_timelines WHERE id=$1", [tl.id]))[0].snapshot;
  const t = Timeline.restore(cur), clip = cur.tracks.find((x) => x.kind === "video").clips[0];
  const s0 = Number(clip.timelineStartUs), e0 = s0 + Number(clip.outPoint) - Number(clip.inPoint);
  const cmd = parseCommand({ schemaVersion: 1, id: newAgentId(), timelineId: tl.id, type: "TrimClip", payload: { clipId: clip.id, startUs: String(s0 + 50000), endUs: String(e0) } });
  const changed = applyCommand(t, cmd).timeline.toSnapshot();
  await q("UPDATE editing_timelines SET snapshot=$2::jsonb, state_sha256=$3 WHERE id=$1", [tl.id, JSON.stringify(changed), contentHash(changed)]);
  const before = (await receiptsOf(v.id)).length;
  const r = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(1).input);
  return { pass: r === null && (await run(v.id)).stop_reason === "STALE_SOURCE" && (await receiptsOf(v.id)).length === before, actual: { begin: r, final: (await run(v.id)).stop_reason, receipts: [before, (await receiptsOf(v.id)).length] } };
});

await probe("D12", "ToolExecutor stable identity is admitted once: duplicate identity (same or different input, same or fresh executor) never re-executes", "second executeWithIdentity with same receipt id rejected; fresh executor rejected; exactly one tool_executions row", async () => {
  const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
  const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
  const a = await err(executor.executeWithIdentity(step.receiptId, call(0)));
  const b = await err(executor.executeWithIdentity(step.receiptId, call(0)));
  const fresh = new ToolExecutor(registerEditingTools(new ToolRegistry(), authority), authority, new PostgresToolAuditRepository(pool, 1_000_000));
  const c = await err(fresh.executeWithIdentity(step.receiptId, call(1)));
  const d = await err(executor.executeWithIdentity("not-a-uuid", call(0)));
  const rows = (await q("SELECT count(*)::int n FROM tool_executions WHERE id=$1", [step.receiptId]))[0].n;
  return { pass: a === "OK" && b !== "OK" && c !== "OK" && d !== "OK" && rows === 1, actual: { first: a, sameAgain: b, freshExecutorDifferentInput: c, malformedId: d, rows } };
});

await probe("D13", "Tool failure path: an invalid trim fails honestly (TOOL_FAILED) with the receipt's failed outcome; unknowns are never fabricated zeros", "executeAgentTool returns false; run Failed/TOOL_FAILED; step outcome failed; exported tool_result outputSha256 null; timeline unchanged", async () => {
  const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease); const call = await ctxFor(lease);
  const bad = call(0); bad.input = { ...bad.input, startUs: "7900000", endUs: "100" };
  const ok = await executeAgentTool(runs, lease, executor, bad, signal());
  const r = await run(v.id), st = await steps(v.id), res = (await evs(v.id)).filter((x) => x.kind === "tool_result").at(-1)?.tool;
  return { pass: ok === false && r.stop_reason === "TOOL_FAILED" && (await tlSha(tl)) === tl.sha && res?.outputSha256 === null, actual: { returned: ok, final: [r.state, r.stop_reason], step: st.map((s) => s.outcome), exported: res, receipts: (await receiptsOf(v.id)).map((x) => x.outcome) } };
});

await probe("D14", "Step limit: 64 tool steps commit, the 65th is refused with STEP_LIMIT; event log stays bounded and contiguous", "64 succeeded steps, 65th beginStep -> null, Failed/STEP_LIMIT, sequence <= 256, contiguous", async () => {
  const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease);
  const view = await runs.workerView(lease), actor = await runs.workerActor(lease);
  const snap = (await load(view.projectId, view.source.timelineId)).toSnapshot(), clip = snap.tracks.find((t) => t.kind === "video").clips[0];
  const c = (k) => ({ name: "editing.trim-video", version: "1.0.0", callerId: actor, projectId: view.projectId, resource: { kind: "timeline", id: snap.id }, input: { clipId: clip.id, startUs: String(100000 + k * 20000), endUs: String(7900000 - k * 20000) } });
  let ok = 0;
  for (let k = 0; k < 64; k++) { if (await executeAgentTool(runs, lease, executor, c(k), signal())) ok++; else break; }
  const extra = await runs.beginStep(lease, "editing.trim-video", "1.0.0", c(64).input);
  const r = await run(v.id), e = await evs(v.id);
  return { pass: ok === 64 && extra === null && r.stop_reason === "STEP_LIMIT" && r.sequence <= 256 && invariant(e) && r.checkpoint === 64, actual: { succeeded: ok, extra, final: [r.state, r.stop_reason], sequence: r.sequence, checkpoint: r.checkpoint } };
});

await probe("D15", "Audit/event ordering under contention: concurrent cancel, renew, move and readers on one run never duplicate or reorder sequences", "20 concurrent renew/workerView/audit/events + 1 cancel: run terminal Cancelled exactly once, sequences contiguous, revisions strictly increasing", async () => {
  const tl = nextTl(), v = await admit(tl), lease = await runs.claim(v.id, newAgentId()); await toExec(lease);
  const ops = [];
  for (let i = 0; i < 20; i++) ops.push(err(i % 4 === 0 ? runs.renew(lease) : i % 4 === 1 ? runs.audit(owner, PD, v.id, undefined, 100) : i % 4 === 2 ? runs.events(owner, PD, v.id) : runs.workerView(lease)));
  ops.push(err(runs.cancel(owner, PD, v.id))); ops.push(err(runs.cancel(editor, PD, v.id)));
  await Promise.all(ops);
  const e = await evs(v.id);
  const cancels = e.filter((x) => x.state === "Cancelled").length;
  const revisions = e.map((x) => x.revision), strictly = revisions.every((x, i) => i === 0 || x > revisions[i - 1]);
  return { pass: invariant(e) && cancels === 1 && strictly && (await run(v.id)).state === "Cancelled", actual: { events: e.length, cancels, revisionsStrictlyIncreasing: strictly } };
});

await probe("D16", "Global durable-log invariant over every AgentRun created in this QA session", "for every run: events 1..sequence contiguous, JSON id/runId/sequence match columns, terminal iff stop reason, no event after a terminal transition", async () => {
  const rows = await q("SELECT id,state,stop_reason,sequence FROM agent_runs");
  const bad = [];
  for (const r of rows) {
    const e = await q("SELECT id,sequence,event FROM agent_events WHERE run_id=$1 ORDER BY sequence", [r.id]);
    if (e.length !== r.sequence || !e.every((x, i) => x.sequence === i + 1 && x.event.id === x.id && x.event.runId === r.id && x.event.sequence === x.sequence)) bad.push(`${r.id}:sequence`);
    const termIdx = e.findIndex((x) => ["Completed", "Failed", "Cancelled"].includes(x.event.state));
    if (termIdx >= 0 && termIdx !== e.length - 1) bad.push(`${r.id}:event_after_terminal`);
  }
  return { pass: bad.length === 0 && rows.length > 0, actual: { runs: rows.length, anomalies: bad.slice(0, 10) } };
});

await probe("D17", "Broker duplicate delivery: the same run published repeatedly to real BullMQ is processed once by the production worker", "3x publishAgentRun + duplicate enqueue while worker stopped; worker started; run Failed/PLANNER_NOT_CONFIGURED with exactly one Planning transition", async () => {
  const queue = new BullMqJobQueue("redis://localhost:6379/0");
  const v = await runs.start(owner, PD, { idempotencyKey: `qa77d-${randomUUID().replaceAll("-", "")}` }, "qa77");
  try { for (let i = 0; i < 3; i++) await publishAgentRun(runs, queue, v.id); } finally { await queue.close(true).catch(() => undefined); }
  worker.start();
  const end = Date.now() + 60_000; let r;
  while (Date.now() < end) { r = await run(v.id); if (["Completed", "Failed", "Cancelled"].includes(r.state)) break; await sleep(300); }
  const e = await evs(v.id);
  return { pass: r.stop_reason === "PLANNER_NOT_CONFIGURED" && e.filter((x) => x.state === "Planning" && x.kind === "transition").length === 1 && invariant(e), actual: { final: [r.state, r.stop_reason], planningTransitions: e.filter((x) => x.state === "Planning" && x.kind === "transition").length, events: e.length } };
});

await probe("D18", "Production worker recovers an unconfirmed tool outcome left by a SIGKILLed driver: fails closed EXECUTION_UNCONFIRMED, never re-executes", "child killed after receipt success; production agent-worker settles run Failed/EXECUTION_UNCONFIRMED; 1 receipt; timeline unchanged", async () => {
  worker.stop();
  const tl = nextTl(); const v = await admit(tl);
  const { c, first } = child(v.id, "unconfirmed"); const m = await first; await kill(c);
  worker.start();
  const end = Date.now() + 90_000; let r;
  while (Date.now() < end) { r = await run(v.id); if (["Completed", "Failed", "Cancelled"].includes(r.state)) break; await sleep(500); }
  return { pass: m.phase === "admitted_without_checkpoint" && r.stop_reason === "EXECUTION_UNCONFIRMED" && (await receiptsOf(v.id)).length === 1 && (await tlSha(tl)) === tl.sha && (await steps(v.id))[0].outcome === "unconfirmed",
    actual: { final: [r.state, r.stop_reason], receipts: (await receiptsOf(v.id)).length, timelineUnchanged: (await tlSha(tl)) === tl.sha, step: (await steps(v.id))[0].outcome } };
});

await pool.end();
process.exit(0);
