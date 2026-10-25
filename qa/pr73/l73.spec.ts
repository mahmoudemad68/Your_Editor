/** PR #73 independent QA, part L: MediaAnalysis 1.2.0 language evidence on the real stack (Small). QA-authored. */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APP, INPUTS, OUT, PRIVATE, WEB, call, canon, dbDoc, latest, leakScan, newUser, pool, probe, q, retry, settled, upload, waitApplied, type User,
} from "./helpers68";

const SMALL_REV = "536b0662742c02347bc0e980a01041f333bce120";
type Seg = { startUs: string; endUs: string; method: string; scope: string; model: { name: string; version: string; sha256: string }; status: string; language?: string; confidence?: number };

/** QA invariants over persisted language segments (independent of the product's own checks). */
function inspect(segs: Seg[] | undefined, durationUs: number) {
  if (!segs) return { present: false, violations: [] as string[], labels: [] as string[] };
  const v: string[] = [];
  let prev = -1;
  segs.forEach((s, i) => {
    const a = Number(s.startUs), b = Number(s.endUs);
    if (!(a < b)) v.push(`empty ${i}`);
    if (a < prev) v.push(`overlap ${i}`);
    if (b - a > 4_000_000) v.push(`wider than probe ${i}`);
    if (b > durationUs + 1_000_000) v.push(`beyond media ${i}`);
    if (s.scope !== "audio_context_not_word_language" || s.method !== "ct2-source-context-v1") v.push(`scope/method ${i}`);
    if (s.status === "dominant" && !(typeof s.confidence === "number" && s.confidence >= 0.5 && s.confidence <= 1 && s.language)) v.push(`dominant ${i}`);
    if (s.status !== "dominant" && ("confidence" in s || "language" in s)) v.push(`${s.status} labelled ${i}`);
    prev = b;
  });
  return {
    present: true, count: segs.length, violations: v,
    labels: segs.map((s) => s.language ?? s.status.toUpperCase()),
    confidences: segs.map((s) => s.confidence ?? null),
    models: [...new Set(segs.map((s) => `${s.model.name}@${s.model.version}`))],
    first: segs[0]?.startUs, last: segs.at(-1)?.endUs,
  };
}
const legacy = (data: any) => { const { languageSegments: _drop, ...rest } = data; return rest; };
async function schemas() {
  return import(pathToFileURL(path.join(APP, "packages/schemas/dist/index.js")).href);
}
async function login(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
}
async function openPanel(page: Page, P: string, file: string) {
  await page.goto(`/projects/${P}`);
  const card = page.getByRole("region", { name: "Media Library" }).locator("div")
    .filter({ hasText: file }).filter({ has: page.getByRole("button", { name: "View analysis" }) }).last();
  await card.getByRole("button", { name: "View analysis" }).click();
  const panel = page.getByRole("region", { name: "Media analysis" });
  await expect(panel.getByText(/Transcript:/)).toBeVisible({ timeout: 60_000 }).catch(() => undefined);
  return panel;
}
const setDocument = (m: string, document: unknown) =>
  q("UPDATE media_analyses SET document=$2, revision=revision+1 WHERE media_asset_id=$1", [m, document]);

test("PR73 part L: language evidence and MediaAnalysis 1.2.0 on real services", async ({ browser }) => {
  const state = JSON.parse(readFileSync(path.join(PRIVATE, "state.json"), "utf8"));
  const P = state.P as string, known = state.known as string[];
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await login(page, state.owner.email, state.owner.password);
  const owner = { ctx, page, email: state.owner.email, password: state.owner.password, id: "" } as User;
  const outsider = await newUser(browser, "l-outsider");
  const S = await schemas();

  const ME = await upload(page, P, path.join(INPUTS, "qa-en-ar.mp4"), known); known.push(ME);
  const first = await settled(ME, 900_000);
  const docE = (await call(owner, "GET", `/projects/${P}/media/${ME}/analysis`)).json;
  const durE = Number(docE?.source?.durationUs ?? 16_000_000);

  await probe("L1", "EN->AR media: new 1.2.0 document carries well-formed local evidence from the pinned Small detector; API = DB = BFF; exact schema parse", "schemaVersion 1.2.0; transcript completed; languageSegments present, ordered, <=4 s probes, no label on mixed/unknown, model faster-whisper-small@536b066; API/DB/BFF canonical equality; parseMediaAnalysis accepts", async () => {
    const bff = await page.request.get(`/api/projects/${P}/media/${ME}/analysis`);
    const bj = await bff.json().catch(() => null);
    const tr = docE.sections.transcript;
    const lm = inspect(tr.data?.languageSegments, durE);
    let parsed = false; try { parsed = S.parseMediaAnalysis(docE).schemaVersion === "1.2.0"; } catch { parsed = false; }
    const dbEqual = canon(first.d.document) === canon(docE);
    const bffEqual = bj?.ok === true && canon(bj.data) === canon(docE);
    writeFileSync(path.join(OUT, "l1-language-segments.json"), JSON.stringify({ mediaDurationUs: durE, documentLanguage: tr.data?.language, evidence: lm }, null, 1));
    return { pass: docE.schemaVersion === "1.2.0" && tr.status === "completed" && lm.present && lm.violations.length === 0 &&
        (lm.models as string[]).every((m) => m === `faster-whisper-small@${SMALL_REV}`) && parsed && dbEqual && bffEqual,
      actual: { schemaVersion: docE.schemaVersion, transcript: tr.status, words: tr.data?.segments?.length, documentLanguage: tr.data?.language, evidence: lm, parsed, dbEqual, bffEqual } };
  });

  await probe("L2", "Determinism across jobs: transcript retry of the same media reproduces identical evidence and identical legacy transcript data", "new generation Completed; languageSegments and legacy data canonical-equal to generation 1", async () => {
    const r = await retry(owner, ME, "transcript", (await latest(ME, "transcript")).job_id);
    if (!r.json?.jobId) return { pass: false, actual: { retry: r.status, body: r.text.slice(0, 200) } };
    const st = await waitApplied(r.json.jobId, 900_000);
    const again = (await call(owner, "GET", `/projects/${P}/media/${ME}/analysis`)).json;
    const a = docE.sections.transcript.data, b = again.sections.transcript.data;
    return { pass: st === "Completed" && canon(a.languageSegments) === canon(b.languageSegments) && canon(legacy(a)) === canon(legacy(b)) && canon(docE.sections.transcript.provenance) === canon(again.sections.transcript.provenance),
      actual: { status: st, evidenceEqual: canon(a.languageSegments) === canon(b.languageSegments), legacyEqual: canon(legacy(a)) === canon(legacy(b)), provenanceEqual: canon(docE.sections.transcript.provenance) === canon(again.sections.transcript.provenance) } };
  });

  await probe("L3", "No cross-job leakage on the same worker: silent media after code-switched media has no language labels; AR->EN media is evaluated independently", "silence: no dominant/mixed entries (only unknown or none), 0 words; AR->EN well-formed; evidence differs from EN->AR", async () => {
    const MS = await upload(page, P, path.join(INPUTS, "qa-silence.mp4"), known); known.push(MS);
    await settled(MS, 900_000);
    const ds = (await call(owner, "GET", `/projects/${P}/media/${MS}/analysis`)).json;
    const MR = await upload(page, P, path.join(INPUTS, "qa-ar-en.mp4"), known); known.push(MR);
    await settled(MR, 900_000);
    const dr = (await call(owner, "GET", `/projects/${P}/media/${MR}/analysis`)).json;
    const ls = inspect(ds.sections.transcript.data?.languageSegments, Number(ds.source.durationUs));
    const lr = inspect(dr.sections.transcript.data?.languageSegments, Number(dr.source.durationUs));
    const silentClean = ds.sections.transcript.status === "completed" && (ds.sections.transcript.data.segments.length === 0) &&
      (!ls.present || (ls.labels as string[]).every((l) => l === "UNKNOWN"));
    writeFileSync(path.join(OUT, "l3-language-segments.json"), JSON.stringify({ silence: ls, arEn: lr, arEnLanguage: dr.sections.transcript.data?.language }, null, 1));
    return { pass: silentClean && ls.violations.length === 0 && lr.present && lr.violations.length === 0 && canon(lr.labels) !== canon(inspect(docE.sections.transcript.data.languageSegments, durE).labels),
      actual: { silence: { transcript: ds.sections.transcript.status, words: ds.sections.transcript.data?.segments?.length, evidence: ls }, arEn: { documentLanguage: dr.sections.transcript.data?.language, evidence: lr } } };
  });

  const original = (await dbDoc(ME)).document;
  await probe("L4", "Historical 1.1.0 and 1.0.0 documents: served unchanged, no invented evidence, UI renders transcript without evidence; later publication upgrades envelope only", "GET returns the stored 1.1.0/1.0.0 bytes canonically; no languageSegments; BFF ok; UI has transcript and no 'Local language evidence'; after audio retry: 1.2.0 with transcript section byte-identical to stored legacy section", async () => {
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const v of ["1.1.0", "1.0.0"]) {
      const old = { ...original, schemaVersion: v, sections: { ...original.sections, transcript: { ...original.sections.transcript, data: legacy(original.sections.transcript.data) } } };
      await setDocument(ME, old);
      const g = await call(owner, "GET", `/projects/${P}/media/${ME}/analysis`);
      const bj = await (await page.request.get(`/api/projects/${P}/media/${ME}/analysis`)).json().catch(() => null);
      const panel = await openPanel(page, P, "qa-en-ar.mp4");
      await expect(panel.getByLabel("Transcript")).toBeVisible({ timeout: 60_000 });
      const evidenceShown = await panel.getByText("Local language evidence").count();
      const served = g.status === 200 && canon(g.json) === canon(old) && !("languageSegments" in g.json.sections.transcript.data) && bj?.ok === true;
      out[v] = { status: g.status, servedUnchanged: canon(g.json) === canon(old), languageSegments: "languageSegments" in (g.json?.sections?.transcript?.data ?? {}), bffOk: bj?.ok, uiEvidenceElements: evidenceShown };
      ok = ok && served && evidenceShown === 0;
    }
    const legacyTranscript = (await dbDoc(ME)).document.sections.transcript;
    const r = await retry(owner, ME, "audio", (await latest(ME, "audio")).job_id);
    const st = r.json?.jobId ? await waitApplied(r.json.jobId, 600_000) : null;
    await settled(ME, 600_000);
    const up = (await dbDoc(ME)).document;
    out.afterPublication = { retry: r.status, status: st, schemaVersion: up.schemaVersion, transcriptUnchanged: canon(up.sections.transcript) === canon(legacyTranscript), inventedEvidence: "languageSegments" in (up.sections.transcript.data ?? {}) };
    ok = ok && up.schemaVersion === "1.2.0" && canon(up.sections.transcript) === canon(legacyTranscript);
    await setDocument(ME, { ...up, sections: { ...up.sections, transcript: original.sections.transcript } });
    return { pass: ok, actual: out };
  });

  await probe("L5", "Tampered persisted metadata fails closed (API, BFF, UI); unknown envelope version rejected by migration 0021 CHECK", "mixed+confidence / unknown+language / word-language docs: API non-200 with safe body, BFF not ok, UI shows no evidence; schemaVersion 1.3.0 UPDATE -> check violation; restored doc served", async () => {
    const base = (await dbDoc(ME)).document;
    const seg0 = base.sections.transcript.data.languageSegments[0];
    const variants: Record<string, any> = {
      mixedWithConfidence: { ...seg0, status: "mixed", confidence: 0.9, language: "en" },
      unknownWithLanguage: { startUs: seg0.startUs, endUs: seg0.endUs, method: seg0.method, scope: seg0.scope, model: seg0.model, status: "unknown", language: "ar" },
      wordLanguage: { ...seg0, wordLanguage: "ar" },
      calibratedClaim: { ...seg0, status: "dominant", language: "en", confidence: 0.3 },
    };
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const [name, seg] of Object.entries(variants)) {
      const bad = { ...base, sections: { ...base.sections, transcript: { ...base.sections.transcript, data: { ...base.sections.transcript.data, languageSegments: [seg, ...base.sections.transcript.data.languageSegments.slice(1)] } } } };
      await setDocument(ME, bad);
      const g = await call(owner, "GET", `/projects/${P}/media/${ME}/analysis`);
      const bj = await (await page.request.get(`/api/projects/${P}/media/${ME}/analysis`)).json().catch(() => ({ ok: "non-json" }));
      out[name] = { api: g.status, bffOk: bj?.ok, leaks: leakScan(g.text) };
      ok = ok && g.status >= 400 && bj?.ok !== true && leakScan(g.text).length === 0;
    }
    let versionRejected = false;
    try { await setDocument(ME, { ...base, schemaVersion: "1.3.0" }); } catch (e) { versionRejected = /check/i.test(String(e)); }
    await setDocument(ME, base);
    const restored = await call(owner, "GET", `/projects/${P}/media/${ME}/analysis`);
    out.versionRejected = versionRejected; out.restored = restored.status;
    return { pass: ok && versionRejected && restored.status === 200, actual: out };
  });

  await probe("L6", "Viewer renders dominant / mixed / unknown evidence honestly", "collapsed 'Local language evidence'; disclaimer that contexts do not label words; dominant shows language + 'model score'; mixed shows 'mixed / uncertain'; unknown shows 'unknown'; model name shown; no word-level labels", async () => {
    const base = (await dbDoc(ME)).document;
    const seg0 = base.sections.transcript.data.languageSegments[0];
    const crafted = [
      { ...seg0, startUs: "0", endUs: "4000000", status: "dominant", language: "en", confidence: 0.91 },
      { startUs: "4000000", endUs: "8000000", method: seg0.method, scope: seg0.scope, model: seg0.model, status: "mixed" },
      { startUs: "8000000", endUs: "12000000", method: seg0.method, scope: seg0.scope, model: seg0.model, status: "unknown" },
      { ...seg0, startUs: "12000000", endUs: "15999500", status: "dominant", language: "ar", confidence: 0.5 },
    ];
    const doc = { ...base, sections: { ...base.sections, transcript: { ...base.sections.transcript, data: { ...base.sections.transcript.data, languageSegments: crafted } } } };
    S.parseMediaAnalysis(doc);
    await setDocument(ME, doc);
    const panel = await openPanel(page, P, "qa-en-ar.mp4");
    const details = panel.locator("details");
    const openBefore = await details.evaluate((d) => (d as HTMLDetailsElement).open);
    await panel.getByText("Local language evidence").click();
    const text = await details.innerText();
    await page.screenshot({ path: path.join(OUT, "l6-language-evidence.png"), fullPage: true, mask: [page.locator("header .text-muted"), panel.getByLabel("Transcript").locator("p:not(.text-xs)")] });
    await setDocument(ME, base);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const need = [/0[–-]4s: en \(model score 0\.91\) — faster-whisper-small/, /4[–-]8s: mixed \/ uncertain — faster-whisper-small/, /8[–-]12s: unknown — faster-whisper-small/, /12[–-]15\.9995s: ar \(model score 0\.50\) — faster-whisper-small/, /do not label individual words/];
    const missing = need.filter((r) => !r.test(text)).map(String);
    return { pass: !openBefore && missing.length === 0 && !/confidence|accura/i.test(text), actual: { collapsedByDefault: !openBefore, lines, missing } };
  });

  await probe("L7", "Analysis document (with evidence) authorization", "unauthenticated 401; outsider and nonexistent-asset 404 with identical bodies; BFF for outsider not ok; no evidence or identity leaked", async () => {
    const un = await call(null, "GET", `/projects/${P}/media/${ME}/analysis`);
    const out = await call(outsider, "GET", `/projects/${P}/media/${ME}/analysis`);
    const ghost = await call(owner, "GET", `/projects/${P}/media/${randomUUID().replace(/^(.{14})./, "$17")}/analysis`);
    const ob = await (await outsider.page.request.get(`/api/projects/${P}/media/${ME}/analysis`)).json().catch(() => null);
    const leak = /languageSegments|ct2-source-context|faster-whisper/.test(un.text + out.text + JSON.stringify(ob));
    return { pass: un.status === 401 && out.status === 404 && ghost.status === 404 && out.text === ghost.text && ob?.ok !== true && !leak && leakScan(out.text).length === 0,
      actual: { unauth: un.status, outsider: out.status, nonexistent: ghost.status, identicalBodies: out.text === ghost.text, outsiderBffOk: ob?.ok, evidenceLeaked: leak } };
  });

  await probe("L8", "Migration 0021 applied; CHECK constraint admits exactly 1.0.0/1.1.0/1.2.0; admission trigger still present", "schema_migrations has 0021; constraint text lists 3 versions; analysis_result_admission trigger exists", async () => {
    const m = await q("SELECT id FROM schema_migrations ORDER BY id");
    const [c] = await q("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='media_analyses_document_check'");
    const trg = await q("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('analysis_tasks'::regclass,'media_analyses'::regclass) ORDER BY tgname");
    const ids = m.map((r) => String(r.id));
    return { pass: ids.some((i) => i.includes("0021")) && /1\.0\.0/.test(c?.def) && /1\.1\.0/.test(c?.def) && /1\.2\.0/.test(c?.def) && !/1\.3/.test(c?.def) && trg.some((t) => t.tgname === "analysis_result_admission"),
      actual: { lastMigrations: ids.slice(-3), constraint: c?.def, triggers: trg.map((t) => t.tgname) } };
  });

  writeFileSync(path.join(PRIVATE, "state.json"), JSON.stringify({ ...state, known }));
  await pool.end();
});
