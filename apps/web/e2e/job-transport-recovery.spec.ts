import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { observeJobs, readJobTrace } from "./job-observation";

async function control(request: APIRequestContext, action: string, data = {}) {
  const result = await request.post(`http://127.0.0.1:3032/${action}`, { data });
  expect(result.ok()).toBe(true);
  return result.json();
}
async function signup(page: Page) {
  await observeJobs(page);
  await page.goto("/sign-up");
  await page.getByLabel("Email", { exact: true }).fill("transport@example.test");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  await page.getByLabel("Project name", { exact: true }).fill("Transport A");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("link", { name: "Open project" }).click();
  return page.url().split("/").pop()!;
}
const panel = (page: Page) => page.getByRole("region", { name: "Inspection job" });

test("real Redis subscriber TCP outage closes SSE and reconciles production-worker completion without reload; Project revocation and access refresh", async ({
  page,
  context,
  request,
}, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), "us131-reset-"));
  let other: Page | undefined;
  try {
    await control(request, "reset", { jobs: true });
    const projectA = await signup(page);
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
    await page.locator("#media-file").setInputFiles(source);
    await expect(panel(page).getByText("Waiting to start")).toBeVisible();
    const projectB = await page.evaluate(async () => {
      const csrf = decodeURIComponent(
        document.cookie
          .split(";")
          .find((c) => c.trim().startsWith("editagent_csrf="))!
          .trim()
          .split("=")[1]!,
      );
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-editagent-csrf": csrf },
        body: JSON.stringify({ name: "Transport B" }),
      });
      return (await response.json()).data.id as string;
    });
    other = await context.newPage();
    await observeJobs(other);
    const statusesB: number[] = [];
    other.on("response", (response) => {
      if (response.url().endsWith("/jobs/events")) statusesB.push(response.status());
    });
    await other.goto(`/projects/${projectB}`);
    await other.locator("#media-file").setInputFiles(source);
    await expect(panel(other).getByText("Waiting to start")).toBeVisible();
    await expect
      .poll(async () =>
        (await request.get("http://127.0.0.1:3032/job-transport-state"))
          .json()
          .then((s) => s.subscriptions),
      )
      .toBe(2);
    const origin = await page.evaluate(() => performance.timeOrigin);
    let reloads = 0;
    page.on("load", () => reloads++);
    const lost = await control(request, "job-transport", { action: "break" });
    await expect.poll(async () => (await readJobTrace(page)).opens[0]?.closedAt).toBeTruthy();
    await expect.poll(async () => (await readJobTrace(other!)).opens[0]?.closedAt).toBeTruthy();
    const completed = await control(request, "job-production-run");
    expect(completed.status).toBe("Completed");
    const durable = await (await request.get("http://127.0.0.1:3032/job-evidence")).json();
    expect(durable.jobs).toHaveLength(2);
    expect(durable.jobs.every((job: { status: string }) => job.status === "Completed")).toBe(true);
    await expect(panel(page).getByText("Waiting to start")).toBeVisible();
    await control(request, "job-revoke-membership", {
      projectId: projectB,
      email: "transport@example.test",
    });
    const ready = await control(request, "job-transport", { action: "restore" });
    await expect(panel(page).getByText("Completed", { exact: true })).toBeVisible({
      timeout: 6000,
    });
    const traceA = await readJobTrace(page),
      traceB = await readJobTrace(other);
    const reopened = traceA.opens.at(-1)!;
    expect(traceA.opens).toHaveLength(2);
    expect(traceA.snapshots.filter((s) => s.at >= reopened.at)).toHaveLength(1);
    expect(traceA.snapshots.at(-1)?.job?.status).toBe("Completed");
    expect(traceA.domCompletedAt - ready.readyAt).toBeLessThanOrEqual(6000);
    const crossProject = [...traceA.events, ...traceB.events].filter(
      (e) => e.project !== e.event.projectId,
    ).length;
    expect(crossProject).toBe(0);
    await expect.poll(() => statusesB, { timeout: 7000 }).toContain(404);
    const activeSubscriptions = (
      await (await request.get("http://127.0.0.1:3032/job-transport-state")).json()
    ).subscriptions;
    expect(activeSubscriptions).toBe(1);
    await expect
      .poll(
        async () =>
          (await (await request.get("http://127.0.0.1:3032/job-transport-state")).json())
            .redisChannels,
      )
      .toBe(1);
    expect(traceA.opens.filter((open) => !open.closedAt)).toHaveLength(1);
    expect(traceB.events.filter((e) => e.at > lost.lostAt)).toHaveLength(0);
    expect(reloads).toBe(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
    const evidence = {
      projectA,
      projectB,
      redisContinuityLostAt: lost.lostAt,
      jobCompletedInPgAt: completed.completedAt,
      redisReadyAt: ready.readyAt,
      oldSseClosedAt: traceA.opens[0]!.closedAt,
      newSseOpenAt: reopened.at,
      snapshotReconciledAt: traceA.snapshots.at(-1)!.at,
      domCompletedAt: traceA.domCompletedAt,
      recoveryMs: traceA.domCompletedAt - ready.readyAt,
      reloads,
      activeProjectStreams: 1,
      crossProjectEvents: crossProject,
      revokedProjectReconnectStatus: 404,
      durableJobs: durable.jobs,
    };
    // Same reconnect engine must refresh expired access rather than stop or loop.
    await other.close();
    other = undefined;
    await control(request, "advance", { ms: 901000 });
    await control(request, "job-transport", { action: "break" });
    await control(request, "job-transport", { action: "restore" });
    await expect
      .poll(async () => (await readJobTrace(page)).opens.length, { timeout: 7000 })
      .toBe(3);
    expect((await (await request.get("http://127.0.0.1:3032/metrics")).json()).rotations).toBe(1);
    expect(reloads).toBe(0);
    await testInfo.attach("redis-continuity-recovery", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    console.log("US131_REDIS_RECOVERY", JSON.stringify({ ...evidence, accessRefresh: true }));
  } finally {
    await other?.close();
    await page.goto("/health");
    await control(request, "reset");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live Project stream stops on logout/expired session and opens after re-login", async ({
  page,
  request,
}) => {
  try {
    await control(request, "reset", { jobs: true });
    const project = await signup(page);
    await expect.poll(async () => (await readJobTrace(page)).opens.length).toBe(1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get("http://127.0.0.1:3032/job-transport-state")).json())
            .subscriptions,
      )
      .toBe(0);
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(`/projects/${project}`)}`);
    await page.getByLabel("Email", { exact: true }).fill("transport@example.test");
    await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get("http://127.0.0.1:3032/job-transport-state")).json())
            .subscriptions,
      )
      .toBe(1);
    let attempts = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/jobs/events")) attempts++;
    });
    await control(request, "advance", { ms: 15 * 24 * 60 * 60 * 1000 });
    await control(request, "job-transport", { action: "break" });
    await control(request, "job-transport", { action: "restore" });
    await expect(page).toHaveURL(/\/sign-in\?returnTo=/);
    const stoppedAttempts = attempts;
    await page.waitForTimeout(750);
    expect(attempts).toBe(stoppedAttempts);
    expect(
      (await (await request.get("http://127.0.0.1:3032/job-transport-state")).json()).subscriptions,
    ).toBe(0);
    console.log(
      "US131_SESSION_RECOVERY",
      JSON.stringify({
        logoutStopsStream: true,
        reloginOpensStream: true,
        expiredSessionStopsLoop: true,
        reconnectAttempts: attempts,
      }),
    );
  } finally {
    await page.goto("/health");
    await control(request, "reset");
  }
});
