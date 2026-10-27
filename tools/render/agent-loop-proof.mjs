/** Actual packaged replay-worker -> existing API/Tool SDK/render -> browser/MP4.
 * Model decisions are a declared deterministic fixture, never live LLM proof. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import { buildProductImages } from "../test/compose-build.mjs";
import { runAgentLeaseProof } from "./agent-lease-proof.mjs";
import assert from "node:assert/strict";

export async function runAgentLoopProof({
  root,
  hostEnv,
  webUrl,
  result,
  probe,
  codeIdentity,
  renderContainer,
}) {
  const directory = path.join(root, ".local/agent-loop-public"),
    privateDir = path.join(root, ".local/agent-loop-private");
  await mkdir(directory, { recursive: true });
  await mkdir(privateDir, { recursive: true });
  const require = createRequire(path.join(root, "apps/api/package.json")),
    webRequire = createRequire(path.join(root, "apps/web/package.json"));
  const core = require("@editagent/agent-core"),
    sdk = require("@editagent/tool-sdk"),
    domain = require("@editagent/domain");
  const { JwtSessionTokens } = require("./dist/infrastructure/jwt-session-tokens.js");
  const pool = new Pool({ connectionString: hostEnv.DATABASE_URL });
  const name = "agent-replay-proof-" + randomBytes(6).toString("hex"),
    apiOrigin = `http://127.0.0.1:${hostEnv.PORT}`;
  let browser,
    phase = "build-packaged-worker",
    runId = null;
  const digest = (b) => createHash("sha256").update(b).digest("hex");
  try {
    // Build before admission: preserve the run's original 120-second deadline.
    await buildProductImages(root, ["agent-worker"], {
      "agent-worker": "editagent-agent-qualification:test",
    });
    phase = "authorized-original-source";
    const actor = (
      await pool.query(
        "SELECT user_id FROM project_memberships WHERE project_id=$1 AND role='owner'",
        [result.projectId],
      )
    ).rows[0]?.user_id;
    if (!actor) throw new Error("missing_test_owner");
    const access = (
      await new JwtSessionTokens(hostEnv.AUTH_JWT_SECRET).issueAccess(
        domain.userId(actor),
        BigInt(Date.now()),
      )
    ).token;
    const csrf = randomBytes(16).toString("hex");
    const headers = {
      cookie: `editagent_access=${access}; editagent_csrf=${csrf}`,
      "x-editagent-csrf": csrf,
      "content-type": "application/json",
    };
    const json = async (url, body) => {
      const response = await globalThis.fetch(apiOrigin + url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("authenticated_api_request_failed");
      return response.json();
    };
    const originalManual = await json(
      `/projects/${result.projectId}/timelines/${result.timelineId}`,
    );
    const asset = originalManual.timeline.sources[0].id;
    const created = await json(`/projects/${result.projectId}/timelines`, { mediaAssetId: asset });
    const snapshot = created.timeline,
      sourceSha256 = created.stateSha256;
    if (snapshot.tracks.flatMap((t) => t.clips).length !== 1)
      throw new Error("original_source_not_fresh");
    const started = await json(`/projects/${result.projectId}/agent-runs`, {
      idempotencyKey: core.newAgentId(),
      timelineId: snapshot.id,
      stateSha256: sourceSha256,
    });
    runId = started.id;
    const capabilities = {
      schemaVersion: "1.0.0",
      provider: "replay",
      modelId: "qualification-replay",
      modelVersion: "1.0.0",
      contextWindow: 65536,
      maxOutputTokens: 4096,
      modes: ["structured", "tools"],
      tokenizer: { kind: "conservative_utf8_bytes", version: "1" },
      evidence: "synthetic_replay",
      configurationVersion: "fixture-v1",
      pricing: {
        version: "synthetic-zero-v1",
        provenance: "synthetic_fixture",
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 0,
      },
    };
    const configuration = {
      schemaVersion: "1.0.0",
      creator: {
        request: "Trim and split the licensed presentation fixture.",
        preferences: "",
        creativity: "conservative",
      },
      requiredCapabilities: ["trim", "split", "render"],
      analysisRequirement: "transcript",
      limits: {
        maxIterations: 8,
        maxTools: 8,
        reservedTokens: 500000,
        reservedCostMicros: 10000,
        maxOutputTokens: 2048,
      },
    };
    const permit = core.createControlledReplayPermit({
      nodeEnvironment: "test",
      runtime: "development",
      qualification: "isolated-v1",
    });
    const runs = new core.PostgresAgentRuns(pool, permit);
    await runs.enableControlledReplay(
      actor,
      result.projectId,
      runId,
      configuration,
      sdk.contentHash(capabilities),
    );
    const authority = new sdk.PostgresToolAuthority(pool, async (project, id) =>
      domain.Timeline.restore(
        (
          await pool.query("SELECT snapshot FROM editing_timelines WHERE id=$1 AND project_id=$2", [
            id,
            project,
          ])
        ).rows[0].snapshot,
      ),
    );
    const registry = sdk.registerEditingTools(new sdk.ToolRegistry(), authority);
    const source = new core.PostgresAgentContextSource(pool, registry, {
      pins: [
        { name: "editing.trim-video", version: "1.0.0" },
        { name: "editing.split-video", version: "1.0.0" },
      ],
      creativity: ["conservative"],
    });
    const context = await core.buildAgentContext(source, core.packagedPrompts(), {
      actorId: actor,
      projectId: result.projectId,
      runId,
      expectedSourceSha256: sourceSha256,
      prompt: { id: "agent-plan", version: "1.0.0" },
      creator: configuration.creator,
      budget: { contextWindow: 65536, responseMargin: 3072, toolMargin: 4096 },
    });
    if (!context.ok) throw new Error("context_unavailable");
    const clip = snapshot.tracks[0].clips[0],
      duration = BigInt(snapshot.composition.durationUs);
    const plan = {
      schemaVersion: "1.0.0",
      projectId: result.projectId,
      timelineId: snapshot.id,
      sourceSha256,
      coordinateSystem: "original_timeline_microseconds",
      goals: ["trim", "split"],
      targetDurationUs: String(duration),
      selectedMedia: [asset],
      segments: [{ assetId: asset, startUs: "0", endUs: snapshot.sources[0].durationUs }],
      steps: [
        {
          id: "trim",
          tool: "editing.trim-video",
          version: "1.0.0",
          dependencies: [],
          clipId: clip.id,
          startUs: "200000",
          endUs: String(duration - 200000n),
          atUs: "0",
        },
        {
          id: "split",
          tool: "editing.split-video",
          version: "1.0.0",
          dependencies: ["trim"],
          clipId: clip.id,
          startUs: "0",
          endUs: "0",
          atUs: String(duration / 2n),
        },
      ],
      provenance: {
        contextSha256: context.sha256,
        promptId: context.summary.promptId,
        promptVersion: context.summary.promptVersion,
        templateHash: context.summary.templateHash,
        dataAuthority: "untrusted_model_proposal",
      },
      stopCriteria: { afterSteps: 2, render: true, validateOutput: true },
    };
    core.validateEditPlan(
      plan,
      domain.Timeline.restore(snapshot),
      context,
      registry,
      configuration,
    );
    phase = "actual-packaged-queue-worker";
    // Session is ephemeral test memory on stdin, never an argument, env var,
    // recorded cassette, report or mounted credential file.
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        "--network",
        "host",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        "10001:10001",
        "--cpus",
        "1",
        "--memory",
        "256m",
        "--memory-swap",
        "256m",
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
        "-e",
        "NODE_ENV=test",
        "-e",
        "EDITAGENT_RUNTIME=development",
        "-e",
        "EDITAGENT_REPLAY_QUALIFICATION=isolated-v1",
        "-e",
        `DATABASE_URL=${hostEnv.DATABASE_URL}`,
        "-e",
        `REDIS_URL=${hostEnv.REDIS_URL}`,
        "--entrypoint",
        "node",
        "editagent-agent-qualification:test",
        "dist/qualification-entry.js",
      ],
      {
        input: JSON.stringify({
          mode: "isolated-replay-v1",
          runId,
          projectId: result.projectId,
          actorId: actor,
          apiOrigin,
          accessToken: access,
          csrf,
          plan,
          capabilities,
        }),
        encoding: "utf8",
        timeout: 140000,
        maxBuffer: 65536,
      },
    );
    const worker = JSON.parse(output.trim());
    if (worker.status !== "PASS" || worker.checkpoint !== 2 || worker.productionEnabled !== false)
      throw new Error("packaged_worker_failed");
    const completed = await json(`/projects/${result.projectId}/agent-runs/${runId}`);
    if (
      completed.state !== "Completed" ||
      completed.runtime.driver !== "controlled-loop-v1" ||
      !completed.planning.renderJobId
    )
      throw new Error("run_not_completed");
    const jobId = completed.planning.renderJobId;
    phase = "durable-command-and-model-receipts";
    const pages = [];
    let cursor = null;
    do {
      const page = await json(
        `/projects/${result.projectId}/agent-runs/${runId}/export${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    const events = pages.flatMap((p) => p.events),
      calls = events.filter((e) => e.kind === "model_result");
    if (
      calls.length !== 3 ||
      calls.some(
        (e) =>
          e.model?.receipt?.usage.source !== "synthetic_replay" ||
          e.model.receipt.usage.actualCostMicros !== null,
      )
    )
      throw new Error("usage_not_honest");
    const edited = await json(`/projects/${result.projectId}/timelines/${snapshot.id}`);
    if (
      edited.timeline.tracks.flatMap((t) => t.clips).length !== 2 ||
      sdk.contentHash(core.replayAgentCommands(snapshot, pages).toSnapshot()) !== edited.stateSha256
    )
      throw new Error("command_replay_mismatch");
    const validation = await json(`/projects/${result.projectId}/exports/${jobId}/validation`);
    core.validateRenderProof(validation, domain.Timeline.restore(edited.timeline), jobId);
    phase = "actual-browser-reload-playback-download";
    const { chromium } = webRequire("@playwright/test");
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE ?? "/opt/google/chrome/chrome",
      args: ["--no-sandbox"],
    });
    const browserContext = await browser.newContext({ acceptDownloads: true });
    await browserContext.addCookies([
      { name: "editagent_access", value: access, url: webUrl, httpOnly: true, sameSite: "Lax" },
      { name: "editagent_csrf", value: csrf, url: webUrl, sameSite: "Lax" },
    ]);
    const page = await browserContext.newPage();
    await page.goto(`${webUrl}/projects/${result.projectId}/editor?timeline=${snapshot.id}`);
    await page.locator('[aria-label="Timeline"][data-timeline-id]').waitFor({ timeout: 15000 });
    if ((await page.locator("[data-clip-id]").count()) !== 2)
      throw new Error("browser_timeline_mismatch");
    await page.reload();
    await page.locator('[aria-label="Timeline"][data-timeline-id]').waitFor({ timeout: 15000 });
    if ((await page.locator("[data-clip-id]").count()) !== 2)
      throw new Error("browser_persistence_failed");
    await page.screenshot({
      path: path.join(directory, "timeline.png"),
      fullPage: true,
      mask: [page.locator("header .text-muted")],
    });
    // Actual authenticated browser HTTP context, not a fabricated job response.
    const browserRun = await page.request.get(
      `${apiOrigin}/projects/${result.projectId}/agent-runs/${runId}`,
    );
    if (!browserRun.ok() || (await browserRun.json()).state !== "Completed")
      throw new Error("browser_api_roundtrip_failed");
    const links = await json(`/projects/${result.projectId}/exports/${jobId}/download`);
    await page.goto(links.previewUrl);
    const video = page.locator("video");
    await video.waitFor({ timeout: 15000 });
    await video.evaluate(async (element) => {
      element.muted = true;
      await element.play();
    });
    await page.waitForTimeout(350);
    if (!(await video.evaluate((element) => element.currentTime > 0 && element.readyState >= 2)))
      throw new Error("playback_not_advanced");
    await page.screenshot({ path: path.join(directory, "playback.png") });
    const downloaded = page.waitForEvent("download", { timeout: 15000 });
    await page.goto(links.downloadUrl).catch(() => null);
    const download = await downloaded,
      outputFile = path.join(privateDir, "agent-export.mp4");
    await download.saveAs(outputFile);
    if (await download.failure()) throw new Error("download_failed");
    phase = "independent-ffprobe";
    const document = probe(outputFile),
      v = document.streams.find((s) => s.codec_type === "video"),
      a = document.streams.find((s) => s.codec_type === "audio"),
      frames = document.videoFrameTimes;
    const bytes = await readFile(outputFile),
      sha = digest(bytes);
    if (
      sha !== validation.artifactSha256 ||
      v?.codec_name !== "h264" ||
      a?.codec_name !== "aac" ||
      a.sample_rate !== "48000" ||
      a.channels !== 2 ||
      v.width !== 320 ||
      v.height !== 180 ||
      v.avg_frame_rate !== "25/1" ||
      Number(v.nb_read_frames) !== 200 ||
      Math.abs(Number(document.format.duration) - 8) > 0.02 ||
      !Array.isArray(frames) ||
      frames.length !== 200 ||
      frames.some((time, index) => Math.abs(time - index / 25) > 0.00001)
    )
      throw new Error("actual_export_integrity_failed");
    await copyFile(outputFile, path.join(directory, "agent-export.mp4"));
    phase = "lease-loss-recovery";
    const jobs = require("@editagent/job-queue"),
      leaseQueue = new jobs.BullMqJobQueue(hostEnv.REDIS_URL);
    let leaseRecovery;
    try {
      const { AuthenticatedTimelineRenderPort } = require(
        path.join(root, "workers/agent-worker/dist/render-port.js"),
      );
      const port = new AuthenticatedTimelineRenderPort(
        pool,
        leaseQueue,
        apiOrigin,
        async () => headers,
        permit,
      );
      leaseRecovery = await runAgentLeaseProof({
        root,
        hostEnv,
        pool,
        queue: leaseQueue,
        renderContainer,
        json,
        core,
        port,
        probe,
        privateDir,
        restore: (value) => domain.Timeline.restore(value),
        onPhase: (label) => {
          phase = "lease-" + label;
        },
        async createScenario() {
          const created = await json(`/projects/${result.projectId}/timelines`, {
            mediaAssetId: asset,
          });
          const started = await json(`/projects/${result.projectId}/agent-runs`, {
            idempotencyKey: core.newAgentId(),
            timelineId: created.timeline.id,
            stateSha256: created.stateSha256,
          });
          await runs.enableControlledReplay(
            actor,
            result.projectId,
            started.id,
            configuration,
            sdk.contentHash(capabilities),
          );
          const context = await core.buildAgentContext(source, core.packagedPrompts(), {
            actorId: actor,
            projectId: result.projectId,
            runId: started.id,
            expectedSourceSha256: created.stateSha256,
            prompt: { id: "agent-plan", version: "1.0.0" },
            creator: configuration.creator,
            budget: { contextWindow: 65536, responseMargin: 3072, toolMargin: 4096 },
          });
          if (!context.ok) throw new Error("lease_context_unavailable");
          const fresh = globalThis.structuredClone(plan);
          fresh.timelineId = created.timeline.id;
          fresh.sourceSha256 = created.stateSha256;
          fresh.steps = fresh.steps.map((step) => ({
            ...step,
            clipId: created.timeline.tracks[0].clips[0].id,
          }));
          fresh.provenance = {
            ...fresh.provenance,
            contextSha256: context.sha256,
            templateHash: context.summary.templateHash,
            promptId: context.summary.promptId,
            promptVersion: context.summary.promptVersion,
          };
          core.validateEditPlan(
            fresh,
            domain.Timeline.restore(created.timeline),
            context,
            registry,
            configuration,
          );
          return {
            runId: started.id,
            projectId: result.projectId,
            actorId: actor,
            apiOrigin,
            accessToken: access,
            csrf,
            capabilities,
            plan: fresh,
          };
        },
      });
    } finally {
      await leaseQueue.close(true);
    }
    phase = "unacknowledged-render-cancellation";
    // Separate adversarial lifecycle probe, not a second model/planning claim:
    // simulate a crash after real API admission but before attachRender commits.
    // Pause only this test's owned renderer, ensuring a queued admission rather
    // than racing an eight-second fixture that can finish before cancellation.
    execFileSync("docker", ["pause", renderContainer], { stdio: "ignore" });
    const cancelRun = await json(`/projects/${result.projectId}/agent-runs`, {
      idempotencyKey: core.newAgentId(),
      timelineId: snapshot.id,
      stateSha256: edited.stateSha256,
    });
    try {
      await runs.enableControlledReplay(
        actor,
        result.projectId,
        cancelRun.id,
        configuration,
        sdk.contentHash(capabilities),
      );
      const lease = await runs.claim(cancelRun.id);
      if (!lease) throw new Error("cleanup_lease_missing");
      for (const state of ["Observing", "Planning", "Executing", "Rendering"])
        await runs.move(lease, state);
      const intent = await runs.beginRender(lease);
      phase = "unacknowledged-render-admission";
      const accepted = await json(`/projects/${result.projectId}/timelines/${snapshot.id}/render`, {
        stateSha256: edited.stateSha256,
        requestId: "req_" + intent.receiptId.replaceAll("-", ""),
      });
      phase = "unacknowledged-render-cancellation";
      const cancelledRun = await json(
        `/projects/${result.projectId}/agent-runs/${cancelRun.id}/cancel`,
        {},
      );
      const { AuthenticatedTimelineRenderPort } = require(
        path.join(root, "workers/agent-worker/dist/render-port.js"),
      );
      // Uses the already opened real queue; this probe needs no consumer.
      const jobs = require("@editagent/job-queue"),
        cleanupQueue = new jobs.BullMqJobQueue(hostEnv.REDIS_URL);
      try {
        const port = new AuthenticatedTimelineRenderPort(
          pool,
          cleanupQueue,
          apiOrigin,
          async () => headers,
          permit,
        );
        await assert.rejects(
          port.cancel(cancelRun.id, result.projectId, accepted.jobId, cancelledRun.generation - 1),
          core.AgentError,
        );
        await assert.rejects(
          port.cancel(cancelRun.id, core.newAgentId(), accepted.jobId, cancelledRun.generation),
          core.AgentError,
        );
        await assert.rejects(
          port.cancel(cancelRun.id, result.projectId, jobId, cancelledRun.generation),
          core.AgentError,
        );
        assert.equal(await cleanupQueue.isCancelRequested(accepted.jobId), false);
        let release,
          entered = false,
          cancelRequests = 0;
        const barrier = new Promise((resolve) => {
          release = resolve;
        });
        const originalRequest = cleanupQueue.requestCancel.bind(cleanupQueue);
        cleanupQueue.requestCancel = async (id) => {
          cancelRequests++;
          entered = true;
          await barrier;
          await originalRequest(id);
        };
        const claimName = "qa88-terminal-claim-" + randomBytes(6).toString("hex"),
          claimPool = new Pool({
            connectionString: hostEnv.DATABASE_URL,
            application_name: claimName,
            max: 1,
          });
        const cancelling = port
          .cancel(cancelRun.id, result.projectId, null, cancelledRun.generation)
          .then(
            () => true,
            () => false,
          );
        let takingOver;
        const until = async (check) => {
          const end = Date.now() + 5000;
          while (Date.now() < end) {
            if (await check()) return;
            await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
          }
          throw new Error("terminal_cancel_lock_not_observed");
        };
        try {
          phase = "terminal-cancel-claim-linearization";
          await until(async () => entered);
          takingOver = new core.PostgresAgentRuns(claimPool, permit).claim(cancelRun.id);
          await until(
            async () =>
              Number(
                (
                  await pool.query(
                    "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0",
                    [claimName],
                  )
                ).rows[0].count,
              ) === 1,
          );
          release();
          assert.equal(await cancelling, true);
          assert.equal(await takingOver, null);
          await port.cancel(cancelRun.id, result.projectId, null, cancelledRun.generation);
          assert.equal(cancelRequests, 1);
        } finally {
          release();
          await cancelling;
          await takingOver?.catch(() => undefined);
          await claimPool.end();
        }
      } finally {
        await cleanupQueue.close(true);
      }
      phase = "unacknowledged-render-status";
      const cancelled = await json(`/projects/${result.projectId}/exports/${accepted.jobId}`);
      if (cancelled.status !== "Cancelled") throw new Error("unacknowledged_render_not_cancelled");
      phase = "cancelled-export-download-fence";
      const forbiddenLink = await globalThis.fetch(
        apiOrigin + `/projects/${result.projectId}/exports/${accepted.jobId}/download`,
        { headers, signal: globalThis.AbortSignal.timeout(5000) },
      );
      if (forbiddenLink.status !== 409) throw new Error("cancelled_export_not_fenced");
      await forbiddenLink.body?.cancel();
    } finally {
      execFileSync("docker", ["unpause", renderContainer], { stdio: "ignore" });
    }
    await writeFile(
      path.join(directory, "report.json"),
      JSON.stringify(
        {
          status: "PASS",
          ...codeIdentity,
          runId,
          projectId: result.projectId,
          timelineId: snapshot.id,
          originalTimelineSha256: sourceSha256,
          editedTimelineSha256: edited.stateSha256,
          modelEvidence: "synthetic_replay",
          liveProviderQualified: false,
          productionPlannerEnabled: false,
          actualPackagedWorker: true,
          actualPostgresRedisToolSdk: true,
          actualRender: true,
          actualBrowser: true,
          actualPlayback: true,
          actualDownload: true,
          actualUnacknowledgedQueuedRenderCancellation: true,
          leaseRecovery,
          terminalCancellationSerializedWithClaim: true,
          providerMeasuredUsage: null,
          syntheticUsage: {
            unit: "synthetic_model_tokens",
            calls: calls.length,
            inputCount: calls.reduce((n, e) => n + e.model.receipt.usage.inputTokens, 0),
            outputCount: calls.reduce((n, e) => n + e.model.receipt.usage.outputTokens, 0),
            actualCostMicros: null,
          },
          contextSha256: context.sha256,
          promptId: context.summary.promptId,
          promptVersion: context.summary.promptVersion,
          templateHash: context.summary.templateHash,
          checkpoint: completed.checkpoint,
          renderJobId: jobId,
          export: {
            sha256: sha,
            bytes: bytes.length,
            durationSeconds: document.format.duration,
            videoCodec: v.codec_name,
            audioCodec: a.codec_name,
            width: v.width,
            height: v.height,
            frameRate: v.avg_frame_rate,
            framesVerified: frames.length,
          },
          acceptance: {
            trimSplitSlice: "PASS",
            fullUs305Ac1: "NOT_MET_DEPENDENCY",
            cp1: "NOT_VERIFIED",
            cp2: "NOT_MET",
            tinyArabic: "NOT_QUALIFIED",
          },
        },
        null,
        2,
      ) + "\n",
    );
  } catch {
    await writeFile(
      path.join(directory, "report.json"),
      JSON.stringify({ status: "FAIL", phase, ...codeIdentity, runId, fullScopeProven: false }) +
        "\n",
    );
    throw new Error(
      `Controlled agent proof failed at ${phase}; sensitive operands are not logged.`,
    );
  } finally {
    await browser?.close();
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already removed */
    }
    await pool.end();
  }
}
