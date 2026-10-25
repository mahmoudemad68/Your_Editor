// QA-authored child driver for SIGKILL experiments (PR #77). Drives ONLY the public agent-core /
// tool-sdk primitives of the frozen build over real PostgreSQL, then parks so the parent can SIGKILL it.
import { createRequire } from "node:module";
import path from "node:path";

const req = createRequire(path.join(process.env.QA_APP_ROOT, "apps/api/package.json"));
const { Pool } = req("pg");
const { PostgresAgentRuns, executeAgentTool, newAgentId } = req("@editagent/agent-core");
const { Timeline } = req("@editagent/domain");
const { PostgresToolAuditRepository, PostgresToolAuthority, ToolExecutor, ToolRegistry, registerEditingTools } = req("@editagent/tool-sdk");

const pool = new Pool({ connectionString: process.env.QA_PG, max: 4 });
const runs = new PostgresAgentRuns(pool);
const load = async (project, timeline) =>
  Timeline.restore((await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1 AND project_id=$2", [timeline, project])).rows[0].snapshot);
const authority = new PostgresToolAuthority(pool, load);
const executor = new ToolExecutor(registerEditingTools(new ToolRegistry(), authority), authority, new PostgresToolAuditRepository(pool, 1_000_000));
const park = () => new Promise(() => undefined);

try {
  const id = process.env.QA_RUN, mode = process.env.QA_MODE;
  const lease = await runs.claim(id, newAgentId());
  if (!lease) { process.send({ phase: "no_lease" }); process.exit(0); }
  for (const s of ["Observing", "Planning", "Executing"]) await runs.move(lease, s);
  const view = await runs.workerView(lease);
  const actor = await runs.workerActor(lease);
  const snap = (await load(view.projectId, view.source.timelineId)).toSnapshot();
  const clip = snap.tracks.find((t) => t.kind === "video").clips[0];
  const call = (k) => ({ name: "editing.trim-video", version: "1.0.0", callerId: actor, projectId: view.projectId, resource: { kind: "timeline", id: snap.id },
    input: { clipId: clip.id, startUs: String(200000 + k * 100000), endUs: String(7800000 - k * 100000) } });
  if (mode === "checkpoint") {
    const ok = await executeAgentTool(runs, lease, executor, call(0), new AbortController().signal);
    process.send({ phase: ok ? "checkpoint" : "step_failed", lease });
    await park();
  }
  const step = await runs.beginStep(lease, "editing.trim-video", "1.0.0", call(0).input);
  if (mode === "intent") { process.send({ phase: "intent", receiptId: step.receiptId, lease }); await park(); }
  if (mode === "unconfirmed") {
    await executor.executeWithIdentity(step.receiptId, call(0));
    process.send({ phase: "admitted_without_checkpoint", receiptId: step.receiptId, lease });
    await park();
  }
} catch (e) {
  process.send?.({ phase: "child_error", error: String(e?.code ?? e?.message ?? e).slice(0, 120) });
  process.exit(1);
}
