/** PR #73 independent QA, upgrade part 2: same volumes after upgrading to the PR head (migration 0021). QA-authored. */
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OUT, PRIVATE, WEB, call, canon, dbDoc, latest, pool, probe, q, retry, settled, waitApplied, type User } from "./helpers68";

const legacy = (data: any) => { const { languageSegments: _drop, ...rest } = data; return rest; };

test("PR73 upgrade part 2: historical retrieval, migration and re-analysis at head", async ({ browser }) => {
  const s = JSON.parse(readFileSync(path.join(PRIVATE, "upgrade.json"), "utf8"));
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(s.owner.email);
  await page.getByLabel("Password", { exact: true }).fill(s.owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  const owner = { ctx, page, email: s.owner.email, password: s.owner.password, id: "" } as User;

  await probe("U2", "After upgrade: migration 0021 applied, stored 1.1.0 document untouched and served unchanged (API, BFF, UI)", "schema_migrations includes 0021; DB doc canonical-equal to pre-upgrade; GET 200 equal; BFF ok; UI shows transcript, no evidence section", async () => {
    const m = (await q("SELECT id FROM schema_migrations ORDER BY id")).map((r) => String(r.id));
    const d = await dbDoc(s.M);
    const g = await call(owner, "GET", `/projects/${s.P}/media/${s.M}/analysis`);
    const bj = await (await page.request.get(`/api/projects/${s.P}/media/${s.M}/analysis`)).json().catch(() => null);
    await page.goto(`/projects/${s.P}`);
    const card = page.getByRole("region", { name: "Media Library" }).locator("div")
      .filter({ hasText: "qa-upgrade-en-ar.mp4" }).filter({ has: page.getByRole("button", { name: "View analysis" }) }).last();
    await card.getByRole("button", { name: "View analysis" }).click();
    const panel = page.getByRole("region", { name: "Media analysis" });
    await expect(panel.getByLabel("Transcript")).toBeVisible({ timeout: 60_000 });
    const evidence = await panel.getByText("Local language evidence").count();
    return { pass: m.some((i) => i.includes("0021")) && canon(d.document) === canon(s.document) && d.revision === s.revision && g.status === 200 && canon(g.json) === canon(s.api) && bj?.ok === true && evidence === 0,
      actual: { lastMigrations: m.slice(-2), dbUnchanged: canon(d.document) === canon(s.document), revisionUnchanged: d.revision === s.revision, api: g.status, apiUnchanged: canon(g.json) === canon(s.api), schemaVersion: g.json?.schemaVersion, bffOk: bj?.ok, uiEvidenceElements: evidence } };
  });

  await probe("U3", "Re-analysis at head of the same historical media: 1.2.0 with evidence; words/times/confidence/language identical to the base production image; provenance differs only by configuration identity", "transcript retry Completed; schemaVersion 1.2.0; legacy transcript data canonical-equal to base; provenance keys differing ⊆ {configurationSha256}; audio section unchanged", async () => {
    const r = await retry(owner, s.M, "transcript", (await latest(s.M, "transcript")).job_id);
    if (!r.json?.jobId) return { pass: false, actual: { retry: r.status, body: r.text.slice(0, 200) } };
    const st = await waitApplied(r.json.jobId, 900_000);
    await settled(s.M, 600_000);
    const now = (await dbDoc(s.M)).document;
    const a = s.document.sections.transcript, b = now.sections.transcript;
    const provDiff = Object.keys({ ...a.provenance, ...b.provenance }).filter((k) => canon(a.provenance[k]) !== canon(b.provenance[k]));
    const legacyEqual = canon(a.data) === canon(legacy(b.data));
    writeFileSync(path.join(OUT, "u3-cross-version.json"), JSON.stringify({ legacyEqual, provDiff, evidence: b.data.languageSegments?.map((x: any) => x.language ?? x.status), baseWords: a.data.segments.length, headWords: b.data.segments.length }, null, 1));
    return { pass: st === "Completed" && now.schemaVersion === "1.2.0" && Array.isArray(b.data.languageSegments) && legacyEqual && provDiff.every((k) => k === "configurationSha256") && canon(now.sections.audio) === canon(s.document.sections.audio),
      actual: { status: st, schemaVersion: now.schemaVersion, evidenceEntries: b.data.languageSegments?.length, legacyEqual, provenanceDiffKeys: provDiff, audioUnchanged: canon(now.sections.audio) === canon(s.document.sections.audio), baseWords: a.data.segments.length, headWords: b.data.segments.length } };
  });
  await pool.end();
});
