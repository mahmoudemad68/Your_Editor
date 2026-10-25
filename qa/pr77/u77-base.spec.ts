/** PR #77 independent QA, upgrade part 1: populate the BASE (main 00074f2) stack with real data. QA-authored. */
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { INPUTS, PRIVATE, call, newProject, newTimeline, newUser, pool, probe, q, upload } from "./helpers77";

test("PR77 upgrade part 1: populated main", async ({ browser }) => {
  const owner = await newUser(browser, "upgrade");
  const P = await newProject(owner, "QA77 upgrade");
  const M = await upload(owner.page, P, path.join(INPUTS, "qa-source.mp4"), []);
  const tl = await newTimeline(owner, P, M);
  const trimmed = await call(owner, "POST", `/projects/${P}/timelines/${tl.id}/trim`, {
    stateSha256: tl.sha, clipId: tl.snapshot.tracks.find((t: any) => t.kind === "video").clips[0].id, startUs: "200000", endUs: "7800000",
  });
  const snapshot = (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [tl.id]))[0];
  const counts = (await q(`SELECT (SELECT count(*) FROM users)::int u,(SELECT count(*) FROM projects)::int p,(SELECT count(*) FROM media_assets)::int m,
    (SELECT count(*) FROM editing_timelines)::int t,(SELECT count(*) FROM jobs)::int j,(SELECT count(*) FROM tool_executions)::int x`))[0];
  const agentTable = (await q("SELECT to_regclass('agent_runs') AS r"))[0].r;
  writeFileSync(path.join(PRIVATE, "upgrade77.json"), JSON.stringify({ P, M, timeline: tl.id, sha: snapshot.state_sha256, counts, owner: { email: owner.email, password: owner.password } }));
  await probe("U1", "Base main populated with real user/project/media/timeline/tool receipt; no AgentRun schema yet", "trim 2xx; timeline hash recorded; agent_runs absent at base", async () => ({
    pass: trimmed.status < 300 && agentTable === null && counts.x >= 1, actual: { trim: trimmed.status, counts, agentRunsAtBase: agentTable },
  }));
  await pool.end();
});
