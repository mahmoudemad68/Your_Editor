/** PR #77 independent QA, upgrade part 2: head on the same volumes after an atomic failed-then-successful 0022. QA-authored. */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PRIVATE, WEB, call, pool, probe, q, until, type User } from "./helpers77";

test("PR77 upgrade part 2: migrated head", async ({ browser }) => {
  const s = JSON.parse(readFileSync(path.join(PRIVATE, "upgrade77.json"), "utf8"));
  const failed = JSON.parse(readFileSync(path.join(PRIVATE, "failed-migration.json"), "utf8"));
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(s.owner.email);
  await page.getByLabel("Password", { exact: true }).fill(s.owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const owner = { ctx, page, email: s.owner.email, password: s.owner.password, id: "" } as User;

  await probe("U2", "Failed 0022 is atomic: with a conflicting pre-existing object the head API does not start and leaves no partial AgentRun schema", "API unhealthy; schema_migrations lacks 0022; agent_runs/agent_steps/agent_events absent; base data untouched", async () => ({
    pass: failed.apiHealthy === false && failed.has0022 === false && failed.tables.every((t: string | null) => t === null) && failed.timelineSha === s.sha, actual: failed,
  }));

  await probe("U3", "After removing the conflict, 0022 applies once on populated data; existing rows unchanged; AgentRun works on a pre-existing Timeline", "0022 recorded; counts unchanged; timeline hash unchanged; start with pre-existing timeline 201 -> Failed/PLANNER_NOT_CONFIGURED", async () => {
    const m = (await q("SELECT id FROM schema_migrations ORDER BY id")).map((r) => r.id);
    const counts = (await q(`SELECT (SELECT count(*) FROM users)::int u,(SELECT count(*) FROM projects)::int p,(SELECT count(*) FROM media_assets)::int m,
      (SELECT count(*) FROM editing_timelines)::int t,(SELECT count(*) FROM jobs)::int j,(SELECT count(*) FROM tool_executions)::int x`))[0];
    const sha = (await q("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [s.timeline]))[0].state_sha256;
    const start = await call(owner, "POST", `/projects/${s.P}/agent-runs`, { idempotencyKey: `qa77u-${randomUUID().replaceAll("-", "")}`, timelineId: s.timeline, stateSha256: sha });
    const final = start.json?.id ? await until(async () => { const r = (await q("SELECT state,stop_reason FROM agent_runs WHERE id=$1", [start.json.id]))[0]; return r && ["Completed", "Failed", "Cancelled"].includes(r.state) ? r : null; }, 90_000, "upgrade run") : null;
    writeFileSync(path.join(PRIVATE, "upgrade-run.json"), JSON.stringify({ id: start.json?.id }));
    return { pass: m.filter((x) => x.startsWith("0022")).length === 1 && ["u", "p", "m", "t", "x"].every((k) => counts[k] === s.counts[k]) && sha === s.sha && start.status === 201 && final?.stop_reason === "PLANNER_NOT_CONFIGURED",
      actual: { migrations: m.slice(-2), countsBefore: s.counts, countsAfter: counts, timelineUnchanged: sha === s.sha, start: start.status, final } };
  });
  await pool.end();
});
