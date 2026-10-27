/** PR #88 independent QA, upgrade part 2: frozen head on the same volumes after an atomic failed-then-successful 0023.
 * Historical bytes, 1.0/1.1 coexistence, the pooled-connection fence under forced generic plans, and agent-write fences. */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { APP, PRIVATE, OUT, WEB, call, pool, probe, q, until, setMembership, type User } from "./helpers88";

const terminal = (s: string) => ["Completed", "Failed", "Cancelled"].includes(s);
test("PR88 upgrade part 2: migrated head", async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  const s = JSON.parse(readFileSync(path.join(PRIVATE, "upgrade88.json"), "utf8"));
  const failed = JSON.parse(readFileSync(path.join(PRIVATE, "failed-migration88.json"), "utf8"));
  const signIn = async (who: { email: string; password: string }) => {
    const ctx = await browser.newContext({ baseURL: WEB }); const page = await ctx.newPage();
    await page.goto("/sign-in"); await page.getByLabel("Email", { exact: true }).fill(who.email); await page.getByLabel("Password", { exact: true }).fill(who.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    const id = (await q("SELECT id FROM users WHERE lower(email)=lower($1)", [who.email]))[0].id;
    return { ctx, page, email: who.email, password: who.password, id } as User;
  };
  const owner = await signIn(s.owner), viewer = await signIn(s.viewer);
  const L: any = await import(path.join(process.env.QA_DIR!, "lib88.mjs"));
  const X = L.load(APP), { AC, SDK, SCHEMAS } = X;
  const permit = L.permitFor(AC), C = L.composition(X, pool, permit);

  await probe("M01", "Failed 0023 is atomic: a conflicting pre-existing object keeps the head API down and leaves no partial 0023 schema", "API not ready; no 0023 migration row; no runtime_driver/planning columns; no render_output_validations; base Timeline/runs untouched", async () => ({
    pass: failed.apiReady === false && failed.has0023 === false && failed.columns === 0 && failed.renderValidations === null && failed.timelineSha === s.sha && failed.runs === s.counts.r, actual: failed,
  }));
  await probe("M02", "After removing the conflict 0023 applies once, additively, on populated data", "exactly one 0023 row; all pre-existing runs runtime_driver=infrastructure-v1, planning_stop_reason null, tool_attempts 0; row counts unchanged; new tables/triggers present", async () => {
    const mig = (await q("SELECT id FROM schema_migrations WHERE id LIKE '0023%'")).length;
    const old = await q("SELECT runtime_driver,planning_stop_reason,tool_attempts FROM agent_runs WHERE id=ANY($1::uuid[])", [s.runs]);
    const counts = (await q(`SELECT (SELECT count(*) FROM users)::int u,(SELECT count(*) FROM projects)::int p,(SELECT count(*) FROM media_assets)::int m,(SELECT count(*) FROM editing_timelines)::int t,(SELECT count(*) FROM tool_executions)::int x,(SELECT count(*) FROM agent_runs)::int r,(SELECT count(*) FROM agent_events)::int e`))[0];
    const objs = (await q("SELECT to_regclass('agent_loop_sessions') a,to_regclass('agent_model_calls') b,to_regclass('render_output_validations') c"))[0];
    const trig = (await q("SELECT tgname FROM pg_trigger WHERE tgname IN ('agent_loop_identity','agent_model_identity','render_validation_immutable')")).length;
    return { pass: mig === 1 && old.length === 2 && old.every((r: any) => r.runtime_driver === "infrastructure-v1" && r.planning_stop_reason === null && r.tool_attempts === 0) && ["u", "p", "m", "t", "x", "r", "e"].every((k) => counts[k] === s.counts[k]) && objs.a && objs.b && objs.c && trig === 3,
      actual: { migrationRows: mig, oldRuns: old, countsUnchanged: ["u", "p", "m", "t", "x", "r", "e"].every((k) => counts[k] === s.counts[k]), tables: objs, triggers: trig } };
  });
  await probe("M03", "Historical AgentRun/Event/Audit/Export 1.0 records are byte-for-byte unchanged (incl. decision=no_llm)", "agent_events md5 per row identical; agent_runs original columns identical; API run/audit/export JSON deep-equal to pre-upgrade; schemaVersion 1.0.0", async () => {
    const ev = await q("SELECT id,run_id,sequence,md5(event::text) h,octet_length(event::text) n FROM agent_events WHERE run_id=ANY($1::uuid[]) ORDER BY run_id,sequence", [s.runs]);
    const evSame = JSON.stringify(ev) === JSON.stringify(s.events.filter((e: any) => s.runs.includes(e.run_id)));
    const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name='agent_runs' AND column_name NOT IN ('runtime_driver','planning_stop_reason','tool_attempts') ORDER BY ordinal_position")).map((r: any) => r.column_name);
    const rows = await q(`SELECT id,md5(row_to_json(x)::text) h FROM (SELECT ${cols.map((c: string) => `r.${c}`).join(",")} FROM agent_runs r) x ORDER BY id`);
    const rowsSame = JSON.stringify(rows.filter((r: any) => s.runs.includes(r.id))) === JSON.stringify(s.runRows.filter((r: any) => s.runs.includes(r.id)));
    const api: Record<string, boolean> = {};
    for (const id of s.runs) {
      const pages: any[] = []; let cursor: string | null = null;
      do { const e = await call(owner, "GET", `/projects/${s.P}/agent-runs/${id}/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`); pages.push(e.json); cursor = e.json?.nextCursor ?? null; } while (cursor);
      const run = (await call(owner, "GET", `/projects/${s.P}/agent-runs/${id}`)).json, audit = (await call(viewer, "GET", `/projects/${s.P}/agent-runs/${id}/audit`)).json;
      api[id] = JSON.stringify({ run, audit, export: pages }) === JSON.stringify(s.views[id]) && run.schemaVersion === "1.0.0" && pages.every((p: any) => p.events.every((e: any) => e.decision === "no_llm" && e.schemaVersion === "1.0.0"));
    }
    return { pass: evSame && rowsSame && Object.values(api).every(Boolean), actual: { eventsIdentical: evSame, events: ev.length, runRowsIdentical: rowsSame, apiViewsIdentical: api } };
  });
  const compose = (...a: string[]) => execFileSync("docker", ["compose", "-f", path.join(APP, "compose.yaml"), ...a], { cwd: APP, encoding: "utf8", timeout: 300_000 });
  const k = () => `qa88h-${randomUUID().replaceAll("-", "")}`;
  const ownerRow = (await q("SELECT user_id FROM project_memberships WHERE project_id=$1 AND role='owner'", [s.P]))[0].user_id;
  await probe("M04", "1.0 and additive 1.1 coexist on the migrated database, on a pre-existing Timeline", "routine run (production worker) -> 1.0.0 PLANNER_NOT_CONFIGURED; controlled run (isolated permit, QA-scripted model, refusing render stub) -> 1.1.0 records schema-valid with typed planning stop; historical runs still 1.0.0", async () => {
    const t0 = (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [s.timeline]))[0].state_sha256;
    const routine = await call(owner, "POST", `/projects/${s.P}/agent-runs`, { idempotencyKey: k(), timelineId: s.timeline, stateSha256: t0 });
    const r1 = await until(async () => { const r = (await call(owner, "GET", `/projects/${s.P}/agent-runs/${routine.json.id}`)).json; return terminal(r?.state) ? r : null; }, 120_000, "routine run", 500);
    compose("stop", "-t", "5", "agent-worker");
    const run = (await call(owner, "POST", `/projects/${s.P}/agent-runs`, { idempotencyKey: k(), timelineId: s.timeline, stateSha256: t0 })).json.id;
    const cfg = L.loopConfig({ analysisRequirement: "none" }), caps = L.replayCaps();
    await C.runs.enableControlledReplay(ownerRow, s.P, run, cfg, SDK.contentHash(caps));
    const snap = (await q("SELECT snapshot FROM editing_timelines WHERE id=$1", [s.timeline]))[0].snapshot;
    const ctx = await AC.buildAgentContext(C.source, AC.packagedPrompts(), L.contextRequest(caps, cfg, ownerRow, s.P, run, t0));
    const plan = L.goodPlan(s.P, s.timeline, snap, t0, ctx);
    const calls: any[] = [];
    try { await AC.runControlledAgentLoop({ runs: C.runs, source: C.source, registry: C.registry, authority: C.authority, executor: C.executor, model: L.scripted(AC, caps, { plans: [plan] }), render: L.refusingRender(AC, calls) }, run, AbortSignal.timeout(120_000)); } catch { /* typed state is asserted below */ }
    const view = (await call(owner, "GET", `/projects/${s.P}/agent-runs/${run}`)).json, exp = (await call(owner, "GET", `/projects/${s.P}/agent-runs/${run}/export`)).json;
    const hist = await Promise.all(s.runs.map(async (id: string) => (await call(owner, "GET", `/projects/${s.P}/agent-runs/${id}`)).json.schemaVersion));
    return { pass: r1.schemaVersion === "1.0.0" && r1.stopReason === "PLANNER_NOT_CONFIGURED" && view.schemaVersion === "1.1.0" && SCHEMAS.AgentRunSchema.safeParse(view).success && SCHEMAS.AgentExportSchema.safeParse(exp).success && exp.schemaVersion === "1.1.0" &&
      view.planning?.stopReason === "RENDER_FAILED" && view.checkpoint === 2 && hist.every((v: string) => v === "1.0.0"),
      actual: { routine: [r1.schemaVersion, r1.stopReason], controlled: { schema: view.schemaVersion, state: view.state, stop: view.stopReason, planning: view.planning, checkpoint: view.checkpoint, exportSchema: exp.schemaVersion }, historical: hist } };
  });
  // Pooled-connection regression and agent-write fences at the SQL boundary (single dedicated connection, forced generic plans).
  const client = await pool.connect();
  const upd = { name: "qa88_ordinary_update", text: "UPDATE editing_timelines SET snapshot=snapshot WHERE id=$1 AND project_id=$2" };
  const attempt = async (settings: Record<string, string> | null) => {
    await client.query("BEGIN");
    try {
      if (settings) for (const [key, v] of Object.entries(settings)) await client.query("SELECT set_config($1,$2,true)", [key, v]);
      await client.query({ ...upd, values: [s.timeline, s.P] });
      return "OK";
    } catch (e: any) { return e?.code ?? "ERR"; } finally { await client.query("ROLLBACK"); }
  };
  await probe("M05", "Pooled-connection reuse: after transaction-local agent settings reset to '' (and when never set), ordinary Timeline writes work under forced generic plans", "plan_cache_mode=force_generic_plan; 13 executions of one prepared UPDATE alternating never-set/reset/explicit-empty -> all OK, never 22P02; ordinary API edit succeeds", async () => {
    await client.query("SET plan_cache_mode = force_generic_plan");
    const out: string[] = [`neverSet:${await attempt(null)}`];
    for (let i = 0; i < 6; i++) {
      await client.query("BEGIN"); await client.query("SELECT set_config('editagent.agent_run',$1,true),set_config('editagent.agent_owner',$2,true),set_config('editagent.agent_generation','1',true)", [s.runs[0], randomUUID()]); await client.query("COMMIT");
      const reset = (await client.query("SELECT current_setting('editagent.agent_run',true) r")).rows[0].r;
      out.push(`${reset === "" ? "reset" : "NOT_RESET"}:${await attempt(null)}`);
      out.push(`explicitEmpty:${await attempt({ "editagent.agent_run": "", "editagent.agent_owner": "", "editagent.agent_generation": "" })}`);
    }
    const tl = (await q("SELECT state_sha256,snapshot FROM editing_timelines WHERE id=$1", [s.timeline]))[0];
    const clip = tl.snapshot.tracks.find((t: any) => t.kind === "video").clips.at(-1);
    const at = String((BigInt(clip.timelineStartUs) + (BigInt(clip.outPoint) - BigInt(clip.inPoint)) / 2n) / 40000n * 40000n);
    const apiEdit = await call(owner, "POST", `/projects/${s.P}/timelines/${s.timeline}/split`, { stateSha256: tl.state_sha256, clipId: clip.id, atUs: at });
    return { pass: out.every((x) => x.endsWith(":OK") && !x.startsWith("NOT_RESET")) && apiEdit.status < 300, actual: { results: out, apiEdit: apiEdit.status } };
  });
  await probe("M06", "Agent Timeline writes stay fenced at the database for wrong/missing owner, generation, run, lease, deadline, state or membership (23514, rolled back); the exact live lease is the only accepted write", "positive control OK; every mismatch -> 23514 (a non-UUID owner may raise 22P02, still rejected); Timeline unchanged; forced generic plans", async () => {
    await setMembership(s.P, viewer.id, "editor");
    const tl = (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [s.timeline]))[0].state_sha256;
    const execRun = (await call(viewer, "POST", `/projects/${s.P}/agent-runs`, { idempotencyKey: k(), timelineId: s.timeline, stateSha256: tl })).json.id;
    await C.runs.enableControlledReplay(viewer.id, s.P, execRun, L.loopConfig({ analysisRequirement: "none" }), SDK.contentHash(L.replayCaps()));
    const lease = await C.runs.claim(execRun);
    for (const st of ["Observing", "Planning", "Executing"]) await C.runs.move(lease, st);
    const base = { "editagent.agent_run": execRun, "editagent.agent_owner": lease.owner, "editagent.agent_generation": String(lease.generation) };
    const r: Record<string, string> = {};
    r.positive = await attempt(base);
    r.ownerEmpty = await attempt({ ...base, "editagent.agent_owner": "" });
    r.ownerOther = await attempt({ ...base, "editagent.agent_owner": randomUUID() });
    r.ownerGarbage = await attempt({ ...base, "editagent.agent_owner": "not-a-uuid" });
    r.generationEmpty = await attempt({ ...base, "editagent.agent_generation": "" });
    r.generationStale = await attempt({ ...base, "editagent.agent_generation": String(lease.generation - 1) });
    r.otherRun = await attempt({ ...base, "editagent.agent_run": s.runs[0] });
    r.unknownRun = await attempt({ ...base, "editagent.agent_run": randomUUID() });
    await q("UPDATE agent_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [execRun]); r.leaseExpired = await attempt(base);
    await q("UPDATE agent_runs SET lease_until=clock_timestamp()+interval '60 seconds', deadline_at_ms=(extract(epoch FROM clock_timestamp())*1000)::bigint-1 WHERE id=$1", [execRun]); r.deadlinePassed = await attempt(base);
    await q("UPDATE agent_runs SET deadline_at_ms=(extract(epoch FROM clock_timestamp())*1000)::bigint+60000 WHERE id=$1", [execRun]);
    await setMembership(s.P, viewer.id, "viewer"); r.membershipViewer = await attempt(base);
    await setMembership(s.P, viewer.id, null); r.membershipRevoked = await attempt(base);
    await setMembership(s.P, viewer.id, "editor");
    await q("UPDATE agent_runs SET state='Planning' WHERE id=$1", [execRun]); r.notExecuting = await attempt(base);
    await q("UPDATE agent_runs SET state='Failed',stop_reason='INTERNAL',lease_until=NULL WHERE id=$1", [execRun]);
    await setMembership(s.P, viewer.id, "viewer");
    const after = (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [s.timeline]))[0].state_sha256;
    const rejected = Object.entries(r).filter(([key]) => key !== "positive");
    return { pass: r.positive === "OK" && rejected.every(([key, v]) => v === "23514" || (key === "ownerGarbage" && v === "22P02")) && after === tl,
      actual: { codes: r, timelineUnchanged: after === tl } };
  });
  client.release();
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "agent-worker");
  await probe("M07", "No UUID-cast (22P02) or fence errors leaked to ordinary product traffic after the regression probes", "API and agent-worker logs contain no 22P02 / invalid input syntax for type uuid", async () => {
    const logs = execFileSync("docker", ["compose", "-f", path.join(APP, "compose.yaml"), "logs", "--no-color", "api", "agent-worker"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const hits = (logs.match(/22P02|invalid input syntax for type uuid/g) ?? []).length;
    writeFileSync(path.join(OUT, "m07-log-hits.txt"), String(hits));
    return { pass: hits === 0, actual: { hits } };
  });
  await pool.end();
});
