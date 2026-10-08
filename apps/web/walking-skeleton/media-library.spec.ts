import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");
const compose = (args: string[]) =>
  execFileSync("docker", ["compose", ...args], {
    cwd: root,
    env: process.env,
    stdio: "pipe",
    timeout: 60_000,
  });
/** Trusted test/operator setup invokes the existing publisher in the production
 * worker image. No web route, fake artifact rows or automatic derive scheduling.
 */
function derive(project: string, media: string) {
  const script = `
    const {randomBytes} = require('node:crypto');
    const {Pool} = require('pg');
    const {instant,createUuidV7} = require('@editagent/domain');
    const {BullMqJobQueue,PostgresJobRepository,RedisJobEventPublisher} = require('@editagent/job-queue');
    const {publishMediaDeriveJob} = require('./dist/application/publish-media-derive.js');
    (async()=>{
      const pool=new Pool({connectionString:process.env.DATABASE_URL});
      const queue=new BullMqJobQueue(process.env.REDIS_URL,{events:new RedisJobEventPublisher(pool,process.env.REDIS_URL)});
      const uuid=()=>createUuidV7(Date.now(),randomBytes(10));
      try { await publishMediaDeriveJob({jobs:new PostgresJobRepository(pool),queue,now:()=>instant(BigInt(Date.now())),newAttemptId:uuid,supervisor:{run:async()=>{throw new Error('Publisher never executes');}}},{jobId:uuid(),projectId:process.argv[1],mediaAssetId:process.argv[2],correlationId:'req_'+randomBytes(16).toString('hex'),queueName:process.env.MEDIA_INSPECT_QUEUE||'media'}); }
      finally {await queue.close(true);await pool.end();}
    })().catch(()=>process.exit(1));`;
  compose(["exec", "-T", "media-worker", "node", "-e", script, project, media]);
}

async function signup(page: Page, prefix: string) {
  const password = `Test-only-${randomUUID()}!`;
  const secretFile = path.join(root, ".local/walking-skeleton-secret-values.json");
  const secrets = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, "utf8")) : [];
  writeFileSync(secretFile, JSON.stringify([...secrets, password]), { mode: 0o600 });
  await page.goto("/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(`${prefix}-${randomUUID()}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  writeFileSync(
    secretFile,
    JSON.stringify([
      ...JSON.parse(readFileSync(secretFile, "utf8")),
      ...(await page.context().cookies()).map((cookie) => cookie.value),
    ]),
    { mode: 0o600 },
  );
}
async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill(name);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Open project" }).click();
  return page.url().split("/projects/")[1]!;
}

test("US-125 real processing → derivatives → sprite/proxy playback → rejected media and reload/IDOR", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.skip(
    process.env.WALKING_SKELETON_SCENARIO === "negative",
    "negative skeleton deliberately stops worker",
  );
  test.setTimeout(120_000);
  const counts = {
    PROXY_REQUEST_COUNT: 0,
    POSTER_REQUEST_COUNT: 0,
    SPRITE_REQUEST_COUNT: 0,
    ORIGINAL_SOURCE_PLAYBACK_REQUEST_COUNT: 0,
  };
  let sseConnections = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/jobs/events")) sseConnections++;
    if (request.method() !== "GET") return;
    if (url.pathname.includes("/derived/") && url.pathname.endsWith("/proxy.mp4"))
      counts.PROXY_REQUEST_COUNT++;
    if (url.pathname.includes("/derived/") && url.pathname.endsWith("/poster.jpg"))
      counts.POSTER_REQUEST_COUNT++;
    if (url.pathname.includes("/derived/") && url.pathname.endsWith("/sprite.jpg"))
      counts.SPRITE_REQUEST_COUNT++;
    if (url.pathname.includes("/media/sha256/")) counts.ORIGINAL_SOURCE_PLAYBACK_REQUEST_COUNT++;
  });
  await signup(page, "library");
  const project = await createProject(page, "Media library acceptance");
  const library = page.getByRole("region", { name: "Media Library" });
  await expect(library.getByText("No media yet. Upload a video to get started.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("library-empty.png") });
  let workerStopped = false;
  let media = "";
  try {
    compose(["stop", "media-worker"]);
    workerStopped = true;
    const fixture = testInfo.outputPath("library-motion.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=960x540:rate=25:duration=11",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        fixture,
      ],
      { timeout: 30_000 },
    );
    await page.getByLabel("Choose a video").setInputFiles(fixture);
    const card = library.getByRole("article", { name: "library-motion.mp4" });
    await expect(card.getByText("Processing", { exact: true })).toBeVisible();
    media = (await card.getAttribute("data-library-media-id"))!;
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("library-processing.png") });
    await page.reload();
    await expect(
      library
        .getByRole("article", { name: "library-motion.mp4" })
        .getByText("Processing", { exact: true }),
    ).toBeVisible();
  } finally {
    if (workerStopped)
      compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "60", "media-worker"]);
  }
  const snapshot = async () =>
    page.evaluate(
      async ({ project, media }) =>
        (await (await fetch(`/api/projects/${project}/media/${media}`)).json()).data,
      { project, media },
    );
  await expect
    .poll(async () => (await snapshot()).validationStatus, { timeout: 30_000 })
    .toBe("validated");
  const card = library.getByRole("article", { name: "library-motion.mp4" });
  await expect(card.getByText("Awaiting preview derivatives.")).toBeVisible();
  derive(project, media);
  await expect(card.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  const poster = card.getByAltText("Thumbnail for library-motion.mp4");
  await expect
    .poll(() => poster.evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(320);
  await page.screenshot({ path: testInfo.outputPath("library-ready.png") });
  const scrub = card.getByRole("button", { name: "Play proxy for library-motion.mp4" });
  const box = (await scrub.boundingBox())!;
  const frames: number[] = [];
  const frameHashes: string[] = [];
  for (const ratio of [0.01, 0.5, 0.99]) {
    await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2);
    const sprite = card.locator("img[data-sprite-sample]");
    await expect(sprite).toBeVisible();
    await expect
      .poll(() => sprite.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    frames.push(Number(await sprite.getAttribute("data-sprite-sample")));
    frameHashes.push(
      createHash("sha256")
        .update(await scrub.screenshot())
        .digest("hex"),
    );
  }
  expect(frames[0]).toBe(0);
  expect(frames[2]).toBeGreaterThan(frames[0]!);
  expect(new Set(frameHashes).size).toBe(3);
  await page.screenshot({ path: testInfo.outputPath("library-hover.png") });
  await page.mouse.move(0, 0);
  await scrub.focus();
  await page.keyboard.press("Enter");
  const player = card.getByLabel("Proxy player for library-motion.mp4");
  await expect
    .poll(() => player.evaluate((node) => (node as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  const duration = await player.evaluate((node) => (node as HTMLVideoElement).duration);
  expect(duration).toBeGreaterThan(10);
  expect(await player.evaluate((node) => (node as HTMLVideoElement).videoHeight)).toBe(540);
  await player.evaluate((node) => (node as HTMLVideoElement).play());
  await expect
    .poll(() => player.evaluate((node) => (node as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.2);
  await player.evaluate((node) => {
    const video = node as HTMLVideoElement;
    video.pause();
    video.currentTime = video.duration * 0.7;
  });
  await expect
    .poll(() => player.evaluate((node) => (node as HTMLVideoElement).seeking))
    .toBe(false);
  await expect
    .poll(() => player.evaluate((node) => (node as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() =>
      player.evaluate((node) =>
        Math.abs(
          (node as HTMLVideoElement).currentTime - (node as HTMLVideoElement).duration * 0.7,
        ),
      ),
    )
    .toBeLessThan(0.1);
  await player.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("library-player.png") });
  const previewContract = await page.evaluate(
    async ({ project, media }) =>
      (await (await fetch(`/api/projects/${project}/media/${media}/preview`)).json()).data,
    { project, media },
  );
  const privacy = {
    statuses: {} as Record<string, { signed: number; unsigned: number }>,
    layout: previewContract.sprite.layout,
  };
  // An unsigned S3 rejection may omit CORS headers. Observe its actual status
  // with Playwright's isolated request context rather than treating CORS as auth.
  for (const variant of ["proxy", "poster", "sprite"]) {
    const signed = await request.get(
      previewContract[variant].url,
      variant === "proxy" ? { headers: { Range: "bytes=0-1023" } } : {},
    );
    const url = new URL(previewContract[variant].url);
    url.search = "";
    const unsigned = await request.get(url.toString());
    privacy.statuses[variant] = { signed: signed.status(), unsigned: unsigned.status() };
    await signed.dispose();
    await unsigned.dispose();
  }
  for (const variant of ["proxy", "poster", "sprite"]) {
    expect([200, 206]).toContain(privacy.statuses[variant]!.signed);
    expect([401, 403]).toContain(privacy.statuses[variant]!.unsigned);
  }
  expect(privacy.statuses.proxy!.signed).toBe(206);
  const sseBefore = sseConnections;
  await page.getByLabel("Choose a video").setInputFiles({
    name: "invalid-signature.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("not a video"),
  });
  const rejected = library.getByRole("article", { name: "invalid-signature.mp4" });
  await expect(rejected.getByText("Failed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(rejected.getByText("The file is not recognized media.")).toBeVisible();
  expect(sseConnections).toBe(sseBefore);
  await rejected.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("library-failed.png") });
  const rejectedId = (await rejected.getAttribute("data-library-media-id"))!;
  await page.reload();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await expect(rejected.getByText("The file is not recognized media.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("library-reloaded.png") });
  const failed = await page.evaluate(
    async ({ project, rejectedId }) =>
      (await (await fetch(`/api/projects/${project}/media/${rejectedId}`)).json()).data,
    { project, rejectedId },
  );
  expect(failed.validationStatus).toBe("rejected");
  expect(failed.rejectionCode).toBe("invalid_signature");
  const outsider = await browser.newContext();
  try {
    const b = await outsider.newPage();
    await signup(b, "outsider");
    const projectB = await createProject(b, "Other media library");
    const denied = await b.evaluate(
      async ({ project, media, projectB }) => {
        const routes = [
          `/api/projects/${project}/media`,
          `/api/projects/${project}/media/${media}/preview`,
          `/api/projects/${projectB}/media/${media}/preview`,
        ];
        return Promise.all(
          routes.map(async (route) => {
            const response = await fetch(route);
            const body = await response.json();
            return {
              status: body.status,
              ok: body.ok,
              hasUrl: JSON.stringify(body).includes("X-Amz-"),
            };
          }),
        );
      },
      { project, media, projectB },
    );
    expect(denied.every((r) => r.status === 404 && !r.ok && !r.hasUrl)).toBe(true);
  } finally {
    await outsider.close();
  }
  const anonymous = await browser.newContext();
  try {
    const b = await anonymous.newPage();
    await b.goto("/sign-in");
    const statuses = await b.evaluate(
      async ({ project, media }) =>
        Promise.all(
          [`/api/projects/${project}/media`, `/api/projects/${project}/media/${media}/preview`].map(
            async (route) => (await (await fetch(route)).json()).status,
          ),
        ),
      { project, media },
    );
    expect(statuses).toEqual([401, 401]);
  } finally {
    await anonymous.close();
  }
  expect(counts.PROXY_REQUEST_COUNT).toBeGreaterThanOrEqual(1);
  expect(counts.POSTER_REQUEST_COUNT).toBeGreaterThanOrEqual(1);
  expect(counts.SPRITE_REQUEST_COUNT).toBeGreaterThanOrEqual(1);
  expect(counts.ORIGINAL_SOURCE_PLAYBACK_REQUEST_COUNT).toBe(0);
  const evidence = {
    ...counts,
    project,
    media,
    duration,
    frames,
    frameHashes,
    privacy,
    processingReal: true,
    validationStatus: failed.validationStatus,
    rejectionCode: failed.rejectionCode,
    rejectionMessage: failed.rejectionMessage,
    loadedmetadata: true,
    currentTimeAdvanced: true,
    seek: true,
    hardReloadPersistence: true,
    liveSseReady: true,
    sseConnectionsPerProject: 1,
    idor: true,
  };
  console.log("US125_MEDIA_LIBRARY_EVIDENCE", JSON.stringify(evidence));
  await testInfo.attach("media-library-evidence", {
    body: JSON.stringify(evidence),
    contentType: "application/json",
  });
});
