// PR #88 Independent QA, crash/fence matrix child: one controlled-loop driver process over real PostgreSQL/Tool SDK
// (and the real authenticated render port when render="real"), so the parent can SIGKILL/SIGSTOP it at exact points.
// Input: QA88_CHILD (path to a JSON spec). Output: result JSON written to spec.result. No secrets are logged.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { load, scripted, refusingRender, composition, permitFor } from "./lib88.mjs";

const spec = JSON.parse(readFileSync(process.env.QA88_CHILD, "utf8"));
const L = load(spec.app);
const { AC } = L;
const pool = new L.pg.Pool({ connectionString: spec.pg, max: 4, connectionTimeoutMillis: 3000 });
pool.on("error", () => undefined);
const permit = permitFor(AC);
const c = composition(L, pool, permit);
const calls = [];
let queue = null, render;
if (spec.render === "real") {
  queue = new L.JQ.BullMqJobQueue(spec.redis);
  render = new L.RP.AuthenticatedTimelineRenderPort(pool, queue, spec.apiOrigin, async () => ({ cookie: spec.cookie, "x-editagent-csrf": spec.csrf }), permit);
} else render = refusingRender(AC, calls);
const plan = spec.plan;
const model = scripted(AC, spec.caps, {
  plans: [plan], block: spec.block ?? null, fail: spec.fail ?? null, log: spec.log ?? null,
  onTool: spec.releaseFile ? async (step) => { if (spec.releaseStep && step.id !== spec.releaseStep) return; while (!existsSync(spec.releaseFile)) await new Promise((r) => setTimeout(r, 100)); } : null,
});
const out = { pid: process.pid, startedAt: Date.now(), outcome: "returned", error: null, model: null, renderCalls: calls };
try {
  await AC.runControlledAgentLoop({ runs: c.runs, source: c.source, registry: c.registry, authority: c.authority, executor: c.executor, model, render }, spec.runId, AbortSignal.timeout(spec.timeoutMs ?? 140_000));
} catch (e) {
  out.outcome = "threw"; out.error = e?.code ?? e?.name ?? "unknown";
}
out.model = model.counts; out.finishedAt = Date.now();
writeFileSync(spec.result, JSON.stringify(out));
await queue?.close(true).catch(() => undefined);
await pool.end().catch(() => undefined);
process.exit(0);
