// Real production coordinator + networkless executor + PostgreSQL/BullMQ/S3 evidence.
const { AbortController, structuredClone, performance } = globalThis;
const process = require("node:process"),
  console = require("node:console"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  { randomBytes } = require("node:crypto"),
  { Pool } = require("pg");
const { createUuidV7, Timeline, replay, frameTime, instant } = require("@editagent/domain");
const { BullMqJobQueue, RedisJobEventPublisher, runNextJob } = require("@editagent/job-queue");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { setTimeout } = require("node:timers");
const { loadRenderWorkerConfig } = require("./dist/infrastructure/config.js"),
  { createStorage, RenderObjects } = require("./dist/infrastructure/storage.js"),
  { createEditingRuntime } = require("./dist/infrastructure/editing-runtime.js");
const {
    FFmpegRenderStrategy,
    RemotionRenderStrategy,
  } = require("./dist/infrastructure/strategy.js"),
  { PostgresRenderAssetResolver } = require("./dist/infrastructure/asset-resolver.js"),
  { renderEngine } = require("./dist/application/strategy-selection.js");
const { SelectingRenderStrategy } = require("./dist/application/strategy-selection.js"),
  { RenderJobSupervisor } = require("./dist/infrastructure/render-supervisor.js"),
  { publishRenderJob } = require("./dist/infrastructure/publish-render.js");
async function main() {
  const c = loadRenderWorkerConfig(),
    pool = new Pool({ connectionString: c.databaseUrl, max: 6 }),
    s3 = createStorage(c),
    queue = new BullMqJobQueue(c.redisUrl, {
      events: new RedisJobEventPublisher(pool, c.redisUrl),
    });
  class StorageFailure extends RenderObjects {
    enabled = false;
    engines = new Map();
    saved = new Map();
    async put(...args) {
      if (args[0].startsWith("renders/")) {
        const path = require("node:path");
        const metadata = JSON.parse(
          await fs.readFile(path.join(path.dirname(args[2]), "output.json"), "utf8"),
        );
        this.engines.set(args[0], metadata.engine ?? "remotion");
      }
      if (this.enabled) {
        this.enabled = false;
        const unavailable = new S3Client({
          endpoint: "http://127.0.0.1:9",
          region: "us-east-1",
          credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
          maxAttempts: 1,
          requestHandler: { connectionTimeout: 100, requestTimeout: 200 },
        });
        try {
          await unavailable.send(
            new PutObjectCommand({
              Bucket: "editagent",
              Key: args[0],
              Body: await fs.readFile(args[2]),
              IfNoneMatch: "*",
            }),
            { abortSignal: args[3] },
          );
        } finally {
          unavailable.destroy();
        }
      }
      const saved = await super.put(...args);
      this.saved.set(args[0], saved);
      return saved;
    }
  }
  const objects = new StorageFailure(s3, c.objectStorage.bucket),
    runtime = createEditingRuntime(pool, queue, objects, {
      costMicros: c.editingCostMicros,
      projectBudgetMicros: c.editingProjectBudgetMicros,
    });
  const id = () => createUuidV7(Date.now(), randomBytes(10)),
    project = process.env.EDITAGENT_PROOF_PROJECT,
    source = process.env.EDITAGENT_PROOF_SOURCE,
    actor = id(),
    viewer = id(),
    foreign = id();
  const catalog = JSON.parse(await fs.readFile("dist/bundle/catalog.json", "utf8")),
    before = (
      await pool.query(
        "SELECT storage_key,content_sha256,byte_size::text FROM media_assets WHERE id=$1",
        [source],
      )
    ).rows[0];
  const selection = new SelectingRenderStrategy(
    new FFmpegRenderStrategy(objects, 300000, new PostgresRenderAssetResolver(pool)),
    new RemotionRenderStrategy(objects, 300000, new PostgresRenderAssetResolver(pool)),
  );
  const selectedEngines = [];
  const observed = {
    render: async (...args) => {
      selectedEngines.push(renderEngine(args[0]));
      return selection.render(...args);
    },
    discard: (a) => selection.discard(a),
  };
  const renderDeps = {
    ...runtime.deps,
    supervisor: new RenderJobSupervisor(observed, (jobId, percentage, attempt) =>
      queue.publishProgress(jobId, { stage: "mix", percentage, attempt }),
    ),
    now: () => instant(BigInt(Date.now())),
    newAttemptId: id,
  };
  // Pause only this disposable container's daemon. Its exact production SDK/runtime
  // consumes the same real queue here, allowing deterministic infrastructure faults.
  const pids = await fs.readdir("/proc");
  let daemon;
  for (const pid of pids.filter((p) => /^[0-9]+$/.test(p))) {
    try {
      const command = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command === "node\0dist/index.js\0") daemon = Number(pid);
    } catch {
      /* exited */
    }
  }
  assert.ok(daemon, "Disposable coordinator daemon must be identifiable");
  process.kill(daemon, "SIGSTOP");
  let stopped = false;
  const pump = (async () => {
    let turn = false;
    while (!stopped) {
      turn = !turn;
      const r = await runNextJob(
        turn ? runtime.deps : renderDeps,
        turn ? "tools-render-v1" : "render-remotion-v1",
        {
          modulePath: "registered-tools",
          exportName: "handle",
        },
      );
      if (r === "idle") await new Promise((r) => setTimeout(r, 10));
    }
  })();
  try {
    for (const [who, role] of [
      [actor, "editor"],
      [viewer, "viewer"],
    ]) {
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$fixture',0,0)",
        [who, who + "@example.test"],
      );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,0)",
        [project, who, role],
      );
    }
    await pool.query(
      "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'Foreign proof',0,0)",
      [foreign],
    );
    await pool.query(
      "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',0)",
      [foreign, actor],
    );
    const tid = id(),
      track = id(),
      clip = id();
    const snapshot = {
      id: tid,
      projectId: project,
      createdAt: "0",
      composition: {
        width: 64,
        height: 64,
        frameRate: { numerator: "30", denominator: "1" },
        durationUs: "2000000",
      },
      sources: [{ id: source, kind: "video", durationUs: "2000000" }],
      tracks: [
        {
          id: track,
          timelineId: tid,
          kind: "video",
          transitions: [],
          clips: [
            {
              id: clip,
              trackId: track,
              kind: "video",
              inPoint: "0",
              outPoint: "2000000",
              timelineStartUs: "0",
              sourceId: source,
              text: null,
              componentId: null,
              opacity: 1,
              volumeDb: 0,
              effects: [],
            },
          ],
        },
      ],
    };
    await runtime.timelines.save(Timeline.restore(snapshot), null);
    const calls = [
      [
        "trim-video",
        { clipId: clip, startUs: "200000", endUs: "1800000" },
        { kind: "timeline", id: tid },
      ],
      ["split-video", { clipId: clip, atUs: "1000000" }, { kind: "timeline", id: tid }],
      [
        "concat-clips",
        {
          clips: [
            { assetId: source, startUs: "1000000", endUs: "2000000" },
            { assetId: source, startUs: "0", endUs: "1000000" },
          ],
        },
        { kind: "project", id: project },
      ],
      [
        "crop-video",
        { assetId: source, x: 0, y: 0, width: 32, height: 32 },
        { kind: "asset", id: source },
      ],
      ["resize-video", { assetId: source, width: 128, height: 64 }, { kind: "asset", id: source }],
      [
        "change-speed",
        { assetId: source, numerator: 2, denominator: 1 },
        { kind: "asset", id: source },
      ],
      [
        "normalize-audio",
        { assetId: source, targetLufs: -23, truePeakDb: -1, loudnessRange: 7 },
        { kind: "asset", id: source },
      ],
    ];
    const artifacts = [],
      records = [];
    for (const [name, input, resource] of calls) {
      console.log("EDITING_TOOL", name);
      const call = {
        name: "editing." + name,
        version: "1.0.0",
        callerId: actor,
        projectId: project,
        resource,
        input,
      };
      for (const denied of [
        { ...call, callerId: viewer },
        { ...call, projectId: foreign },
      ])
        await assert.rejects(runtime.executor.execute(denied), /denied|invalid_subject/);
      await assert.rejects(
        runtime.executor.execute({ ...call, input: { ...input, command: "-i http://metadata" } }),
        /invalid_input/,
      );
      const result = await runtime.executor.execute(call);
      assert.equal(result.record.outcome, "succeeded");
      records.push(result.record);
      if (result.commands.length) {
        const after = replay(Timeline.restore(snapshot), {
          schemaVersion: 1,
          timelineId: tid,
          commands: result.commands,
        });
        assert.equal(after.tracks[0].clips.length, name === "split-video" ? 2 : 1);
      } else {
        const asset = result.output.asset;
        artifacts.push({
          label: "tool-" + name,
          key: asset.artifact.storageKey,
          sha256: asset.artifact.sha256,
          metadata: asset.artifact.metadata,
          executionId: result.record.id,
          assetId: asset.id,
        });
        const job = (
          await pool.query("SELECT status,attempt_count FROM jobs WHERE id=$1", [
            result.record.jobId,
          ])
        ).rows[0];
        assert.equal(job.status, "Completed");
        assert.equal(job.attempt_count, 1);
        const count = await pool.query(
          "SELECT count(*)::int AS n FROM derived_assets WHERE id=$1",
          [asset.id],
        );
        assert.equal(count.rows[0].n, 1);
        // Completed remote receipt replay does not compute/upload another output.
        const receipt = await runtime.calls.result(result.record.id);
        assert.deepEqual(receipt.output, result.output);
      }
    }
    const crop = artifacts.find((a) => a.label === "tool-crop-video");
    const chained = await runtime.executor.execute({
      name: "editing.resize-video",
      version: "1.0.0",
      callerId: actor,
      projectId: project,
      resource: { kind: "asset", id: crop.assetId },
      input: { assetId: crop.assetId, width: 64, height: 64 },
    });
    assert.equal(chained.record.outcome, "succeeded");
    assert.equal(
      chained.output.asset.mediaAssetId,
      source,
      "A chained edit retains its original root FK",
    );
    artifacts.push({
      label: "tool-chained-resize",
      key: chained.output.asset.artifact.storageKey,
      sha256: chained.output.asset.artifact.sha256,
      metadata: chained.output.asset.artifact.metadata,
      executionId: chained.record.id,
    });
    const consumerInvalidInputCosts = [];
    const unsuitable = JSON.parse(process.env.EDITAGENT_CUT_SOURCES).filter(
      (s) => s.numerator === 30 && (!s.hasAudio || s.silence),
    );
    assert.equal(unsuitable.length, 2);
    for (const s of unsuitable) {
      await assert.rejects(
        runtime.executor.execute({
          name: "editing.normalize-audio",
          version: "1.0.0",
          callerId: actor,
          projectId: project,
          resource: { kind: "asset", id: s.id },
          input: { assetId: s.id, targetLufs: -23, truePeakDb: -1, loudnessRange: 7 },
        }),
        /invalid_input/,
      );
      const failed = (
        await pool.query(
          "SELECT e.outcome,e.code,e.cleanup_status,e.cost_micros::text,e.cost_basis,j.status,j.attempt_count FROM tool_executions e JOIN jobs j ON j.id=e.job_id JOIN tool_remote_calls r ON r.execution_id=e.id WHERE r.call->'resource'->>'id'=$1 ORDER BY e.started_at_ms DESC LIMIT 1",
          [s.id],
        )
      ).rows[0];
      consumerInvalidInputCosts.push(failed);
      assert.equal(failed.code, "invalid_input");
      assert.equal(failed.status, "Failed");
      assert.equal(failed.attempt_count, 1, "Permanent unsuitable audio must not retry");
      assert.equal(failed.cleanup_status, "succeeded");
    }
    await assert.rejects(
      runtime.executor.execute({
        name: "editing.crop-video",
        version: "1.0.0",
        callerId: actor,
        projectId: project,
        resource: { kind: "asset", id: source },
        input: { assetId: source, x: 1, y: 0, width: 31, height: 32 },
      }),
    );
    const changed = (
      await pool.query(
        "SELECT storage_key,content_sha256,byte_size::text FROM media_assets WHERE id=$1",
        [source],
      )
    ).rows[0];
    assert.deepEqual(changed, before);
    const resolver = new PostgresRenderAssetResolver(pool),
      strategies = [
        new FFmpegRenderStrategy(objects, 300000, resolver),
        new RemotionRenderStrategy(objects, 300000, resolver),
      ];
    const parity = [];
    let queuedInput, queuedCaption, queuedRounding;
    for (const [n, d] of [
      [25, 1],
      [30, 1],
      [30000, 1001],
    ]) {
      for (const variant of n === 30
        ? ["single-source", "mixed-audio", "no-audio"]
        : ["single-source", "mixed-audio"]) {
        const t = structuredClone(snapshot),
          rate = { numerator: BigInt(n), denominator: BigInt(d) };
        t.id = id();
        const native = JSON.parse(process.env.EDITAGENT_CUT_SOURCES).find(
          (s) => s.numerator === n && s.hasAudio === (variant !== "no-audio"),
        );
        const silent = JSON.parse(process.env.EDITAGENT_CUT_SOURCES).find(
          (s) => s.numerator === n && !s.hasAudio,
        );
        t.sources = [{ id: native.id, kind: "video", durationUs: native.durationUs }];
        t.tracks[0].clips[0].sourceId = native.id;
        t.composition.frameRate = { numerator: String(n), denominator: String(d) };
        t.composition.durationUs = frameTime(49n, rate).toString();
        t.tracks[0].timelineId = t.id;
        const mk = (start, a, b) => ({
          ...t.tracks[0].clips[0],
          id: id(),
          timelineStartUs: frameTime(BigInt(start), rate).toString(),
          inPoint: frameTime(BigInt(a), rate).toString(),
          outPoint: frameTime(BigInt(b), rate).toString(),
        });
        // All ranges stay within the independently created 2-second source, with visible black/white and gaps.
        t.tracks[0].clips = [mk(3, 9, 19), mk(15, 30, 45)];
        if (variant === "mixed-audio") {
          t.sources.push({ id: silent.id, kind: "video", durationUs: silent.durationUs });
          t.tracks[0].clips[1].sourceId = silent.id;
        }
        const input = {
          schemaVersion: 1,
          renderVersion: catalog.renderVersion,
          compositionId: "TimelineV1",
          correlationId: "strategy-parity",
          props: {
            timeline: t,
            background: "#000000",
            captionStyle: {
              color: "#ffffff",
              background: "#000000",
              fontSize: 24,
              direction: "auto",
            },
            components: [],
          },
        };
        assert.equal(renderEngine(input), "ffmpeg");
        if (n === 30 && variant === "single-source") {
          queuedRounding = structuredClone(input);
          Object.assign(queuedRounding.props.timeline.tracks[0].clips[0], {
            inPoint: "333333",
            outPoint: "666667",
            timelineStartUs: "100000",
          });
          assert.equal(
            renderEngine(queuedRounding),
            "remotion",
            "Microsecond addition may move the logical end off grid",
          );
        }
        queuedInput = input;
        for (let i = 0; i < 2; i++) {
          console.log("STRATEGY_RENDER", n, variant, i === 0 ? "ffmpeg" : "remotion");
          const jobId = id(),
            started = performance.now(),
            output = await strategies[i].render(
              input,
              project,
              jobId,
              new AbortController().signal,
              () => {},
            );
          const renderWallTimeMs = Math.round(performance.now() - started),
            retryStarted = performance.now();
          const replayed = await strategies[i].render(
            input,
            project,
            jobId,
            new AbortController().signal,
            () => {},
          );
          assert.deepEqual(
            replayed,
            output,
            "Strategy retries must return the same verified logical output",
          );
          const row = {
            label: `strategy-${n}-${variant}-${i === 0 ? "ffmpeg" : "remotion"}`,
            variant,
            hasAudio: variant !== "no-audio",
            key: output.objectKey,
            sha256: output.sha256,
            frameRate: `${n}/${d}`,
            frames: 49,
            wallTimeMs: renderWallTimeMs,
            retryVerificationMs: Math.round(performance.now() - retryStarted),
            actualEngine: objects.engines.get(output.objectKey),
          };
          assert.equal(
            row.actualEngine,
            i === 0 ? "ffmpeg" : "remotion",
            "Evidence comes from the actual executor, not just selection intent",
          );
          artifacts.push(row);
          parity.push(row);
        }
        const caption = structuredClone(input);
        caption.props.timeline.tracks.push({
          id: id(),
          timelineId: t.id,
          kind: "caption",
          transitions: [],
          clips: [],
        });
        caption.props.timeline.tracks.at(-1).clips = [
          {
            ...t.tracks[0].clips[0],
            id: id(),
            trackId: caption.props.timeline.tracks.at(-1).id,
            kind: "caption",
            inPoint: "0",
            outPoint: frameTime(10n, rate).toString(),
            timelineStartUs: "0",
            sourceId: null,
            text: "مرحبا 👋",
            componentId: null,
          },
        ];
        assert.equal(renderEngine(caption), "remotion");
        queuedCaption = caption;
      }
    }
    for (const input of [queuedInput, queuedCaption, queuedRounding]) {
      const jobId = id();
      await publishRenderJob(renderDeps, pool, {
        jobId,
        projectId: project,
        actorId: actor,
        input,
        timeoutMs: 300000,
      });
      const deadline = Date.now() + 300000;
      let job;
      while (Date.now() < deadline) {
        job = await runtime.deps.jobs.findById(jobId);
        if (["Completed", "Failed", "Cancelled"].includes(job.status)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(job.status, "Completed");
      const key = `renders/${catalog.renderVersion}/${project}/${jobId}.mp4`;
      assert.equal(objects.engines.get(key), renderEngine(input));
      if (input === queuedRounding) {
        const artifact = objects.saved.get(key);
        artifacts.push({
          label: "strategy-rounding-fallback",
          key,
          sha256: artifact.sha256,
          frameRate: "30/1",
          frames: 49,
          hasAudio: true,
        });
      }
    }
    assert.deepEqual(selectedEngines, ["ffmpeg", "remotion", "remotion"]);
    const remoteCall = (input) => ({
      name: "editing.resize-video",
      version: "1.0.0",
      callerId: actor,
      projectId: project,
      resource: { kind: "asset", id: source },
      input,
    });
    objects.enabled = true;
    const storageRetry = await runtime.executor.execute(
      remoteCall({ assetId: source, width: 64, height: 128 }),
    );
    assert.equal(storageRetry.record.outcome, "succeeded");
    assert.equal(
      (await pool.query("SELECT attempt_count FROM jobs WHERE id=$1", [storageRetry.record.jobId]))
        .rows[0].attempt_count,
      2,
    );
    await pool.query("CREATE SEQUENCE editing_proof_failure_seq");
    await pool.query(
      `CREATE FUNCTION editing_proof_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id='${project}'::uuid AND nextval('editing_proof_failure_seq')=1 THEN RAISE EXCEPTION 'fixture publication unavailable'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      "CREATE TRIGGER editing_proof_failure BEFORE INSERT ON derived_assets FOR EACH ROW EXECUTE FUNCTION editing_proof_failure()",
    );
    let postUpload;
    try {
      postUpload = await runtime.executor.execute(
        remoteCall({ assetId: source, width: 128, height: 128 }),
      );
    } finally {
      await pool.query(
        "DROP TRIGGER editing_proof_failure ON derived_assets; DROP FUNCTION editing_proof_failure(); DROP SEQUENCE editing_proof_failure_seq",
      );
    }
    assert.equal(postUpload.record.outcome, "succeeded");
    assert.equal(
      (await pool.query("SELECT attempt_count FROM jobs WHERE id=$1", [postUpload.record.jobId]))
        .rows[0].attempt_count,
      2,
    );
    for (const r of [storageRetry, postUpload]) {
      const asset = r.output.asset,
        rows = await pool.query("SELECT count(*)::int AS n FROM derived_assets WHERE id=$1", [
          asset.id,
        ]);
      assert.equal(rows.rows[0].n, 1);
      assert.equal(r.record.costMicros, c.editingCostMicros);
      assert.equal(r.record.costBasis, "actual");
      artifacts.push({
        label: r === storageRetry ? "storage-retry" : "post-upload-retry",
        key: asset.artifact.storageKey,
        sha256: asset.artifact.sha256,
        metadata: asset.artifact.metadata,
      });
    }
    const cancelled = new AbortController();
    const cancellation = runtime.executor.execute(
      remoteCall({ assetId: source, width: 1920, height: 1080 }),
      cancelled.signal,
    );
    let observed = false,
      cancelProcesses = [];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !observed) {
      for (const token of await fs.readdir("/render-work")) {
        try {
          const p = JSON.parse(await fs.readFile(`/render-work/${token}/processes.json`, "utf8"));
          if (p.some((row) => row.argv?.[0]?.endsWith("ffmpeg"))) {
            cancelProcesses = p;
            observed = true;
            break;
          }
        } catch {
          /* not yet active */
        }
      }
      if (!observed) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(observed, true, "Cancel only after actual executor processes are active");
    cancelled.abort();
    await assert.rejects(cancellation, /cancelled/);
    assert.deepEqual(await fs.readdir("/render-work"), []);
    const cancelledRow = (
      await pool.query(
        "SELECT outcome,job_id,cleanup_status FROM tool_executions WHERE caller_id=$1 AND stop_code='cancelled' ORDER BY started_at_ms DESC LIMIT 1",
        [actor],
      )
    ).rows[0];
    assert.equal(cancelledRow.outcome, "cancelled");
    assert.equal(cancelledRow.cleanup_status, "succeeded");
    assert.equal(
      (await pool.query("SELECT status FROM jobs WHERE id=$1", [cancelledRow.job_id])).rows[0]
        .status,
      "Cancelled",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM editing_output_intents WHERE execution_id=$1 AND published=true",
          [cancelledRow.job_id],
        )
      ).rows[0].n,
      0,
    );
    await runtime.executor.recover();
    console.log(
      "EDITING_EVIDENCE " +
        JSON.stringify({
          artifacts,
          records,
          parity,
          sevenTools: true,
          sourceUnchanged: true,
          authorizationDenied: true,
          hostileSchemaRejected: true,
          actualRemoteJobs: 5,
          chainedDerivedInput: true,
          actualQueuedStrategySelection: selectedEngines,
          sharedStrategyRetryContract: true,
          storageFailureRetry: true,
          postUploadRecovery: true,
          costSettledOnce: true,
          consumerInvalidInputCosts,
          cancelledAuditJob: cancelledRow,
          cancelledActiveProcesses: true,
          cancelProcesses,
        }),
    );
  } finally {
    stopped = true;
    await pump;
    process.kill(daemon, "SIGCONT");
    await queue.close(true);
    s3.destroy();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
