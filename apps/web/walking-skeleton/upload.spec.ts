import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(__dirname, "../../..");
const fixture = JSON.parse(
  readFileSync(path.join(root, "tests/fixtures/media/manifest.json"), "utf8"),
).fixtures.find((f: { name: string }) => f.name === "talking-head");
test("US-117 real upload → production metadata Job → exact metadata DOM", async ({
  page,
}, testInfo) => {
  const startedAt = Date.now();
  const email = `skeleton-${randomUUID()}@example.test`;
  const password = `Test-only-${randomUUID()}!`;
  const secretFile = path.join(root, ".local/walking-skeleton-secret-values.json");
  const previous = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, "utf8")) : [];
  writeFileSync(secretFile, JSON.stringify([...previous, password]), { mode: 0o600 });
  let navigations = 0;
  const diagnostics: { at: number; kind: string; detail: string }[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      navigations++;
      diagnostics.push({ at: Date.now(), kind: "navigation", detail: frame.url() });
    }
  });
  page.on("console", (message) =>
    diagnostics.push({ at: Date.now(), kind: "console", detail: message.text() }),
  );
  page.on("response", (response) =>
    diagnostics.push({
      at: Date.now(),
      kind: "http",
      detail: `${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`,
    }),
  );
  try {
    await test.step("Authenticate through UI (sign up, sign out, log in)", async () => {
      await page.goto("/sign-up");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign up", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page).toHaveURL(/\/sign-in$/);
      await page.waitForLoadState("domcontentloaded");
      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    });
    await test.step("Create and open Project through UI", async () => {
      await page.getByRole("button", { name: "Create project", exact: true }).first().click();
      await page.getByLabel("Project name", { exact: true }).fill("Walking skeleton");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.getByRole("link", { name: "Open project" }).click();
      // Finish the intended Project navigation before measuring upload reloads.
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator("#media-file")).toBeAttached();
    });
    const projectId = page.url().split("/").pop()!;
    const beforeMetadataNavigationCount = navigations;
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await test.step("Upload canonical LFS fixture through real object storage", async () => {
      await page
        .locator("#media-file")
        .setInputFiles(path.join(root, "tests/fixtures/media", fixture.file));
      await expect(page.locator("[data-media-id]")).toBeVisible({ timeout: 15000 });
    });
    const mediaAssetId = await page.locator("[data-media-id]").getAttribute("data-media-id");
    const metadataTimeout = process.env.WALKING_SKELETON_METADATA_TIMEOUT_MS
      ? Number(process.env.WALKING_SKELETON_METADATA_TIMEOUT_MS)
      : 30000;
    await test.step("Wait for production media-worker/FFprobe metadata, without reload", async () => {
      const completed = page
        .getByRole("region", { name: "Inspection job" })
        .getByText("Completed", { exact: true });
      await expect(
        completed,
        "metadata Job must complete; inspect media-worker/queue diagnostics on timeout",
      ).toBeVisible({ timeout: metadataTimeout });
      const value = (name: string) =>
        page.getByText(name, { exact: true }).locator("..").locator("dd");
      await expect(value("Video codec")).toHaveText(fixture.expected.codec);
      await expect(value("Stored resolution")).toHaveText(
        `${fixture.expected.width}×${fixture.expected.height}`,
      );
      await expect(value("Frame rate")).toHaveText(fixture.expected.frameRate);
      await expect
        .poll(async () => Number(await value("Duration (microseconds)").textContent()))
        .toBeCloseTo(fixture.expected.durationUs, -3);
    });
    const snapshot = await page.evaluate(
      async ({ projectId, mediaAssetId }) => {
        const response = await fetch(
          `/api/projects/${projectId}/media/${mediaAssetId}/inspection-job`,
        );
        if (!response.ok) throw new Error("Authoritative Job snapshot unavailable");
        return response.json();
      },
      { projectId, mediaAssetId },
    );
    const value = (name: string) =>
      page.getByText(name, { exact: true }).locator("..").locator("dd").textContent();
    const evidence = {
      projectId,
      mediaAssetId,
      fixture: fixture.file,
      uploadCompleted: true,
      jobSnapshot: snapshot,
      codec: await value("Video codec"),
      resolution: await value("Stored resolution"),
      fps: await value("Frame rate"),
      durationUs: await value("Duration (microseconds)"),
      totalDurationMs: Date.now() - startedAt,
      browserNavigationCount: navigations,
      processingNavigations: navigations - beforeMetadataNavigationCount,
      noReload: (await page.evaluate(() => performance.timeOrigin)) === timeOrigin,
    };
    expect(evidence.processingNavigations).toBe(0);
    expect(evidence.noReload).toBe(true);
    await testInfo.attach("walking-skeleton-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    console.log("US117_WALKING_SKELETON_EVIDENCE", JSON.stringify(evidence));
  } finally {
    await testInfo.attach("browser-diagnostics", {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: "application/json",
    });
    // Playwright context teardown cancels SSE; keep the failed DOM for screenshots.
  }
});
