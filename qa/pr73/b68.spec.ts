/** PR #73 independent QA (reused PR #68 probe), part B: real Tiny Arabic through the deployed Tiny image at the PR #73 head. */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ALLOW, INPUTS, OUT, PRIVATE, WEB, call, dbDoc, failures, leakScan, pool, probe, q, settled, upload, type User } from "./helpers68";

test("PR68 part B: Tiny Arabic untrustworthy alignment", async ({ browser }) => {
  const state = JSON.parse(readFileSync(path.join(PRIVATE, "state.json"), "utf8"));
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(state.owner.email);
  await page.getByLabel("Password", { exact: true }).fill(state.owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const owner = { ctx, page, email: state.owner.email, password: state.owner.password, id: "" } as User;
  await probe("G1", "Real Tiny/int8 Arabic (licensed ar-long, 60 s) through the deployed stack -> untrustworthy_alignment; no words published", "model faster-whisper-tiny recorded; transcript failed; category untrustworthy_alignment, code unsupported, retryable false; audio completed; UI shows allowlist text", async () => {
    const MA = await upload(page, state.P, path.join(INPUTS, "qa-ar-long.mp4"), state.known);
    const { t, d } = await settled(MA, 900_000);
    const tt = t.filter((x: any) => x.analyzer === "transcript").at(-1);
    const [cfg] = await q("SELECT configuration->'asr'->>'model' AS model, configuration::text AS c FROM analysis_tasks WHERE job_id=$1", [tt.job_id]);
    const f = await failures(owner, state.P, MA);
    const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
    await page.goto(`/projects/${state.P}`);
    const card = page.getByRole("region", { name: "Media Library" }).locator("div")
      .filter({ hasText: "qa-ar-long.mp4" }).filter({ has: page.getByRole("button", { name: "View analysis" }) }).last();
    await card.getByRole("button", { name: "View analysis" }).click();
    const panel = page.getByRole("region", { name: "Media analysis" });
    await expect(panel).toContainText(ALLOW.untrustworthy_alignment, { timeout: 60_000 });
    const ui = await panel.innerText();
    await page.screenshot({ path: path.join(OUT, "g1-tiny-arabic-analysis.png"), fullPage: true, mask: [page.locator("header .text-muted"), panel.locator('p[dir="auto"]')] });
    const tinyRecorded = /tiny/.test(cfg?.model ?? cfg?.c ?? "");
    return { pass: tinyRecorded && tt.status !== "Completed" && tt.failure_category === "untrustworthy_alignment" && tr?.code === "unsupported" && tr?.retryable === false &&
        d.document.sections.transcript.status === "failed" && !d.document.sections.transcript.data && leakScan(ui).length === 0,
      actual: { modelRecorded: cfg?.model ?? (tinyRecorded ? "tiny (in configuration)" : "not tiny"), jobStatus: tt.status, persistedCategory: tt.failure_category, detail: tr,
        legacyDocFailure: d.document.sections.transcript.failure, audio: d.document.sections.audio.status, uiShowsAllowlist: ui.includes(ALLOW.untrustworthy_alignment), uiLeaks: leakScan(ui) } };
  });
  await pool.end();
});
