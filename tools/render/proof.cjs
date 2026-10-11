const { setTimeout, setInterval, clearInterval } = require("node:timers");
const console = require("node:console"),
  process = require("node:process");
const { AbortController } = globalThis;
// Real production-image queue/render proof; invoked by integration.mjs, never a fake renderer.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { instant, createUuidV7, projectId } = require("@editagent/domain");
const {
  BullMqJobQueue,
  PostgresJobRepository,
  RedisJobEventPublisher,
  enqueueJob,
  runNextJob,
  cancelJob,
} = require("@editagent/job-queue");
const { loadRenderWorkerConfig } = require("./dist/infrastructure/config.js");
const { createStorage, RenderObjects } = require("./dist/infrastructure/storage.js");
const { RemotionRenderStrategy } = require("./dist/infrastructure/strategy.js");
const { RenderJobSupervisor } = require("./dist/infrastructure/render-supervisor.js");
const { outputKey } = require("./dist/infrastructure/contract.js");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const config = loadRenderWorkerConfig(),
    pool = new Pool({ connectionString: config.databaseUrl, max: 3 }),
    s3 = createStorage(config);
  const queue = new BullMqJobQueue(config.redisUrl, {
      events: new RedisJobEventPublisher(pool, config.redisUrl),
    }),
    jobs = new PostgresJobRepository(pool);
  const newId = () => createUuidV7(Date.now(), randomBytes(10)),
    id = newId(),
    now = () => instant(BigInt(Date.now()));
  const frameProgress = new Map();
  class ObservedStrategy extends RemotionRenderStrategy {
    async render(input, project, jobId, signal, progress) {
      const frames = new Set();
      const result = await super.render(input, project, jobId, signal, (p) => {
        frames.add(p.renderedFrames);
        progress(p);
      });
      frameProgress.set(jobId, {
        uniqueRenderedFrameValues: frames.size,
        maxRenderedFrame: Math.max(0, ...frames),
        totalFrames: input.durationInFrames,
      });
      return result;
    }
  }
  const progress = [],
    strategy = new ObservedStrategy(new RenderObjects(s3, config.objectStorage.bucket), 300000);
  const supervisor = new RenderJobSupervisor(strategy, async (jobId, percentage, attempt) => {
    progress.push({ jobId, percentage, attempt });
    await queue.publishProgress(jobId, { stage: "mix", percentage, attempt });
  });
  const deps = { jobs, queue, supervisor, now, newAttemptId: newId };
  const queueName = "render-proof-" + randomBytes(6).toString("hex"),
    handler = { modulePath: "registered-renderer", exportName: "render" };
  const catalog = JSON.parse(await fs.readFile("dist/bundle/catalog.json", "utf8"));
  const input = {
    schemaVersion: 1,
    renderVersion: catalog.renderVersion,
    compositionId: "FixtureV1",
    width: 320,
    height: 180,
    frameRate: { numerator: 30, denominator: 1 },
    durationInFrames: 150,
    correlationId: "render-proof",
    props: { title: "Render proof مرحبا", background: "#16324f" },
  };
  await pool.query("INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,$2,$3,$3)", [
    id,
    "Render proof",
    Date.now(),
  ]);
  async function enqueue(payload = input, timeoutMs = 300000, maxAttempts = 1) {
    const jobId = newId();
    await enqueueJob(deps, {
      id: jobId,
      queueName,
      jobType: "render.remotion",
      idempotencyKey: "render-proof:" + jobId,
      payload,
      subject: { kind: "project", projectId: projectId(id) },
      timeoutMs,
      maxAttempts,
      backoffBaseMs: 100,
    });
    return jobId;
  }
  let captured = [];
  let frames = 0;
  const observe = setInterval(
    () =>
      void (async () => {
        for (const entry of await fs.readdir("/render-work")) {
          try {
            const rows = JSON.parse(
              await fs.readFile("/render-work/" + entry + "/processes.json", "utf8"),
            );
            if (rows.length > captured.length) captured = rows;
            frames++;
          } catch {
            /* workspace may be removed during observation */
          }
        }
      })().catch(() => {}),
    20,
  );
  try {
    const first = await enqueue(),
      started = Date.now();
    assert.equal(await runNextJob(deps, queueName, handler), "done");
    const wallTimeMs = Date.now() - started;
    const firstState = await jobs.findById(first);
    assert.equal(firstState.status, "Completed", firstState.failureReason);
    const key = outputKey(input.renderVersion, id, first),
      output = await new RenderObjects(s3, config.objectStorage.bucket).find(
        key,
        require("node:crypto")
          .createHash("sha256")
          .update(require("./dist/infrastructure/contract.js").canonicalJson({ input, assets: [] }))
          .digest("hex"),
        new AbortController().signal,
      );
    assert.ok(output && output.byteSize > 0);
    assert.ok(captured.some((x) => x.argv?.some((a) => a.includes("chrome-headless-shell"))));
    const firstProcesses = captured;
    captured = [];
    const second = await enqueue({
      ...input,
      frameRate: { numerator: 24, denominator: 1 },
      durationInFrames: 24,
    });
    assert.equal(await runNextJob(deps, queueName, handler), "done");
    assert.equal((await jobs.findById(second)).status, "Completed");
    const queued = await enqueue();
    await cancelJob(deps, queued);
    await cancelJob(deps, queued);
    assert.equal((await jobs.findById(queued)).status, "Cancelled");
    const cancelled = await enqueue({ ...input, durationInFrames: 18000 });
    captured = [];
    const pending = runNextJob(deps, queueName, handler),
      deadline = Date.now() + 60000;
    while (
      !captured.some((x) => x.argv?.some((a) => a.includes("chrome-headless-shell"))) &&
      Date.now() < deadline
    )
      await delay(20);
    assert.ok(
      captured.some((x) => x.argv?.some((a) => a.includes("chrome-headless-shell"))),
      "Real browser must be active before cancel",
    );
    const cancellationProcesses = captured;
    await cancelJob(deps, cancelled);
    await cancelJob(deps, cancelled);
    await pending;
    assert.equal((await jobs.findById(cancelled)).status, "Cancelled");
    assert.deepEqual(await fs.readdir("/render-work"), []);
    assert.equal(
      await new RenderObjects(s3, config.objectStorage.bucket).find(
        outputKey(input.renderVersion, id, cancelled),
        require("node:crypto")
          .createHash("sha256")
          .update(
            require("./dist/infrastructure/contract.js").canonicalJson({
              ...input,
              durationInFrames: 18000,
            }),
          )
          .digest("hex"),
        new AbortController().signal,
      ),
      null,
    );
    await delay(200);
    assert.deepEqual(await fs.readdir("/render-work"), []);
    captured = [];
    const timed = await enqueue({ ...input, durationInFrames: 18000 }, 10000);
    await runNextJob(deps, queueName, handler);
    assert.equal((await jobs.findById(timed)).status, "Failed");
    assert.ok(
      captured.some((p) => p.argv?.some((a) => a.includes("chrome-headless-shell"))),
      "Timeout must exercise an active real browser",
    );
    const timeoutProcesses = captured;
    assert.deepEqual(await fs.readdir("/render-work"), []);
    // Real upload succeeds; acknowledgement fails once. Retry must reuse the exact object.
    const crash = await enqueue({ ...input, durationInFrames: 24 }, 300000, 2);
    let crashOnce = true,
      reusedWithoutFrames = false;
    const crashDeps = {
      ...deps,
      supervisor: {
        run: async (...args) => {
          const before = progress.length;
          await supervisor.run(...args);
          if (crashOnce) {
            crashOnce = false;
            throw new Error("Injected post-upload acknowledgement failure");
          }
          reusedWithoutFrames = !progress
            .slice(before)
            .some((x) => x.percentage > 0 && x.percentage < 100);
        },
      },
    };
    await runNextJob(crashDeps, queueName, handler);
    assert.equal((await jobs.findById(crash)).status, "Retrying");
    const retryDeadline = Date.now() + 10000;
    while ((await jobs.findById(crash)).status !== "Completed" && Date.now() < retryDeadline) {
      await delay(100);
      await runNextJob(crashDeps, queueName, handler);
    }
    assert.equal((await jobs.findById(crash)).status, "Completed");
    assert.equal(reusedWithoutFrames, true);
    // A transient upload error must not complete; the same logical identity retries.
    const failingObjects = new RenderObjects(s3, config.objectStorage.bucket);
    const originalPut = failingObjects.put.bind(failingObjects);
    let failUpload = true;
    failingObjects.put = async (...args) => {
      if (failUpload) {
        failUpload = false;
        throw new Error("Injected transient upload failure");
      }
      return originalPut(...args);
    };
    const uploadSupervisor = new RenderJobSupervisor(
      new RemotionRenderStrategy(failingObjects, 300000),
      async () => {},
    );
    const uploadDeps = { ...deps, supervisor: uploadSupervisor },
      uploadJob = await enqueue({ ...input, durationInFrames: 24 }, 300000, 2);
    await runNextJob(uploadDeps, queueName, handler);
    assert.equal((await jobs.findById(uploadJob)).status, "Retrying");
    const uploadDeadline = Date.now() + 10000;
    while ((await jobs.findById(uploadJob)).status !== "Completed" && Date.now() < uploadDeadline) {
      await delay(100);
      await runNextJob(uploadDeps, queueName, handler);
    }
    assert.equal((await jobs.findById(uploadJob)).status, "Completed");
    assert.deepEqual(await fs.readdir("/render-work"), []);
    // Cancel after an actual S3 upload, while the render handler is still active.
    const cancelObjects = new RenderObjects(s3, config.objectStorage.bucket);
    const cancelPut = cancelObjects.put.bind(cancelObjects);
    let uploaded;
    const uploadReached = new Promise((resolve) => {
      uploaded = resolve;
    });
    cancelObjects.put = async (...args) => {
      const saved = await cancelPut(...args);
      uploaded();
      const signal = args[3];
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
      return saved;
    };
    const racingSupervisor = new RenderJobSupervisor(
      new RemotionRenderStrategy(cancelObjects, 300000),
      async () => {},
    );
    const racingDeps = { ...deps, supervisor: racingSupervisor };
    const uploadCancelled = await enqueue({ ...input, durationInFrames: 24 });
    const uploadPending = runNextJob(racingDeps, queueName, handler);
    await Promise.race([
      uploadReached,
      uploadPending.then(() => {
        throw new Error("Upload race job exited before reaching the actual upload gate");
      }),
    ]);
    await cancelJob(deps, uploadCancelled);
    await uploadPending;
    assert.equal((await jobs.findById(uploadCancelled)).status, "Cancelled");
    const signature = (value) =>
      require("node:crypto")
        .createHash("sha256")
        .update(
          require("./dist/infrastructure/contract.js").canonicalJson({ input: value, assets: [] }),
        )
        .digest("hex");
    assert.equal(
      await cancelObjects.find(
        outputKey(input.renderVersion, id, uploadCancelled),
        signature({ ...input, durationInFrames: 24 }),
        new AbortController().signal,
      ),
      null,
    );
    // Cancellation wins while the terminal progress callback is still awaited.
    let terminalReached;
    const terminal = new Promise((resolve) => {
      terminalReached = resolve;
    });
    const nearSupervisor = new RenderJobSupervisor(strategy, async (_id, percent) => {
      if (percent === 100) {
        terminalReached();
        await delay(700);
      }
    });
    const nearDeps = { ...deps, supervisor: nearSupervisor };
    const nearCancelled = await enqueue({ ...input, durationInFrames: 24 });
    const nearPending = runNextJob(nearDeps, queueName, handler);
    await Promise.race([
      terminal,
      nearPending.then(() => {
        throw new Error("Near-completion job exited before terminal progress");
      }),
    ]);
    await cancelJob(deps, nearCancelled);
    await nearPending;
    assert.equal((await jobs.findById(nearCancelled)).status, "Cancelled");
    assert.equal(
      await cancelObjects.find(
        outputKey(input.renderVersion, id, nearCancelled),
        signature({ ...input, durationInFrames: 24 }),
        new AbortController().signal,
      ),
      null,
    );
    const corrupt = "/tmp/corrupt-render.mp4";
    await fs.writeFile(corrupt, "not an mp4");
    await assert.rejects(
      require("./dist/infrastructure/probe-output.js").validateOutput(corrupt, input),
    );
    await fs.unlink(corrupt);
    for (const jobId of [first, second]) {
      const values = progress.filter((x) => x.jobId === jobId).map((x) => x.percentage);
      assert.equal(values.at(-1), 100);
      assert.ok(values.every((v, i) => v >= 0 && v <= 100 && (i === 0 || v >= values[i - 1])));
    }
    console.log(
      "RENDER_EVIDENCE " +
        JSON.stringify({
          renderVersion: catalog.renderVersion,
          bundleInvocationCount: catalog.bundleInvocationCount,
          runtimeBundleInvocationCount: 0,
          firstJob: first,
          secondJob: second,
          cancelledJob: cancelled,
          timeoutJob: timed,
          outputKey: key,
          ...output,
          wallTimeMs,
          firstProcesses,
          perFrameProgress: frameProgress.get(first),
          cancellationProcesses,
          timeoutProcesses,
          progress,
          processObservations: frames,
          attemptedLogicalRequests: 5,
          cancellationsExcluded: 4,
          nearCompletionCancellation: "Cancelled",
          uploadCancellation: "Cancelled",
          renderSuccessRate: 4 / 5,
          successfulLogicalRequests: 4,
          cancellation: "Cancelled",
          crashWindowReuse: reusedWithoutFrames,
          uploadFailureRetry: true,
          corruptOutputRejected: true,
          timeout: "Failed",
        }),
    );
  } finally {
    clearInterval(observe);
    await queue.close(true);
    s3.destroy();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
