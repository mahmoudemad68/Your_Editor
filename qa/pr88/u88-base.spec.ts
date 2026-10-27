/** PR #88 independent QA, upgrade part 1: populate unmodified BASE main (a789540) with real users, media, Timeline edits
 * and infrastructure AgentRuns/events/exports, and record their exact bytes for the post-0023 comparison. */
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { INPUTS, PRIVATE, call, newProject, newTimeline, newUser, pool, probe, q, until, upload } from "./helpers88";

const terminal = (s: string) => ["Completed", "Failed", "Cancelled"].includes(s);
test("PR88 upgrade part 1: populated base main", async ({ browser }) => {
  test.setTimeout(60 * 60_000);
  const owner = await newUser(browser, "upgrade"), viewer = await newUser(browser, "upgrade-viewer");
  const P = await newProject(owner, "QA88 upgrade");
  await q("INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'viewer',$3)", [P, viewer.id, Date.now()]);
  await q("UPDATE projects SET updated_at=GREATEST(updated_at,$2), revision=revision+1 WHERE id=$1", [P, Date.now()]);
  const M = await upload(owner.page, P, path.join(INPUTS, "qa88-source.mp4"), []);
  const tl = await newTimeline(owner, P, M);
  const trimmed = await call(owner, "POST", `/projects/${P}/timelines/${tl.id}/trim`, { stateSha256: tl.sha, clipId: tl.snapshot.tracks.find((t: any) => t.kind === "video").clips[0].id, startUs: "200000", endUs: "7800000" });
  const sha1 = (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [tl.id]))[0].state_sha256;
  const runs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await call(owner, "POST", `/projects/${P}/agent-runs`, { idempotencyKey: `qa88u-${randomUUID().replaceAll("-", "")}`, timelineId: tl.id, stateSha256: sha1 });
    runs.push(r.json.id);
    await until(async () => terminal((await q("SELECT state FROM agent_runs WHERE id=$1", [r.json.id]))[0]?.state), 120_000, "base run", 500);
  }
  const views: Record<string, any> = {};
  for (const id of runs) {
    const pages: any[] = []; let cursor: string | null = null;
    do { const e = await call(owner, "GET", `/projects/${P}/agent-runs/${id}/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`); pages.push(e.json); cursor = e.json?.nextCursor ?? null; } while (cursor);
    views[id] = { run: (await call(owner, "GET", `/projects/${P}/agent-runs/${id}`)).json, audit: (await call(viewer, "GET", `/projects/${P}/agent-runs/${id}/audit`)).json, export: pages };
  }
  const events = await q("SELECT id,run_id,sequence,md5(event::text) h,octet_length(event::text) n FROM agent_events ORDER BY run_id,sequence");
  const runRows = await q("SELECT id,md5(row_to_json(r)::text) h FROM agent_runs r ORDER BY id");
  const steps = await q("SELECT md5(coalesce(string_agg(row_to_json(s)::text, '|' ORDER BY s.id),'')) h FROM agent_steps s");
  const counts = (await q(`SELECT (SELECT count(*) FROM users)::int u,(SELECT count(*) FROM projects)::int p,(SELECT count(*) FROM media_assets)::int m,
    (SELECT count(*) FROM editing_timelines)::int t,(SELECT count(*) FROM jobs)::int j,(SELECT count(*) FROM tool_executions)::int x,(SELECT count(*) FROM agent_runs)::int r,(SELECT count(*) FROM agent_events)::int e`))[0];
  const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name='agent_runs'")).map((r: any) => r.column_name);
  const migrations = (await q("SELECT id FROM schema_migrations ORDER BY id")).map((r: any) => r.id);
  writeFileSync(path.join(PRIVATE, "upgrade88.json"), JSON.stringify({ P, M, timeline: tl.id, sha: sha1, runs, views, events, runRows, steps: steps[0].h, counts, owner: { email: owner.email, password: owner.password }, viewer: { email: viewer.email, password: viewer.password } }));
  await probe("UB1", "Base main populated with real data: edited Timeline, two terminal infrastructure AgentRuns with events and exports; no 0023 objects", "trim 2xx; 2 runs Failed PLANNER_NOT_CONFIGURED with schema 1.0.0; last migration below 0023; no runtime_driver column; no agent_loop_sessions table", async () => {
    const reg = (await q("SELECT to_regclass('agent_loop_sessions') a, to_regclass('render_output_validations') b"))[0];
    const ok = runs.every((id) => views[id].run?.schemaVersion === "1.0.0" && views[id].run.stopReason === "PLANNER_NOT_CONFIGURED");
    return { pass: trimmed.status < 300 && ok && !cols.includes("runtime_driver") && reg.a === null && reg.b === null && !migrations.some((m: string) => m.startsWith("0023")) && events.length >= 6,
      actual: { trim: trimmed.status, runs: runs.map((id) => [views[id].run?.state, views[id].run?.stopReason, views[id].run?.schemaVersion]), lastMigration: migrations.at(-1), counts, events: events.length } };
  });
  await pool.end();
});
