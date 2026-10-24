/** PR #68 independent QA, part A: Issue #62 categories on real PostgreSQL/Redis/BullMQ/S3/AI worker. QA-authored. */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ALLOW, API, INPUTS, OUT, PRIVATE, GetObjectCommand, PutObjectCommand, call, canon, composeWith, dbDoc, docker, failures, holdResultWrite,
  latest, leakScan, newUser, pool, probe, q, retry, s3, setMembership, settled, sleep, tasks, terminal, until, upload, waitApplied, waitStatus,
} from "./helpers68";

test("PR68 part A: failure categories, authorization and lifecycle", async ({ browser }) => {
  const owner = await newUser(browser, "owner"), member = await newUser(browser, "member"), outsider = await newUser(browser, "outsider");
  const page = owner.page;
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill("QA68 independent");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Open project" }).first().click();
  await expect(page.locator("#media-file")).toBeAttached();
  const P = new URL(page.url()).pathname.split("/").pop()!;
  const M = await upload(page, P, path.join(INPUTS, "qa-source.mp4"), []);
  await settled(M);
  writeFileSync(path.join(PRIVATE, "state.json"), JSON.stringify({ P, M, owner: { email: owner.email, password: owner.password } }));
  const known = [M];

  // ---------- A: baseline, contract and privacy ----------
  await probe("A1", "Healthy asset: document unchanged (1.1.0), failures endpoint empty, private/no-store, BFF parity", "doc 200 schemaVersion 1.1.0; /failures 200 {failures:[]} with exact keys; BFF ok:true with same data", async () => {
    const d = await call(owner, "GET", `/projects/${P}/media/${M}/analysis`);
    const f = await failures(owner, P, M);
    const bff = await page.request.get(`/api/projects/${P}/media/${M}/analysis/failures`);
    const bj = await bff.json();
    const keys = Object.keys(f.json ?? {}).sort().join(",");
    return { pass: d.status === 200 && d.json.schemaVersion === "1.1.0" && f.status === 200 && keys === "failures,mediaAssetId,sourceSha256" && f.json.failures.length === 0 &&
        f.json.sourceSha256 === d.json.source.sha256 && /private/.test(f.headers["cache-control"]) && /no-store/.test(f.headers["cache-control"]) && bj.ok === true && canon(bj.data) === canon(f.json),
      actual: { docStatus: d.status, schemaVersion: d.json?.schemaVersion, failuresStatus: f.status, keys, failures: f.json?.failures, cacheControl: f.headers["cache-control"], bffOk: bj.ok, bffEqual: canon(bj.data) === canon(f.json) } };
  });
  await probe("A2", "Failures endpoint authorization and existence-hiding", "unauth 401; outsider/no-member/nonexistent all 404 with byte-identical bodies; malformed id 400", async () => {
    const un = await failures(null, P, M), out = await failures(outsider, P, M), mem = await failures(member, P, M);
    const ghost = await failures(owner, P, randomUUID().replace(/^(.{14})./, "$17"));
    const otherProject = await failures(outsider, randomUUID(), M);
    const bad = await call(owner, "GET", `/projects/${P}/media/not-a-uuid/analysis/failures`);
    const same = new Set([out.text, mem.text, ghost.text, otherProject.text]).size === 1;
    return { pass: un.status === 401 && out.status === 404 && mem.status === 404 && ghost.status === 404 && otherProject.status === 404 && same && bad.status === 400,
      actual: { unauth: un.status, outsider: out.status, nonMember: mem.status, nonexistentAsset: ghost.status, foreignProject: otherProject.status, identical404Bodies: same, malformed: bad.status, bodySample: out.text.slice(0, 120) } };
  });

  // ---------- B: authorization revocation ----------
  await probe("B1", "Revocation while the editor's transcript job is running -> authorization_revoked (persisted, safe, isolated)", "job not Completed; failure_category authorization_revoked; owner /failures shows allowlisted message, retryable false; legacy doc code unavailable; audio intact; revoked user 404", async () => {
    await setMembership(P, member.id, "editor");
    await waitApplied((await latest(M, "transcript")).job_id);
    const before = await dbDoc(M);
    const r = await retry(member, M, "transcript", (await latest(M, "transcript")).job_id);
    if (r.status >= 300) return { pass: false, actual: { retry: r.status } };
    const J = r.json.jobId;
    const s0 = await waitStatus(J, (s) => s === "Running" || terminal(s), 180_000, 50);
    if (s0 !== "Running") return { pass: null, actual: `job reached ${s0} before revocation could be applied mid-run` };
    await setMembership(P, member.id, null);
    const final = await waitStatus(J, terminal, 300_000, 500);
    await waitApplied(J).catch(() => null);
    const [t] = await q("SELECT failure_category,result IS NOT NULL AS has_result,failure FROM analysis_tasks WHERE job_id=$1", [J]);
    const f = await failures(owner, P, M), mf = await failures(member, P, M);
    const d = await dbDoc(M);
    const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
    const restore = await retry(owner, M, "transcript", J); if (restore.json?.jobId) await waitApplied(restore.json.jobId);
    return { pass: final !== "Completed" && t.failure_category === "authorization_revoked" && !t.has_result && tr?.category === "authorization_revoked" && tr?.message === ALLOW.authorization_revoked &&
        tr?.retryable === false && d.document.sections.transcript.failure?.code === "unavailable" && canon(d.document.sections.audio) === canon(before.document.sections.audio) && mf.status === 404 && leakScan(f.text, [member.email]).length === 0,
      actual: { jobStatus: final, persistedCategory: t.failure_category, resultStored: t.has_result, detail: tr, legacyDocFailure: d.document.sections.transcript.failure, audioIntact: canon(d.document.sections.audio) === canon(before.document.sections.audio), revokedUserFailures: mf.status, leaks: leakScan(f.text, [member.email]) } };
  });
  await probe("B2", "Revocation AFTER inference produced output but BEFORE publication (result write held by row lock) -> authorization_revoked", "worker's result UPDATE observed blocked; after revoke+release: no result, failure_category authorization_revoked, owner sees allowlisted message", async () => {
    await setMembership(P, member.id, "editor");
    await waitApplied((await latest(M, "transcript")).job_id);
    const r = await retry(member, M, "transcript", (await latest(M, "transcript")).job_id);
    if (r.status >= 300) return { pass: false, actual: { retry: r.status } };
    const J = r.json.jobId;
    await waitStatus(J, (s) => s === "Running" || terminal(s), 180_000, 50);
    const hold = await holdResultWrite(J);
    if (!hold) return { pass: null, actual: "could not hold the result write (job finished first)" };
    await setMembership(P, member.id, null);
    await hold.release();
    const final = await waitStatus(J, terminal, 300_000, 500);
    await waitApplied(J).catch(() => null);
    const [t] = await q("SELECT failure_category,result IS NOT NULL AS has_result FROM analysis_tasks WHERE job_id=$1", [J]);
    const f = await failures(owner, P, M);
    const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
    const restore = await retry(owner, M, "transcript", J); if (restore.json?.jobId) await waitApplied(restore.json.jobId);
    return { pass: final !== "Completed" && !t.has_result && t.failure_category === "authorization_revoked" && tr?.category === "authorization_revoked",
      actual: { heldStatement: hold.blockedStatement, jobStatus: final, persistedCategory: t.failure_category, resultStored: t.has_result, detail: tr } };
  });

  // ---------- C: transport unavailability and true invalid input ----------
  await probe("C1", "S3 unavailable during transcript retry -> analyzer_unavailable (retryable), then recovery clears the failure on the next generation", "terminal non-Completed; category analyzer_unavailable; retry after S3 restored completes and /failures no longer lists transcript", async () => {
    await waitApplied((await latest(M, "transcript")).job_id);
    docker("stop", "editagent-seaweed-s3");
    let J = "", final = "", t: any, f: any, attempts = 0;
    try {
      const r = await retry(owner, M, "transcript", (await latest(M, "transcript")).job_id);
      J = r.json?.jobId;
      final = await waitStatus(J, terminal, 600_000, 1000);
    } finally { docker("start", "editagent-seaweed-s3"); await sleep(8000); }
    await waitApplied(J).catch(() => null);
    [t] = await q("SELECT failure_category,failure,(SELECT count(*)::int FROM job_attempts a WHERE a.job_id=$1) AS attempts FROM analysis_tasks WHERE job_id=$1", [J]);
    f = await failures(owner, P, M);
    const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
    const again = await retry(owner, M, "transcript", J);
    const okAgain = again.json?.jobId ? await waitApplied(again.json.jobId) : null;
    const f2 = await failures(owner, P, M);
    return { pass: final !== "Completed" && t.failure_category === "analyzer_unavailable" && tr?.category === "analyzer_unavailable" && okAgain === "Completed" &&
        !f2.json.failures.some((x: any) => x.analyzer === "transcript"),
      actual: { jobStatus: final, attempts: t.attempts, persistedCategory: t.failure_category, persistedFailure: t.failure, detail: tr, recoveryJob: okAgain, failuresAfterRecovery: f2.json?.failures } };
  });
  await probe("C2", "Tampered staged audio derivative (identity mismatch) -> invalid_input, distinct from timeout/unavailable", "category invalid_input, code invalid_input, retryable false; restoring the bytes and retrying completes", async () => {
    await waitApplied((await latest(M, "transcript")).job_id);
    const prev = await latest(M, "transcript");
    const [k] = await q("SELECT d.storage_key FROM analysis_tasks t JOIN derived_assets d ON d.id=t.input_artifact_id WHERE t.job_id=$1", [prev.job_id]);
    const original = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: "editagent", Key: k.storage_key }))).Body.transformToByteArray());
    const tampered = Buffer.from(original); for (let i = 200; i < tampered.length; i += 997) tampered[i] ^= 0x5a;
    await s3.send(new PutObjectCommand({ Bucket: "editagent", Key: k.storage_key, Body: tampered }));
    let J = "", final = "";
    try {
      const r = await retry(owner, M, "transcript", prev.job_id);
      J = r.json?.jobId; final = await waitStatus(J, terminal, 420_000, 500);
    } finally { await s3.send(new PutObjectCommand({ Bucket: "editagent", Key: k.storage_key, Body: original })); }
    await waitApplied(J).catch(() => null);
    const [t] = await q("SELECT failure_category,failure FROM analysis_tasks WHERE job_id=$1", [J]);
    const f = await failures(owner, P, M);
    const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
    const again = await retry(owner, M, "transcript", J);
    const okAgain = again.json?.jobId ? await waitApplied(again.json.jobId) : null;
    return { pass: final === "Failed" && t.failure_category === "invalid_input" && tr?.code === "invalid_input" && tr?.retryable === false && okAgain === "Completed",
      actual: { jobStatus: final, persistedCategory: t.failure_category, persistedFailure: t.failure, detail: tr, restoredRetry: okAgain } };
  });

  // ---------- D: deadlines ----------
  let MT = "";
  await probe("D1", "Operator timeout 4 s: transcript -> timeout (persisted), audio completes; UI shows only the allowlisted message", "category timeout, code timeout, retryable false; audio completed; analysis panel text = allowlist; no leak markers", async () => {
    composeWith({ EDITAGENT_ASR_TIMEOUT_MS: "4000" }, "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "media-worker", "ai-worker");
    try {
      MT = await upload(page, P, path.join(INPUTS, "qa-timeout.mp4"), known); known.push(MT);
      const { t, d } = await settled(MT);
      const tt = t.filter((x: any) => x.analyzer === "transcript").at(-1);
      const f = await failures(owner, P, MT);
      const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
      await page.goto(`/projects/${P}`);
      const card = page.getByRole("region", { name: "Media Library" }).locator("div")
        .filter({ hasText: "qa-timeout.mp4" }).filter({ has: page.getByRole("button", { name: "View analysis" }) }).last();
      await card.getByRole("button", { name: "View analysis" }).click();
      const panel = page.getByRole("region", { name: "Media analysis" });
      await expect(panel).toContainText(ALLOW.timeout, { timeout: 60_000 });
      const uiText = await panel.innerText();
      await page.screenshot({ path: path.join(OUT, "d1-timeout-analysis.png"), fullPage: true, mask: [page.locator("header .text-muted"), panel.locator('p[dir="auto"]')] });
      return { pass: tt.failure_category === "timeout" && tr?.category === "timeout" && tr?.code === "timeout" && tr?.retryable === false && d.document.sections.audio.status === "completed" && leakScan(uiText).length === 0,
        actual: { jobStatus: tt.status, failureReason: tt.failure_reason, persistedCategory: tt.failure_category, detail: tr, audio: d.document.sections.audio.status, uiShowsAllowlist: uiText.includes(ALLOW.timeout), uiLeaks: leakScan(uiText) } };
    } finally { composeWith({ EDITAGENT_ASR_TIMEOUT_MS: "45000" }, "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "media-worker", "ai-worker"); }
  });
  await probe("D2", "Deadline expires after output generated but before publication (45 s operator deadline, result write held) -> timeout, nothing published", "result write observed blocked; released after deadline; no result; category timeout", async () => {
    let MD = "";
    try {
      MD = await upload(page, P, path.join(INPUTS, "qa-deadline.mp4"), known); known.push(MD);
      await settled(MD);
      const r = await retry(owner, MD, "transcript", (await latest(MD, "transcript")).job_id);
      const J = r.json?.jobId;
      await waitStatus(J, (s) => s === "Running" || terminal(s), 120_000, 50);
      const hold = await holdResultWrite(J, 40_000);
      if (!hold) return { pass: null, actual: "result write not observed before 40 s" };
      const [dl] = await q("SELECT deadline_at_ms::bigint - (extract(epoch FROM clock_timestamp())*1000)::bigint AS remaining FROM analysis_tasks WHERE job_id=$1", [J]);
      await sleep(Math.max(0, Number(dl.remaining)) + 3000);
      await hold.release();
      const final = await waitStatus(J, terminal, 180_000, 500);
      await waitApplied(J).catch(() => null);
      const [t] = await q("SELECT failure_category,result IS NOT NULL AS has_result FROM analysis_tasks WHERE job_id=$1", [J]);
      const tr = (await failures(owner, P, MD)).json?.failures?.find((x: any) => x.analyzer === "transcript");
      return { pass: !t.has_result && t.failure_category === "timeout" && tr?.category === "timeout",
        actual: { heldStatement: hold.blockedStatement, jobStatus: final, persistedCategory: t.failure_category, resultStored: t.has_result, detail: tr } };
    } finally { composeWith({ EDITAGENT_ASR_TIMEOUT_MS: "600000" }, "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "media-worker", "ai-worker"); }
  });

  // ---------- E: project deletion (fencing / cancellation) ----------
  async function newProject(name: string) {
    const r = await call(owner, "POST", "/projects", { name });
    return r.json.id as string;
  }
  await probe("E1", "Project deleted after initial (system-initiated) transcript output but before publication -> publication_fenced/cancelled, nothing published", "result write held; DELETE project; no result; category in {publication_fenced,cancelled}; owner /failures 404 (project gone)", async () => {
    const P2 = await newProject("QA68 fence");
    const M2 = await upload(page, P2, path.join(INPUTS, "qa-delete-locked.mp4"), []);
    const J = await until(async () => (await tasks(M2)).find((x: any) => x.analyzer === "transcript" && x.generation === 1)?.job_id, 300_000, "initial transcript task");
    await waitStatus(J, (s) => s === "Running" || terminal(s), 300_000, 50);
    const hold = await holdResultWrite(J);
    if (!hold) return { pass: null, actual: "initial transcript finished before the result write could be held" };
    const del = await call(owner, "DELETE", `/projects/${P2}`);
    await hold.release();
    const final = await waitStatus(J, terminal, 300_000, 500).catch(() => "TIMEOUT");
    await sleep(10_000);
    const [t] = await q("SELECT failure_category,result IS NOT NULL AS has_result,applied FROM analysis_tasks WHERE job_id=$1", [J]);
    const f = await failures(owner, P2, M2);
    return { pass: !t.has_result && ["publication_fenced", "cancelled"].includes(t.failure_category) && f.status === 404,
      actual: { deleteStatus: del.status, jobStatus: final, persistedCategory: t.failure_category, resultStored: t.has_result, applied: t.applied, failuresAfterDelete: f.status } };
  });
  await probe("E2", "Project deleted while transcript inference is running (no lock) -> fail-closed category recorded", "no result published; category is one of the bounded set (observed)", async () => {
    const P3 = await newProject("QA68 cancel");
    const M3 = await upload(page, P3, path.join(INPUTS, "qa-delete-running.mp4"), []);
    const J = await until(async () => (await tasks(M3)).find((x: any) => x.analyzer === "transcript")?.job_id, 300_000, "transcript task");
    const s0 = await waitStatus(J, (s) => s === "Running" || terminal(s), 300_000, 50);
    const del = await call(owner, "DELETE", `/projects/${P3}`);
    const final = await waitStatus(J, terminal, 300_000, 500).catch(() => "TIMEOUT");
    await sleep(10_000);
    const [t] = await q("SELECT failure_category,result IS NOT NULL AS has_result FROM analysis_tasks WHERE job_id=$1", [J]);
    return { pass: s0 === "Running" ? !t.has_result && Object.keys(ALLOW).includes(t.failure_category) : null,
      actual: { observedBeforeDelete: s0, deleteStatus: del.status, jobStatus: final, persistedCategory: t.failure_category, resultStored: t.has_result } };
  });

  // ---------- F: compatibility and invariants ----------
  await probe("F1", "Pre-migration rows (failure_category NULL) remain readable with a bounded derived category", "NULL category on a terminal failed task -> /failures returns an allowlisted category; row restored", async () => {
    const failed = (await tasks(MT)).filter((x: any) => x.analyzer === "transcript" && x.status !== "Completed").at(-1);
    if (!failed) return { pass: null, actual: "no failed task available" };
    const saved = failed.failure_category;
    const upd = await q("UPDATE analysis_tasks SET failure_category=NULL WHERE job_id=$1 RETURNING job_id", [failed.job_id]).then(() => "ok", (e) => String(e.message).slice(0, 100));
    const f = await failures(owner, P, MT);
    const tr = f.json?.failures?.find((x: any) => x.analyzer === "transcript");
    await q("UPDATE analysis_tasks SET failure_category=$2 WHERE job_id=$1", [failed.job_id, saved]).catch(() => null);
    return { pass: upd === "ok" ? f.status === 200 && Object.keys(ALLOW).includes(tr?.category) && tr?.message === ALLOW[tr?.category] : null,
      actual: { update: upd, jobStatus: failed.status, failureReason: failed.failure_reason, derivedCategory: tr?.category, message: tr?.message } };
  });
  await probe("F2", "Migration column constraint rejects unknown categories", "UPDATE failure_category='secret_detail' fails with a check violation", async () => {
    const any = (await tasks(M))[0];
    const r = await q("UPDATE analysis_tasks SET failure_category='secret_detail' WHERE job_id=$1", [any.job_id]).then(() => "ACCEPTED", (e) => e.code);
    return { pass: r === "23514", actual: { result: r } };
  });
  await probe("F3", "Generation fencing and immutable intent preserved", "document transcript equals newest completed generation; no non-completed task holds a result; deadline intent still immutable", async () => {
    await settled(M);
    const t = await tasks(M), d = await dbDoc(M);
    const [tr] = await q("SELECT result FROM analysis_tasks WHERE media_asset_id=$1 AND analyzer='transcript' ORDER BY generation DESC LIMIT 1", [M]);
    const imm = await q("UPDATE analysis_tasks SET deadline_at_ms=0 WHERE job_id=$1", [t[0].job_id]).then(() => "mutated", (e) => String(e.message).slice(0, 60));
    return { pass: canon(tr.result) === canon(d.document.sections.transcript) && t.filter((x: any) => x.status !== "Completed" && x.has_result).length === 0 && imm !== "mutated",
      actual: { newestEqualsDocument: canon(tr.result) === canon(d.document.sections.transcript), generations: t.map((x: any) => `${x.analyzer}:${x.generation}:${x.status}${x.failure_category ? ":" + x.failure_category : ""}`), intentMutation: imm } };
  });
  await probe("F4", "Durable details survive API + workers restart", "/failures and document identical after restart", async () => {
    const a = (await failures(owner, P, MT)).text, b = (await call(owner, "GET", `/projects/${P}/media/${M}/analysis`)).text;
    docker("compose", "restart", "api", "media-worker", "ai-worker");
    docker("compose", "up", "-d", "--no-build", "--wait", "--wait-timeout", "300", "api", "media-worker", "ai-worker");
    const a2 = await until(async () => { const r = await failures(owner, P, MT); return r.status === 200 ? r.text : null; }, 120_000, "api back");
    const b2 = (await call(owner, "GET", `/projects/${P}/media/${M}/analysis`)).text;
    return { pass: a === a2 && b === b2, actual: { failuresIdentical: a === a2, documentIdentical: b === b2 } };
  });
  writeFileSync(path.join(PRIVATE, "state.json"), JSON.stringify({ P, M, known, owner: { email: owner.email, password: owner.password } }));
  await pool.end();
});
