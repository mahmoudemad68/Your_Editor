import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Real services only. No page.route, fixture server, DB insertion or mocked job completion. */
test("graduation upload → inspection → analysis → edit → render → download", async ({ page }) => {
  const root = path.resolve(__dirname, "../../..");
  const privateDir = path.join(root, ".local/graduation-demo/private");
  const publicDir = path.join(root, ".local/graduation-demo-public");
  await mkdir(privateDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  let phase = "authentication";
  try {
    await page.goto("/sign-up");
    await page.getByLabel("Email", { exact: true }).fill(`demo-${randomUUID()}@example.test`);
    await page.getByLabel("Password", { exact: true }).fill(`Test-only-${randomUUID()}!`);
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create project", exact: true }).first().click();
    await page.getByLabel("Project name", { exact: true }).fill("Graduation demonstration");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("link", { name: "Open project" }).click();
    await expect(page.locator("#media-file")).toBeAttached();
    const projectId = new URL(page.url()).pathname.split("/").pop()!;

    phase = "upload-and-inspection";
    await page
      .locator("#media-file")
      .setInputFiles(path.join(root, ".local/graduation-demo/demo-input.mp4"));
    await expect(
      page.getByRole("region", { name: "Inspection job" }).getByText("Completed", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const library = page.getByRole("region", { name: "Media Library" });
    await expect(library.getByRole("link", { name: "Edit video" })).toBeVisible({
      timeout: 60_000,
    });
    const editHref = await library.getByRole("link", { name: "Edit video" }).getAttribute("href");
    const mediaAssetId = new URL(editHref!, page.url()).searchParams.get("media");
    const hideAccount = page.locator("header .text-muted");
    await page.screenshot({
      path: path.join(publicDir, "upload-inspection.png"),
      fullPage: true,
      mask: [hideAccount],
    });

    phase = "real-analysis";
    await library.getByRole("button", { name: "View analysis" }).click();
    const analysis = page.getByRole("region", { name: "Media analysis" });
    await expect(analysis).toBeVisible();
    let complete = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      // Inspect existence only. No recognized text enters assertions, reports or traces.
      complete = await analysis
        .locator('p[dir="auto"]')
        .evaluateAll((nodes) => nodes.some((n) => Boolean(n.textContent?.trim())));
      complete =
        complete &&
        (await analysis
          .locator("dd")
          .evaluateAll(
            (nodes) =>
              nodes.length === 2 && nodes.every((node) => node.textContent?.trim() === "completed"),
          ));
      if (complete) break;
      await analysis.getByRole("button", { name: "Refresh analysis" }).click();
      await page.waitForTimeout(1000);
    }
    expect(complete).toBe(true);
    const analysisResponse = await page.request.get(
      `/api/projects/${projectId}/media/${mediaAssetId}/analysis`,
    );
    expect(analysisResponse.ok()).toBe(true);
    const document = (await analysisResponse.json()).data;
    const model = document.sections.transcript.provenance.model;
    expect(model.name).toBe("faster-whisper-small");
    expect(model.sha256).toBe("4e456821bbeabf0923f07220a86c1c14a8820bc83e78ae638d4474207b70aedd");
    await page.screenshot({
      path: path.join(publicDir, "analysis-status.png"),
      fullPage: true,
      mask: [hideAccount, analysis.locator('p[dir="auto"]')],
    });

    phase = "timeline-editing";
    await library.getByRole("link", { name: "Edit video" }).click();
    await page.getByRole("button", { name: "Create timeline from video" }).click();
    const timeline = page.getByRole("region", { name: "Timeline" });
    await expect(timeline).toBeVisible();
    const originalHash = await timeline.getAttribute("data-timeline-sha256");
    await page.getByLabel("Trim start (timeline seconds)").fill("0.2");
    await page.getByLabel("Trim end (timeline seconds)").fill("7.8");
    await page.getByRole("button", { name: "Apply trim", exact: true }).click();
    await expect
      .poll(async () => (await timeline.getAttribute("data-timeline-sha256")) !== originalHash)
      .toBe(true);
    await page.getByLabel("Split at (timeline seconds)").fill("4");
    await page.getByRole("button", { name: "Split clip", exact: true }).click();
    await expect(timeline.locator("[data-clip-id]")).toHaveCount(2);
    const timelineId = await timeline.getAttribute("data-timeline-id");
    const editedHash = await timeline.getAttribute("data-timeline-sha256");
    await page.reload();
    await expect(timeline.locator("[data-clip-id]")).toHaveCount(2);
    await expect(timeline).toHaveAttribute("data-timeline-sha256", editedHash!);
    await page.screenshot({
      path: path.join(publicDir, "timeline.png"),
      fullPage: true,
      mask: [hideAccount],
    });

    phase = "production-render";
    await page.getByRole("button", { name: "Render saved timeline" }).click();
    const job = page.getByRole("region", { name: "Export job" });
    await expect(job.getByRole("status")).toHaveText("Completed", { timeout: 180_000 });
    const jobId = await job.getAttribute("data-export-job-id");
    await page.getByRole("button", { name: "Open export", exact: true }).click();
    const video = page.getByLabel("Rendered export");
    await expect(video).toBeVisible();
    phase = "playback-and-download";
    await video.evaluate(async (node) => {
      const player = node as HTMLVideoElement;
      player.muted = true;
      await player.play();
    });
    await expect
      .poll(async () => video.evaluate((node) => (node as HTMLVideoElement).currentTime > 0.5))
      .toBe(true);
    await video.evaluate((node) => (node as HTMLVideoElement).pause());
    await page.screenshot({
      path: path.join(publicDir, "export.png"),
      fullPage: true,
      mask: [hideAccount],
    });
    const event = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download MP4", exact: true }).click();
    const download = await event;
    await download.saveAs(path.join(privateDir, "export.mp4"));
    expect(await download.failure()).toBeNull();
    await writeFile(
      path.join(privateDir, "browser-result.json"),
      JSON.stringify(
        {
          status: "PASS",
          projectId,
          timelineId,
          originalHash,
          editedHash,
          jobId,
          actualBrowser: true,
          actualUpload: true,
          actualInspection: true,
          actualAnalysis: true,
          durableTrimAndSplit: true,
          actualRender: true,
          playbackAdvanced: true,
          actualDownload: true,
          mockData: false,
          asrModel: { name: model.name, version: model.version, sha256: model.sha256 },
          analysisSourceSha256: document.source.sha256,
          analysisSchemaVersion: document.schemaVersion,
          transcriptStatus: document.sections.transcript.status,
          audioStatus: document.sections.audio.status,
          transcriptMaskedInScreenshots: true,
        },
        null,
        2,
      ),
    );
    return;
  } catch (error) {
    await writeFile(path.join(privateDir, "browser-error.txt"), String(error), { mode: 0o600 });
    await writeFile(
      path.join(privateDir, "browser-result.json"),
      JSON.stringify({ status: "FAIL", phase }),
    );
    // Do not serialize locator operands, signed URLs, cookies or recognized text into CI.
  }
  throw new Error(`Graduation browser verification failed at ${phase}; details retained locally.`);
});
