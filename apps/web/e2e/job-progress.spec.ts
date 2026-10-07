import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
test("US-131 real PostgreSQL/BullMQ/Redis/BFF/browser progress and immutable failed-job retry without reload", async ({
  page,
  request,
}, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), "us131-browser-"));
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    expect((await request.post("http://127.0.0.1:3032/reset", { data: { jobs: true } })).ok()).toBe(
      true,
    );
    const source = join(dir, "source.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=128x72:rate=12",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      source,
    ]);
    await page.goto("/sign-up");
    await page.getByLabel("Email", { exact: true }).fill("jobs@example.test");
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await page.getByRole("button", { name: "Create project", exact: true }).first().click();
    await page.getByLabel("Project name", { exact: true }).fill("Live processing");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    let sseRequests = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/jobs/events")) sseRequests++;
    });
    await page.getByRole("link", { name: "Open project" }).click();
    const projectId = page.url().split("/").pop()!;
    expect(
      (await request.post("http://127.0.0.1:3032/job-observe", { data: { projectId } })).ok(),
    ).toBe(true);
    await expect(page.locator("#media-file")).toBeAttached();
    const documentOrigin = await page.evaluate(() => performance.timeOrigin);
    let navigations = 0;
    page.on("load", () => {
      navigations++;
    });
    await page.locator("#media-file").setInputFiles(source);
    const panel = page.getByRole("region", { name: "Inspection job" });
    await expect(panel.getByText("Waiting to start")).toBeVisible();
    const success = request.post("http://127.0.0.1:3032/job-run", { data: { mode: "success" } });
    await expect(panel.getByText("Preparing · 0%")).toBeVisible();
    await expect(panel.getByText("Completed", { exact: true })).toBeVisible();
    expect((await success).ok()).toBe(true);
    await expect(page.getByText("Validation passed", { exact: true })).toBeVisible();
    const completedEvidence = await (
      await request.get("http://127.0.0.1:3032/job-evidence")
    ).json();
    // A second upload creates a separate immutable inspection; failure is controlled
    // in the worker fixture, never by changing production policy or media signatures.
    const other = join(dir, "second.mp4");
    const bytes = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=128x72:rate=12",
      "-t",
      "1.2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "mp4",
      "-movflags",
      "frag_keyframe+empty_moov",
      "pipe:1",
    ]);
    writeFileSync(other, bytes);
    await page.locator("#media-file").setInputFiles(other);
    await expect(panel.getByText("Waiting to start")).toBeVisible();
    const failing = request.post("http://127.0.0.1:3032/job-run", { data: { mode: "fail" } });
    await expect(panel.getByText("Processing failed.")).toBeVisible();
    expect((await failing).ok()).toBe(true);
    const before = await (await request.get("http://127.0.0.1:3032/job-evidence")).json();
    const predecessor = before.jobs.at(-1);
    const retryResponse = page.waitForResponse(
      (r) => r.url().endsWith("/inspection/retry") && r.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    const retry = await retryResponse;
    expect(retry.status()).toBe(201);
    const successor = await retry.json();
    expect(successor.jobId).not.toBe(predecessor.id);
    await expect(panel.getByText("Waiting to start")).toBeVisible();
    const again = request.post("http://127.0.0.1:3032/job-run", { data: { mode: "success" } });
    await expect(panel.getByText("Preparing · 0%")).toBeVisible();
    await expect(panel.getByText("Completed", { exact: true })).toBeVisible();
    expect((await again).ok()).toBe(true);
    const final = await (await request.get("http://127.0.0.1:3032/job-evidence")).json();
    expect(final.jobs.find((j: { id: string }) => j.id === predecessor.id)).toEqual(predecessor);
    expect(final.jobs.at(-1).status).toBe("Completed");
    expect(final.jobs.at(-1).timeout_ms).toBe(300000);
    expect(final.jobs.at(-1).max_attempts).toBe(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(navigations).toBe(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin);
    expect(sseRequests).toBe(1);
    expect(await page.locator("body").textContent()).not.toMatch(/secret\/path|token=unsafe/);
    const evidence = {
      projectId,
      noPageReload: navigations === 0,
      projectStreams: sseRequests,
      initial: completedEvidence,
      predecessor,
      successor,
      final,
    };
    await testInfo.attach("us131-real-flow", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    console.log("US131_REAL_FLOW", JSON.stringify(evidence));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await page.goto("/health");
    await request.post("http://127.0.0.1:3032/reset");
  }
});
