// Real PG/Redis/BullMQ/S3 + constrained production executors. No renderer mocks.
const { AbortController } = globalThis;
const { Buffer } = require("node:buffer"),
  { setTimeout } = require("node:timers");
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  process = require("node:process"),
  console = require("node:console");
const { randomBytes, createHash } = require("node:crypto"),
  { Pool } = require("pg");
const { createUuidV7, instant, frameTime } = require("@editagent/domain");
const { BullMqJobQueue, RedisJobEventPublisher, runNextJob } = require("@editagent/job-queue");
const { loadRenderWorkerConfig } = require("./dist/infrastructure/config.js"),
  { createStorage, RenderObjects, workspace } = require("./dist/infrastructure/storage.js");
const { createEditingRuntime } = require("./dist/infrastructure/editing-runtime.js"),
  { FFmpegRenderStrategy, RemotionRenderStrategy } = require("./dist/infrastructure/strategy.js"),
  { PostgresRenderAssetResolver } = require("./dist/infrastructure/asset-resolver.js"),
  { RenderJobSupervisor } = require("./dist/infrastructure/render-supervisor.js"),
  { publishRenderJob } = require("./dist/infrastructure/publish-render.js"),
  { canonicalJson, outputKey, parseRenderInput } = require("./dist/infrastructure/contract.js");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
async function main() {
  const c = loadRenderWorkerConfig(),
    pool = new Pool({ connectionString: c.databaseUrl, max: 6 }),
    s3 = createStorage(c),
    queue = new BullMqJobQueue(c.redisUrl, {
      events: new RedisJobEventPublisher(pool, c.redisUrl),
    });
  class ObservedObjects extends RenderObjects {
    engines = new Map();
    putCount = 0;
    async put(...args) {
      this.putCount++;
      if (args[0].startsWith("renders/")) {
        const meta = JSON.parse(
          await fs.readFile(path.join(path.dirname(args[2]), "output.json"), "utf8"),
        );
        this.engines.set(args[0], meta.engine ?? "remotion");
      }
      return super.put(...args);
    }
  }
  const objects = new ObservedObjects(s3, c.objectStorage.bucket),
    plainObjects = new RenderObjects(s3, c.objectStorage.bucket),
    runtime = createEditingRuntime(pool, queue, objects, {
      costMicros: c.editingCostMicros,
      projectBudgetMicros: c.editingProjectBudgetMicros,
    });
  const id = () => createUuidV7(Date.now(), randomBytes(10)),
    project = process.env.EDITAGENT_PROOF_PROJECT,
    actor = id(),
    sources = JSON.parse(process.env.EDITAGENT_AUDIO_CUT_SOURCES),
    catalog = JSON.parse(await fs.readFile("dist/bundle/catalog.json", "utf8"));
  const resolver = new PostgresRenderAssetResolver(pool),
    fast = new FFmpegRenderStrategy(objects, 300000, resolver),
    remotion = new RemotionRenderStrategy(objects, 300000, resolver);
  const renderDeps = {
    ...runtime.deps,
    supervisor: new RenderJobSupervisor(fast, (job, percentage, attempt) =>
      queue.publishProgress(job, { stage: "mix", percentage, attempt }),
    ),
    now: () => instant(BigInt(Date.now())),
    newAttemptId: id,
  };
  const daemon = await (async () => {
    for (const pid of (await fs.readdir("/proc")).filter((p) => /^[0-9]+$/.test(p))) {
      try {
        if ((await fs.readFile(`/proc/${pid}/cmdline`, "utf8")) === "node\0dist/index.js\0")
          return Number(pid);
      } catch {
        /* exited */
      }
    }
  })();
  assert.ok(daemon);
  process.kill(daemon, "SIGSTOP");
  let stopped = false;
  const pump = (async () => {
    let turn = false;
    while (!stopped) {
      turn = !turn;
      const r = await runNextJob(
        turn ? runtime.deps : renderDeps,
        turn ? "tools-render-v1" : "render-remotion-v1",
        { modulePath: "registered-renderer", exportName: "render" },
      );
      if (r === "idle") await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const artifacts = [];
  let retryInput, retryJob;
  try {
    await pool.query(
      "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',0,0)",
      [actor, actor + "@example.test"],
    );
    await pool.query(
      "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'editor',0)",
      [project, actor],
    );
    function inputFor(n, d, segments, totalFrames) {
      const rate = { numerator: BigInt(n), denominator: BigInt(d) },
        us = (f) => frameTime(BigInt(f), rate).toString(),
        tid = id(),
        track = id();
      const used = [...new Set(segments.filter((s) => s.source).map((s) => s.source))];
      return {
        schemaVersion: 1,
        renderVersion: catalog.renderVersion,
        compositionId: "TimelineV1",
        correlationId: "qa53-bframes",
        props: {
          background: "#000000",
          captionStyle: {
            color: "#ffffff",
            background: "#000000",
            fontSize: 24,
            direction: "auto",
          },
          components: [],
          timeline: {
            id: tid,
            projectId: project,
            createdAt: "0",
            composition: {
              width: 64,
              height: 64,
              frameRate: { numerator: String(n), denominator: String(d) },
              durationUs: us(totalFrames),
            },
            sources: used.map((s) => ({ id: s.id, kind: "video", durationUs: s.durationUs })),
            tracks: [
              {
                id: track,
                timelineId: tid,
                kind: "video",
                transitions: [],
                clips: segments
                  .filter((s) => s.source)
                  .map((s) => ({
                    id: id(),
                    trackId: track,
                    kind: "video",
                    timelineStartUs: us(s.from),
                    inPoint: us(s.start),
                    outPoint: us(s.start + s.frames),
                    sourceId: s.source.id,
                    text: null,
                    componentId: null,
                    effects: [],
                    opacity: 1,
                    volumeDb: 0,
                  })),
              },
            ],
          },
        },
      };
    }
    const plans = [];
    for (const [n, d] of [
      [25, 1],
      [30, 1],
      [30000, 1001],
      [24000, 1001],
      [60000, 1001],
    ]) {
      const mono = sources.find((s) => s.n === n && s.layout === "mono48"),
        stereo = sources.find((s) => s.n === n && s.layout === "stereo44"),
        none = sources.find((s) => s.n === n && s.layout === "none");
      const clip = (start, frames, from, source = mono) => ({ start, frames, from, source });
      // A frame placement must also obey the existing 1:1 integer-us domain.
      // Author these additional fixture ranges before inference with matching
      // rounding phase; never relax the selector or timeline invariants.
      const phaseClip = (start, frames, from, source = mono) => {
        const rate = { numerator: BigInt(n), denominator: BigInt(d) },
          us = (f) => frameTime(BigInt(f), rate);
        for (let offset = 0; offset < 3; offset++)
          if (us(start + offset + frames) - us(start + offset) === us(from + frames) - us(from))
            return clip(start + offset, frames, from, source);
        throw new Error("Fixture frame rounding phase is unsupported");
      };
      const cases = {
        backward: [
          clip(10, 20, 0),
          { from: 20, frames: 5 },
          clip(50, 12, 25),
          clip(10, 5, 37),
          { from: 42, frames: 3 },
        ],
        repeat: n !== 25 ? [clip(12, 6, 0), clip(12, 6, 6)] : [clip(12, 5, 0), clip(12, 5, 5)],
        forward: [clip(10, 20, 0), clip(50, 12, 20)],
        overlap: [clip(10, 20, 0), clip(15, 10, 20)],
        layouts:
          n !== 25
            ? [
                clip(9, 9, 0),
                clip(18, 9, 9, none),
                clip(30, 9, 18, stereo),
                { from: 27, frames: 5 },
              ]
            : [
                clip(10, 10, 0),
                clip(20, 10, 10, none),
                clip(30, 10, 20, stereo),
                { from: 30, frames: 5 },
              ],
        short: [clip(12, 1, 0), { from: 1, frames: 1 }, clip(n !== 25 ? 59 : 58, 2, 2)],
        mute: [clip(12, 1, 0, none), { from: 1, frames: 1 }, clip(n !== 25 ? 59 : 58, 2, 2, none)],
        "gap-56": [
          phaseClip(10, 14, 0),
          { from: 14, frames: 2 },
          phaseClip(30, 33, 16),
          { from: 49, frames: 2 },
          phaseClip(100, 5, 51),
        ],
        "gap-58-max": [
          ...[10, 50, 12, 100, 30, 58, 10, 100].flatMap((start, i) => [
            { from: i * 7, frames: 2 },
            phaseClip(start, 5, i * 7 + 2),
          ]),
          { from: 56, frames: 2 },
        ],
        "one-gap": [phaseClip(10, 14, 0), { from: 14, frames: 2 }, phaseClip(100, 5, 16)],
        "edge-gaps": [
          { from: 0, frames: 1 },
          phaseClip(10, 14, 1),
          { from: 15, frames: 2 },
          phaseClip(30, 33, 17),
          { from: 50, frames: 1 },
          phaseClip(100, 5, 51),
          { from: 56, frames: 2 },
        ],
        "mixed-short-gaps": [
          phaseClip(12, 1, 0),
          { from: 1, frames: 2 },
          phaseClip(100, 5, 3, none),
          { from: 8, frames: 1 },
          phaseClip(50, 12, 9, stereo),
          { from: 21, frames: 2 },
        ],
      };
      if (n === 25) {
        const exact = sources.find((s) => s.layout === "h1exact");
        cases["h1-exact-beeps"] = [
          clip(10, 20, 0, exact),
          { from: 20, frames: 5 },
          clip(50, 12, 25, exact),
          clip(10, 5, 37, exact),
          { from: 42, frames: 3 },
        ];
      }
      for (const [label, segments] of Object.entries(cases)) {
        const frames = segments.reduce((sum, s) => sum + s.frames, 0),
          input = inputFor(n, d, segments, frames);
        // Integer microsecond snapshots must be valid before any render starts;
        // rounded fractional frame arithmetic must not bypass domain invariants.
        parseRenderInput(input);
        plans.push({ n, d, label, segments, frames, input });
      }
    }
    for (const { n, d, label, segments, frames, input } of plans) {
      const jobId = id();
      console.log("AUDIO_QUEUE_RENDER", n, label);
      await publishRenderJob(renderDeps, pool, {
        jobId,
        projectId: project,
        actorId: actor,
        input,
        timeoutMs: 300000,
      });
      const end = Date.now() + 300000;
      let job;
      do {
        job = await runtime.deps.jobs.findById(jobId);
        if (["Completed", "Failed", "Cancelled"].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 10));
      } while (Date.now() < end);
      assert.equal(job.status, "Completed", `${n} ${label}`);
      const key = outputKey(catalog.renderVersion, project, jobId),
        artifact = await fast.render(input, project, jobId, new AbortController().signal, () => {});
      assert.equal(
        objects.engines.get(key),
        "ffmpeg",
        "Actual eligible B-frame sources must use FFmpeg",
      );
      const spec = {
        label: `qa53-${n}-${label}`,
        key,
        sha256: artifact.sha256,
        frames,
        n,
        d,
        hasAudio: segments.some((s) => s.source?.hasAudio),
        job: { id: jobId, status: job.status, attemptCount: job.attemptCount },
        segments: segments.map((s) => ({
          from: s.from,
          frames: s.frames,
          start: s.start ?? null,
          hasAudio: s.source?.hasAudio ?? false,
          media: Boolean(s.source),
          markerFrames: s.source?.beepFrames,
        })),
      };
      artifacts.push(spec);
      if (!retryInput) {
        retryInput = input;
        retryJob = jobId;
      }
      if (label === "backward" || (n === 30000 && label === "gap-56")) {
        const reference = await remotion.render(
          input,
          project,
          id(),
          new AbortController().signal,
          () => {},
        );
        artifacts.push({
          ...spec,
          label: `qa53-${n}-remotion-${label}`,
          key: reference.objectKey,
          sha256: reference.sha256,
          reference: true,
        });
      }
    }
    // Force Remotion directly so the CFR-routing fix cannot hide inherited M2.
    const source = sources.find((s) => s.n === 30 && s.layout === "mono48");
    for (const frames of [50, 75]) {
      const segments = [{ source, start: frames === 50 ? 10 : 0, frames, from: 0 }],
        input = inputFor(30, 1, segments, frames);
      const artifact = await remotion.render(
        input,
        project,
        id(),
        new AbortController().signal,
        () => {},
      );
      artifacts.push({
        label: `qa53-remotion-end-${frames}`,
        key: artifact.objectKey,
        sha256: artifact.sha256,
        frames,
        n: 30,
        d: 1,
        hasAudio: true,
        reference: true,
        segments: [{ from: 0, frames, start: segments[0].start, media: true, hasAudio: true }],
      });
    }
    const slowed = await runtime.executor.execute({
      name: "editing.change-speed",
      version: "1.0.0",
      callerId: actor,
      projectId: project,
      resource: { kind: "asset", id: source.id },
      input: { assetId: source.id, numerator: 1, denominator: 3 },
    });
    const slowAsset = slowed.output.asset.artifact;
    artifacts.push({
      label: "qa53-speed-third",
      key: slowAsset.storageKey,
      sha256: slowAsset.sha256,
      frames: source.frames * 3,
      n: 30,
      d: 1,
      hasAudio: true,
      speedDiagnostic: true,
    });
    const fractional = sources.find((s) => s.layout === "179");
    const resized = await runtime.executor.execute({
      name: "editing.resize-video",
      version: "1.0.0",
      callerId: actor,
      projectId: project,
      resource: { kind: "asset", id: fractional.id },
      input: { assetId: fractional.id, width: 128, height: 128 },
    });
    const r = resized.output.asset.artifact;
    artifacts.push({
      label: "qa53-resize-179",
      key: r.storageKey,
      sha256: r.sha256,
      frames: 179,
      n: 30000,
      d: 1001,
      hasAudio: false,
      resize: true,
    });
    const tailSource = sources.find((s) => s.layout === "179-tail");
    const tailResize = await runtime.executor.execute({
      name: "editing.resize-video",
      version: "1.0.0",
      callerId: actor,
      projectId: project,
      resource: { kind: "asset", id: tailSource.id },
      input: { assetId: tailSource.id, width: 128, height: 128 },
    });
    assert.equal(tailResize.record.outcome, "succeeded");
    const tailAsset = tailResize.output.asset.artifact;
    artifacts.push({
      label: "qa53r-resize-179-tail",
      key: tailAsset.storageKey,
      sha256: tailAsset.sha256,
      frames: 179,
      n: 30000,
      d: 1001,
      hasAudio: true,
      resize: true,
      aacTailSource: true,
      audit: {
        id: tailResize.record.id,
        outcome: tailResize.record.outcome,
        costBasis: tailResize.record.costBasis,
        costMicros: tailResize.record.costMicros,
      },
    });
    // Revoke a distinct member only after genuine production FFmpeg execution
    // starts. The existing publication fence must deny it before any S3 PUT.
    const revokedActor = id();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',0,0)",
      [revokedActor, revokedActor + "@example.test"],
    );
    await pool.query(
      "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'editor',0)",
      [project, revokedActor],
    );
    const putsBeforeRevocation = objects.putCount;
    const revocationRun = runtime.executor
      .execute({
        name: "editing.resize-video",
        version: "1.0.0",
        callerId: revokedActor,
        projectId: project,
        resource: { kind: "asset", id: source.id },
        input: { assetId: source.id, width: 4096, height: 2024 },
      })
      .then(
        () => assert.fail("Revoked member published media"),
        (error) => error,
      );
    let renderingObserved = false;
    const revocationWatchdog = Date.now() + 20000;
    while (!renderingObserved && Date.now() < revocationWatchdog) {
      for (const token of await fs.readdir("/render-work")) {
        try {
          const processes = JSON.parse(
            await fs.readFile(`/render-work/${token}/processes.json`, "utf8"),
          );
          if (processes.some((p) => p.argv?.[0]?.endsWith("ffmpeg"))) {
            renderingObserved = true;
            break;
          }
        } catch {
          /* execution has not reached its actual FFmpeg process */
        }
      }
      if (!renderingObserved) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(renderingObserved, true, "Revocation requires actual active media processing");
    assert.equal(
      (
        await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
          project,
          revokedActor,
        ])
      ).rowCount,
      1,
    );
    const revocationError = await revocationRun;
    // The durable active fence cancels revoked admission; the live permission
    // check denies it. Both existing contracts prohibit successful publication.
    assert.ok(["cancelled", "denied"].includes(revocationError.code));
    assert.equal(objects.putCount, putsBeforeRevocation, "No S3 write after mid-render revocation");
    const revocationS3Writes = objects.putCount - putsBeforeRevocation;
    const revocationAudit = (
      await pool.query(
        "SELECT id,outcome,code,cost_basis,cost_micros::text,cleanup_status FROM tool_executions WHERE caller_id=$1",
        [revokedActor],
      )
    ).rows[0];
    assert.equal(
      revocationAudit.outcome,
      revocationError.code === "cancelled" ? "cancelled" : "failed",
    );
    assert.equal(revocationAudit.code, revocationError.code);
    assert.equal(
      (await runtime.deps.jobs.findById(revocationAudit.id)).status,
      revocationError.code === "cancelled" ? "Cancelled" : "Failed",
    );
    assert.equal((await runtime.deps.jobs.listAttempts(revocationAudit.id)).length, 1);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM editing_output_intents WHERE execution_id=$1 AND published=true",
          [revocationAudit.id],
        )
      ).rows[0].n,
      0,
    );
    await runtime.executor.recover();
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id,outcome,code,cost_basis,cost_micros::text,cleanup_status FROM tool_executions WHERE id=$1",
          [revocationAudit.id],
        )
      ).rows[0],
      revocationAudit,
    );
    // Corrupt persisted bytes through the test-only storage admin; normal writes
    // remain immutable. A retry must verify bytes before declaring success.
    const original = artifacts[0];
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const stored = await s3.send(
      new GetObjectCommand({ Bucket: c.objectStorage.bucket, Key: original.key }),
    );
    const saved = Buffer.from(await stored.Body.transformToByteArray()),
      bad = Buffer.from(saved);
    bad[bad.length - 1] ^= 1;
    await s3.send(
      new PutObjectCommand({
        Bucket: c.objectStorage.bucket,
        Key: original.key,
        Body: bad,
        ContentType: "video/mp4",
        Metadata: stored.Metadata,
      }),
    );
    await assert.rejects(
      fast.render(retryInput, project, retryJob, new AbortController().signal, () => {}),
      /checksum changed/,
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: c.objectStorage.bucket,
        Key: original.key,
        Body: saved,
        ContentType: "video/mp4",
        Metadata: stored.Metadata,
      }),
    );
    await fast.render(retryInput, project, retryJob, new AbortController().signal, () => {});
    const negativeJob = id(),
      negativeKey = outputKey(catalog.renderVersion, project, negativeJob);
    const signature = createHash("sha256")
      .update(
        canonicalJson({
          input: retryInput,
          assets: await resolver.resolve(
            project,
            retryInput.props.timeline.sources,
            new AbortController().signal,
          ),
        }),
      )
      .digest("hex");
    const stage = await workspace();
    let negativeIdentity;
    try {
      const good = path.join(stage.work, "good.mp4"),
        truncated = path.join(stage.work, "truncated.mp4");
      await fs.writeFile(good, saved);
      require("node:child_process").execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          good,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0",
          "-c:v",
          "copy",
          "-af",
          "atrim=end_sample=28000",
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          "2",
          truncated,
        ],
        { timeout: 10000 },
      );
      negativeIdentity = await plainObjects.put(
        negativeKey,
        signature,
        truncated,
        new AbortController().signal,
      );
    } finally {
      await stage.close();
    }
    await publishRenderJob(renderDeps, pool, {
      jobId: negativeJob,
      projectId: project,
      actorId: actor,
      input: retryInput,
      timeoutMs: 300000,
    });
    const negativeDeadline = Date.now() + 30000;
    let negative;
    do {
      negative = await runtime.deps.jobs.findById(negativeJob);
      if (["Completed", "Failed", "Cancelled"].includes(negative.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    } while (Date.now() < negativeDeadline);
    assert.equal(negative.status, "Failed", "Truncated cached MP4 must never complete");
    assert.equal(
      objects.engines.has(negativeKey),
      false,
      "No new successful publication of a truncated MP4",
    );
    // L4: precise real PG attachment boundary, before any durable queue Job.
    // The wrapper executes the real method and cancels only after its commit.
    const cancellation = new AbortController(),
      attach = runtime.audit.attachJob.bind(runtime.audit);
    runtime.audit.attachJob = async (...args) => {
      await attach(...args);
      cancellation.abort();
    };
    try {
      await assert.rejects(
        runtime.executor.execute(
          {
            name: "editing.resize-video",
            version: "1.0.0",
            callerId: actor,
            projectId: project,
            resource: { kind: "asset", id: source.id },
            input: { assetId: source.id, width: 128, height: 128 },
          },
          cancellation.signal,
        ),
        /cancelled/,
      );
    } finally {
      runtime.audit.attachJob = attach;
    }
    await Promise.all([runtime.executor.recover(), runtime.executor.recover()]);
    await runtime.executor.recover();
    const admissionCancel = (
      await pool.query(
        "SELECT e.id,e.outcome,e.job_id,e.cost_basis,e.cost_micros::text,j.status AS job_status,e.cleanup_status,EXISTS(SELECT 1 FROM editing_output_intents i WHERE i.execution_id=e.id) AS output_intent FROM tool_executions e LEFT JOIN jobs j ON j.id=e.job_id WHERE e.caller_id=$1 AND e.stop_code='cancelled' ORDER BY e.started_at_ms DESC LIMIT 1",
        [actor],
      )
    ).rows[0];
    assert.equal(admissionCancel.outcome, "cancelled");
    assert.equal(admissionCancel.job_status, null);
    assert.equal(admissionCancel.output_intent, false);
    console.log(
      "AUDIO_EVIDENCE " +
        JSON.stringify({
          artifacts,
          midRenderRevocation: {
            actualRenderingObserved: renderingObserved,
            s3PutCount: revocationS3Writes,
            audit: revocationAudit,
          },
          actualQueueRenders: plans.length,
          admissionCancel,
          repeatedBackwardSources: true,
          sourceLayouts: ["mono48", "stereo44", "none"],
          actualCfrEngine: "ffmpeg",
          remotionEndForced: true,
          mismatchRejected: true,
          truncatedCachedJob: negative.status,
          negativeArtifact: {
            label: "qa53-truncated-negative",
            key: negativeKey,
            sha256: negativeIdentity.sha256,
          },
          resizeFrames: 179,
          manifestTimeoutMs: runtime.registry.lookup("editing.resize-video", "1.0.0").manifest
            .timeoutMs,
        }),
    );
  } finally {
    stopped = true;
    await pump;
    process.kill(daemon, "SIGCONT");
    await queue.close();
    await pool.end();
    s3.destroy();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
