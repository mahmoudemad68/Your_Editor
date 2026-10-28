import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { parseMediaAnalysis } from "@editagent/schemas";
import type { EditorTimeline } from "../src/editor-contract";

/** Real browser/services/native Small only. No route mocks, preinserted words or fake jobs. */
test("QA93-F1 real Small captions, rapid edits, restart, boundary cuts and exports", async ({
  page,
}) => {
  const root = path.resolve(__dirname, "../../.."),
    privateDir = path.join(root, ".local/caption-repair-private"),
    publicDir = path.join(root, ".local/caption-public");
  await mkdir(privateDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  let phase = "authentication";
  try {
    await page.goto("/sign-up");
    await page.getByLabel("Email", { exact: true }).fill(`caption-${randomUUID()}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill(`Test-only-${randomUUID()}!`);
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create project", exact: true }).first().click();
    await page.getByLabel("Project name", { exact: true }).fill("Caption edit restart regression");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "Open project" }).click();
    const projectId = new URL(page.url()).pathname.split("/").pop()!;
    phase = "upload-inspection";
    await page.locator("#media-file").setInputFiles(path.join(privateDir, "source.mp4"));
    await expect(
      page.getByRole("region", { name: "Inspection job" }).getByText("Completed", { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    const library = page.getByRole("region", { name: "Media Library" });
    const link = library.getByRole("link", { name: "Edit video" });
    await expect(link).toBeVisible({ timeout: 60000 });
    const href = await link.getAttribute("href"),
      assetId = new URL(href!, page.url()).searchParams.get("media")!;
    phase = "real-small-analysis";
    await library.getByRole("button", { name: "View analysis" }).click();
    let document: ReturnType<typeof parseMediaAnalysis> | null = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const response = await page.request.get(
        `/api/projects/${projectId}/media/${assetId}/analysis`,
      );
      if (response.ok()) {
        const d = parseMediaAnalysis((await response.json()).data);
        if (
          d.sections.transcript.status === "completed" &&
          d.sections.audio.status === "completed"
        ) {
          document = d;
          break;
        }
      }
      await page.waitForTimeout(500);
    }
    expect(document?.sections?.transcript?.status).toBe("completed");
    if (!document || document.sections.transcript.status !== "completed")
      throw new Error("Completed analysis is unavailable.");
    const transcript = document.sections.transcript,
      model = transcript.provenance.model;
    if (!model) throw new Error("Model identity is unavailable.");
    expect(model.name).toBe("faster-whisper-small");
    expect(model.sha256).toBe("4e456821bbeabf0923f07220a86c1c14a8820bc83e78ae638d4474207b70aedd");
    // Counts/hashes only in reports. The original licensed EN/AR source identities
    // establish bilingual input; recognized text is never a language detector here.
    const words = transcript.data.segments.flatMap((s) => s.words);
    expect(words.filter((w) => BigInt(w.startUs) < 8000000n).length).toBeGreaterThan(4);
    expect(words.filter((w) => BigInt(w.startUs) >= 8000000n).length).toBeGreaterThan(4);
    phase = "caption-tool-persistence";
    await link.click();
    await page.getByRole("button", { name: "Create timeline from video", exact: true }).click();
    const timeline = page.getByRole("region", { name: "Timeline" });
    await expect(timeline).toBeVisible();
    const timelineId = (await timeline.getAttribute("data-timeline-id"))!;
    const original = await timeline.getAttribute("data-timeline-sha256");
    await page.getByRole("button", { name: "Add word-synchronized captions", exact: true }).click();
    const panel = page.getByRole("region", { name: "Word-synchronized captions" });
    await expect(panel.getByRole("status")).toContainText("saved caption blocks", {
      timeout: 15000,
    });
    const read = async () => {
      const r = await page.request.get(`/api/projects/${projectId}/editor/${timelineId}`);
      expect(r.ok()).toBe(true);
      return (await r.json()).data as EditorTimeline;
    };
    let saved = await read();
    expect(saved.stateSha256).not.toBe(original);
    const caption = saved.timeline.captionsV1?.[0];
    if (!caption) throw new Error("Caption persistence is unavailable.");
    expect(caption.style.fontSize).toBe(25);
    expect(caption.evidence.kind).toBe("media-analysis");
    expect(caption.sourceSha256).toBe(document.source.sha256);
    const projected = caption.blocks.flatMap((b) => b.lines.flat());
    const expected = words.map((w) => ({
      text: w.text,
      startUs: w.startUs,
      endUs: w.endUs,
      confidence: w.confidence ?? null,
    }));
    expect(projected).toEqual(expected);
    const tupleHash = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
    const qaTupleHash = createHash("sha256")
      .update(
        JSON.stringify(
          expected.map((word) => [word.startUs, word.endUs, word.confidence, word.text]),
        ),
      )
      .digest("hex");
    // Real response latency, no route interception or fake service response.
    // Exercise rapid user edits while a real style response is still in flight.
    const network = await page.context().newCDPSession(page);
    await network.send("Network.enable");
    await network.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 250,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.getByLabel("Caption highlight color").fill("#00ffff");
    await page.getByRole("button", { name: "Update caption style", exact: true }).click();
    await page.getByLabel("Trim end (timeline seconds)").fill("12");
    await page.getByRole("button", { name: "Apply trim", exact: true }).click();
    await page.getByLabel("Split at (timeline seconds)").fill("6");
    await page.getByRole("button", { name: "Split clip", exact: true }).click();
    await expect(timeline.locator("[data-clip-id]")).toHaveCount(2);
    await network.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await network.detach();
    saved = await read();
    expect(
      saved.timeline.tracks.flatMap((track) =>
        track.clips.map((clip) => [clip.inPoint, clip.outPoint, clip.timelineStartUs]),
      ),
    ).toEqual([
      ["0", "6000000", "0"],
      ["6000000", "12000000", "6000000"],
    ]);
    const editedHash = saved.stateSha256;
    // An intervening clip edit makes the old caption receipt stale. It must not
    // overwrite newer edits; independently verify the rejected undo is unchanged.
    const rejectedUndo = page.waitForResponse(
      (r) =>
        r.url().includes("/captions/") &&
        r.url().endsWith("/undo") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Undo last caption edit", exact: true }).click();
    expect((await rejectedUndo).status()).toBe(409);
    expect((await read()).stateSha256).toBe(editedHash);
    // A current-state caption command remains genuinely undoable after clip edits.
    await page.getByLabel("Caption highlight color").fill("#00ff00");
    await page.getByRole("button", { name: "Update caption style", exact: true }).click();
    await expect
      .poll(async () => (await read()).timeline.captionsV1?.[0]?.style.highlight)
      .toBe("#00ff00");
    await page.getByRole("button", { name: "Undo last caption edit", exact: true }).click();
    await expect.poll(async () => (await read()).stateSha256).toBe(editedHash);
    saved = await read();
    const savedHash = saved.stateSha256;
    expect(saved.timeline.captionsV1?.[0]?.blocks).toEqual(caption.blocks);
    phase = "api-restart-and-reload";
    await writeFile(
      path.join(privateDir, "restart-checkpoint.json"),
      JSON.stringify({
        projectId,
        timelineId,
        stateSha256: savedHash,
        timeline: saved.timeline,
        sourceSha256: document.source.sha256,
        wordTupleSha256: tupleHash,
        qaOrderedTupleSha256: qaTupleHash,
        requestedTrimEndUs: "12000000",
        requestedSplitAtUs: "6000000",
        controlledResponseLatencyMs: 250,
        wordCount: words.length,
        model,
      }),
      { mode: 0o600 },
    );
    await expect
      .poll(
        async () => readFile(path.join(privateDir, "api-restarted.json"), "utf8").catch(() => ""),
        { timeout: 45000 },
      )
      .toBe("ready");
    await page.reload();
    await expect(timeline).toHaveAttribute("data-timeline-sha256", savedHash);
    expect((await read()).timeline).toEqual(saved.timeline);
    await page.screenshot({
      path: path.join(publicDir, "repair-saved.png"),
      fullPage: true,
      mask: [page.locator("header .text-muted")],
    });
    phase = "real-remotion-render";
    await page.getByRole("button", { name: "Render saved timeline", exact: true }).click();
    const job = page.getByRole("region", { name: "Export job" });
    await expect(job.getByRole("status")).toHaveText("Completed", { timeout: 180000 });
    const jobId = await job.getAttribute("data-export-job-id");
    await page.getByRole("button", { name: "Open export", exact: true }).click();
    const video = page.getByLabel("Rendered export");
    await expect(video).toBeVisible();
    await video.evaluate(async (n) => {
      const v = n as HTMLVideoElement;
      v.muted = true;
      await v.play();
    });
    await expect
      .poll(() => video.evaluate((n) => (n as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0.5);
    await video.evaluate((n) => {
      const v = n as HTMLVideoElement;
      v.pause();
      v.currentTime = 9;
    });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(publicDir, "repair-playback.png"),
      fullPage: true,
      mask: [page.locator("header .text-muted")],
    });
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download MP4", exact: true }).click();
    const file = await download;
    await file.saveAs(path.join(privateDir, "repair-export.mp4"));
    expect(await file.failure()).toBeNull();
    // Isolate the render contract from input races: intentionally cut the same
    // REAL analysis at the 8-second source-component boundary in a fresh saved
    // timeline. No replacement words, injected snapshots or fabricated Jobs.
    phase = "explicit-source-boundary-render-regression";
    await page.goto(new URL(href!, page.url()).toString());
    await page.getByRole("button", { name: "Create timeline from video", exact: true }).click();
    await expect(timeline).toBeVisible();
    const boundaryTimelineId = (await timeline.getAttribute("data-timeline-id"))!;
    expect(boundaryTimelineId).not.toBe(timelineId);
    await page.getByRole("button", { name: "Add word-synchronized captions", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("saved caption blocks", {
      timeout: 15000,
    });
    const readBoundary = async () => {
      const response = await page.request.get(
        `/api/projects/${projectId}/editor/${boundaryTimelineId}`,
      );
      expect(response.ok()).toBe(true);
      return (await response.json()).data as EditorTimeline;
    };
    await page.getByLabel("Caption highlight color").fill("#00ffff");
    await page.getByRole("button", { name: "Update caption style", exact: true }).click();
    await expect
      .poll(async () => (await readBoundary()).timeline.captionsV1?.[0]?.style.highlight)
      .toBe("#00ffff");
    await page.getByLabel("Split at (timeline seconds)").fill("8");
    await page.getByRole("button", { name: "Split clip", exact: true }).click();
    await expect(timeline.locator("[data-clip-id]")).toHaveCount(2);
    const boundarySaved = await readBoundary();
    expect(
      boundarySaved.timeline.tracks.flatMap((track) =>
        track.clips.map((clip) => [clip.inPoint, clip.outPoint, clip.timelineStartUs]),
      ),
    ).toEqual([
      ["0", "8000000", "0"],
      ["8000000", "16000000", "8000000"],
    ]);
    expect(
      boundarySaved.timeline.captionsV1?.[0]?.blocks.flatMap((block) => block.lines.flat()),
    ).toEqual(expected);
    expect(boundarySaved.timeline.captionsV1?.[0]?.evidence).toEqual(caption.evidence);
    await page.reload();
    await expect(timeline).toHaveAttribute("data-timeline-sha256", boundarySaved.stateSha256);
    await page.getByRole("button", { name: "Render saved timeline", exact: true }).click();
    await expect(job.getByRole("status")).toHaveText("Completed", { timeout: 180000 });
    await page.getByRole("button", { name: "Open export", exact: true }).click();
    await expect(video).toBeVisible();
    await video.evaluate(async (n) => {
      const v = n as HTMLVideoElement;
      v.muted = true;
      await v.play();
    });
    await expect
      .poll(() => video.evaluate((n) => (n as HTMLVideoElement).currentTime))
      .toBeGreaterThan(0.5);
    const boundaryDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download MP4", exact: true }).click();
    const boundaryFile = await boundaryDownload;
    await boundaryFile.saveAs(path.join(privateDir, "repair-boundary-export.mp4"));
    expect(await boundaryFile.failure()).toBeNull();
    await writeFile(
      path.join(privateDir, "browser-result.json"),
      JSON.stringify(
        {
          status: "PASS",
          projectId,
          timelineId,
          jobId,
          stateSha256: savedHash,
          sourceSha256: document.source.sha256,
          wordTupleSha256: tupleHash,
          wordCount: words.length,
          blocks: caption.blocks.length,
          actualUpload: true,
          actualAnalysis: true,
          actualTool: true,
          persistedAndReloaded: true,
          actualUndo: true,
          staleUndoFenced: true,
          apiRestarted: true,
          trimmedAtUs: "12000000",
          splitAtUs: "6000000",
          actualRender: true,
          actualPlayback: true,
          actualDownload: true,
          mockData: false,
          caption,
          timeline: saved.timeline,
          boundaryRegression: {
            timelineId: boundaryTimelineId,
            stateSha256: boundarySaved.stateSha256,
            timeline: boundarySaved.timeline,
            actualTool: true,
            actualRender: true,
            actualPlayback: true,
            actualDownload: true,
          },
          model,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  } catch (error) {
    await writeFile(path.join(privateDir, "browser-error.txt"), String(error), { mode: 0o600 });
    await writeFile(
      path.join(privateDir, "browser-result.json"),
      JSON.stringify({ status: "FAIL", phase }) + "\n",
    );
  }
  // The original assertion operands/cause remain only in the private error file.
  throw new Error(`Caption browser proof failed at ${phase}; private details are not published.`);
});
