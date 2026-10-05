import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
const directories: string[] = [];
test.afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const SIZE = 16 * 1024 * 1024;
async function openProject(page: Page) {
  await page.goto("/sign-up");
  await page.getByLabel("Email", { exact: true }).fill("uploader@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill("Resume edit");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const link = page.getByRole("link", { name: "Open project" });
  const target = (await link.getAttribute("href"))!;
  await link.click();
  await expect(page.locator("#media-file")).toBeAttached();
  return target;
}
test.beforeEach(async ({ request }) => {
  expect((await request.post("http://127.0.0.1:3032/reset")).ok()).toBe(true);
});
test("US-123 AC1/AC2: real network interruption at 50%, browser recreation and only missing parts PUT; final SHA-256", async ({
  page,
  context,
  request,
}) => {
  const target = await openProject(page);
  const bytes = Buffer.alloc(SIZE * 4, 7);
  bytes.write(randomUUID());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const directory = mkdtempSync(join(tmpdir(), "us123-browser-"));
  directories.push(directory);
  mkdirSync(join(directory, "valid"));
  mkdirSync(join(directory, "wrong"));
  const source = join(directory, "valid", "resume.mp4"),
    mismatch = join(directory, "wrong", "resume.mp4");
  writeFileSync(source, bytes);
  let controlDisconnects = 0;
  await context.route(
    /\/api\/projects\/[^/]+\/uploads\/multipart\/[^/]+\/parts\/[0-9]+$/,
    async (route) => {
      if (route.request().method() === "POST" && controlDisconnects === 0) {
        controlDisconnects++;
        await route.abort("internetdisconnected");
      } else await route.continue();
    },
  );
  const puts: number[] = [];
  let interrupt = true;
  await context.route("http://127.0.0.1:9000/**", async (route) => {
    const req = route.request();
    const n = Number(new URL(req.url()).searchParams.get("partNumber"));
    if (req.method() === "PUT" && n) {
      puts.push(n);
      if (interrupt && n > 2) {
        await route.abort("internetdisconnected");
        return;
      }
    }
    await route.continue();
  });
  await page.locator("#media-file").setInputFiles(source);
  await expect
    // Allow the bounded control/part backoff plus real 16 MiB transfers.
    .poll(
      async () => {
        const r = await request.get("http://127.0.0.1:3032/uploads");
        const result = await r.json();
        return result.uploads[0]?.parts.map((p: { partNumber: number }) => p.partNumber).sort();
      },
      { timeout: 15000 },
    )
    .toEqual([1, 2]);
  const before = (await (await request.get("http://127.0.0.1:3032/uploads")).json()).uploads[0];
  const beforeETags = before.parts.map((p: { partNumber: number; etag: string }) => [
    p.partNumber,
    p.etag,
  ]);
  await context.setOffline(true);
  await page.waitForTimeout(300);
  await page.close();
  interrupt = false;
  await context.setOffline(false);
  const resumed = await context.newPage();
  await resumed.goto(target);
  await expect(resumed.getByText(/Reselect the same video/)).toBeVisible();
  await expect(resumed.getByText(/50\.0%/)).toBeVisible();
  const startOfRecovery = puts.length;
  const wrong = Buffer.from(bytes);
  wrong[wrong.length - 1] ^= 1;
  writeFileSync(mismatch, wrong);
  await resumed.locator("#media-file").setInputFiles(mismatch);
  await expect(resumed.locator("p[role=alert]")).toContainText("does not match");
  expect(puts.length).toBe(startOfRecovery);
  await request.post("http://127.0.0.1:3032/advance", { data: { ms: 901000 } });
  await resumed.locator("#media-file").setInputFiles(source);
  await expect(
    resumed.getByText("Upload complete. The video was not sent through the application server."),
  ).toBeVisible();
  const after = (await (await request.get("http://127.0.0.1:3032/uploads")).json()).uploads[0];
  expect(controlDisconnects).toBe(1);
  expect(after.id).toBe(before.id);
  expect(after.status).toBe("completed");
  expect(after.final.checksumSha256Hex).toBe(hash);
  expect(after.final.byteSize).toBe(String(bytes.length));
  expect(
    after.parts
      .filter((p: { partNumber: number }) => p.partNumber <= 2)
      .map((p: { partNumber: number; etag: string }) => [p.partNumber, p.etag]),
  ).toEqual(beforeETags);
  expect(puts.slice(startOfRecovery).sort()).toEqual([3, 4]);
  expect(puts.filter((n) => n === 1)).toHaveLength(1);
  expect(puts.filter((n) => n === 2)).toHaveLength(1);
  const metrics = await (await request.get("http://127.0.0.1:3032/metrics")).json();
  expect(metrics.rotations).toBe(1);
  const stored = await resumed.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const opening = indexedDB.open("editagent-upload-state", 1);
        opening.onsuccess = () => {
          const db = opening.result;
          const read = db.transaction("uploads").objectStore("uploads").getAll();
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
  expect(stored).toEqual([]);
  expect(
    await resumed.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
  console.info(
    `US-123 real 64 MiB: completed before interruption [1,2]; resumed PUTs [3,4]; same session; whole SHA-256 ${hash}; control disconnect recovered 1; silent refresh 1.`,
  );
});
test("US-123 small PUT regression; multipart explicit CSRF/forged session rejection and intentional discard", async ({
  page,
  context,
  request,
}) => {
  const target = await openProject(page);
  const project = target.split("/").pop();
  const failures = await page.evaluate(async (project) => {
    const base = `/api/projects/${project}/uploads/multipart`;
    const body = {
      filename: "csrf.mp4",
      mimeType: "video/mp4",
      byteSize: 16777216,
      sha256: "ab".repeat(32),
    };
    const r = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await r.json()).status;
  }, project);
  expect(failures).toBe(403);
  const small = Buffer.from("small real source " + randomUUID());
  await page
    .locator("#media-file")
    .setInputFiles({ name: "small.mp4", mimeType: "video/mp4", buffer: small });
  await expect(
    page.getByText("Upload complete. The video was not sent through the application server."),
  ).toBeVisible();
  await context.route("http://127.0.0.1:9000/**", (route) => route.abort("internetdisconnected"));
  await page
    .locator("#media-file")
    .setInputFiles({ name: "cancel.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(SIZE, 6) });
  await expect(page.getByRole("button", { name: "Pause upload" })).toBeVisible();
  await page.getByRole("button", { name: "Pause upload" }).click();
  await expect(page.getByRole("button", { name: "Discard resumable upload" })).toBeVisible();
  await page.getByRole("button", { name: "Discard resumable upload" }).click();
  await expect(page.getByText(/The upload was cancelled/)).toBeVisible();
  const data = await (await request.get("http://127.0.0.1:3032/uploads")).json();
  expect(data.uploads[0].status).toBe("aborted");
  await context.clearCookies();
  await context.addCookies([
    { name: "editagent_access", value: "forged", domain: "127.0.0.1", path: "/", httpOnly: true },
  ]);
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
});
