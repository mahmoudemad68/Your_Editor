/** PR #73 independent QA, upgrade part 1: produce a historical analysis on the BASE (main 69617c5) stack. QA-authored. */
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { INPUTS, PRIVATE, call, newUser, pool, probe, settled, upload } from "./helpers68";

test("PR73 upgrade part 1: base-version analysis", async ({ browser }) => {
  const owner = await newUser(browser, "upgrade");
  const page = owner.page;
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill("QA73 upgrade");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Open project" }).first().click();
  await expect(page.locator("#media-file")).toBeAttached();
  const P = new URL(page.url()).pathname.split("/").pop()!;
  const M = await upload(page, P, path.join(INPUTS, "qa-upgrade-en-ar.mp4"), []);
  const { d, t } = await settled(M, 900_000);
  const api = await call(owner, "GET", `/projects/${P}/media/${M}/analysis`);
  writeFileSync(path.join(PRIVATE, "upgrade.json"), JSON.stringify({ P, M, owner: { email: owner.email, password: owner.password }, document: d.document, revision: d.revision, api: api.json, tasks: t.map((x: any) => x.job_id) }));
  await probe("U1", "Base stack produces a historical 1.1.0 analysis for EN->AR media (no language evidence field exists yet)", "schemaVersion 1.1.0; transcript completed; no languageSegments", async () => ({
    pass: api.status === 200 && api.json.schemaVersion === "1.1.0" && api.json.sections.transcript.status === "completed" && !("languageSegments" in api.json.sections.transcript.data),
    actual: { status: api.status, schemaVersion: api.json?.schemaVersion, transcript: api.json?.sections?.transcript?.status, words: api.json?.sections?.transcript?.data?.segments?.length },
  }));
  await pool.end();
});
