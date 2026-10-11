const { AbortController, structuredClone } = globalThis;
// Real timeline renders inside the production coordinator; trusted synthetic fixture identities only.
const process = require("node:process"),
  console = require("node:console");
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { createUuidV7, instant, projectId } = require("@editagent/domain");
const {
  BullMqJobQueue,
  PostgresJobRepository,
  RedisJobEventPublisher,
  enqueueJob,
  runNextJob,
} = require("@editagent/job-queue");
const { loadRenderWorkerConfig } = require("./dist/infrastructure/config.js");
const { createStorage, RenderObjects } = require("./dist/infrastructure/storage.js");
const { RemotionRenderStrategy } = require("./dist/infrastructure/strategy.js");
const { RenderJobSupervisor } = require("./dist/infrastructure/render-supervisor.js");
const { PostgresRenderAssetResolver } = require("./dist/infrastructure/asset-resolver.js");
const { publishRenderJob } = require("./dist/infrastructure/publish-render.js");
const { outputKey } = require("./dist/infrastructure/contract.js");
async function main() {
  const c = loadRenderWorkerConfig(),
    pool = new Pool({ connectionString: c.databaseUrl }),
    s3 = createStorage(c),
    queue = new BullMqJobQueue(c.redisUrl, {
      events: new RedisJobEventPublisher(pool, c.redisUrl),
    }),
    jobs = new PostgresJobRepository(pool),
    newId = () => createUuidV7(Date.now(), randomBytes(10));
  class DiagnosedStrategy extends RemotionRenderStrategy {
    async render(...args) {
      try {
        return await super.render(...args);
      } catch (error) {
        console.error("Timeline fixture render failed:", error.name, error.message);
        throw error;
      }
    }
  }
  const resolver = new PostgresRenderAssetResolver(pool),
    strategy = new DiagnosedStrategy(
      new RenderObjects(s3, c.objectStorage.bucket),
      300000,
      resolver,
    );
  const deps = {
    jobs,
    queue,
    supervisor: new RenderJobSupervisor(strategy, async (id, percentage, attempt) =>
      queue.publishProgress(id, { stage: "mix", percentage, attempt }),
    ),
    now: () => instant(BigInt(Date.now())),
    newAttemptId: newId,
  };
  const project = process.env.EDITAGENT_PROOF_PROJECT,
    source = process.env.EDITAGENT_PROOF_SOURCE,
    actor = newId(),
    viewer = newId(),
    catalog = JSON.parse(await fs.readFile("dist/bundle/catalog.json", "utf8"));
  const q = "timeline-proof-" + randomBytes(6).toString("hex"),
    handler = { modulePath: "registered-renderer", exportName: "render" };
  const track = newId(),
    timelineId = newId(),
    comp = newId();
  const clip = (kind, start, inPoint, outPoint) => ({
    id: newId(),
    trackId: track,
    kind,
    inPoint: String(inPoint),
    outPoint: String(outPoint),
    timelineStartUs: String(start),
    sourceId: kind === "video" || kind === "audio" ? source : null,
    text: kind === "caption" ? "مرحبا 👋" : null,
    componentId: kind === "graphics" ? comp : null,
    opacity: 1,
    volumeDb: 0,
    effects: [],
  });
  const input = {
    schemaVersion: 1,
    renderVersion: catalog.renderVersion,
    compositionId: "TimelineV1",
    correlationId: "timeline-proof",
    props: {
      background: "#000000",
      captionStyle: { color: "#ffffff", background: "#000000", fontSize: 24, direction: "auto" },
      components: [],
      timeline: {
        id: timelineId,
        projectId: project,
        createdAt: "0",
        composition: {
          width: 64,
          height: 64,
          frameRate: { numerator: "30", denominator: "1" },
          durationUs: "3000000",
        },
        sources: [{ id: source, kind: "video", durationUs: "2000000" }],
        tracks: [
          {
            id: track,
            timelineId,
            kind: "video",
            clips: [clip("video", 0, 0, 1000000), clip("video", 1000000, 1000000, 2000000)],
            transitions: [],
          },
        ],
      },
    },
  };
  const a = input.props.timeline.tracks[0].clips;
  input.props.timeline.tracks[0].transitions = [
    { id: newId(), fromClipId: a[0].id, toClipId: a[1].id, kind: "cut", durationUs: "0" },
  ];
  async function render(payload, label) {
    const id = newId();
    await enqueueJob(deps, {
      id,
      queueName: q,
      jobType: "render.remotion",
      idempotencyKey: "timeline-proof:" + id,
      payload,
      subject: { kind: "project", projectId: projectId(project) },
      timeoutMs: 300000,
      maxAttempts: 1,
      backoffBaseMs: 100,
    });
    await runNextJob(deps, q, handler);
    assert.equal((await jobs.findById(id)).status, "Completed", label);
    return { label, key: outputKey(catalog.renderVersion, project, id) };
  }
  try {
    await pool.query(
      "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$test-fixture',0,0),($3,$4,'$argon2id$test-fixture',0,0)",
      [actor, actor + "@render.test", viewer, viewer + "@render.test"],
    );
    await pool.query(
      "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',0),($1,$3,'viewer',0)",
      [project, actor, viewer],
    );
    await assert.rejects(
      publishRenderJob(deps, pool, {
        jobId: newId(),
        projectId: project,
        actorId: viewer,
        input,
        timeoutMs: 300000,
      }),
    );
    await assert.rejects(
      publishRenderJob(deps, pool, {
        jobId: newId(),
        projectId: newId(),
        actorId: actor,
        input,
        timeoutMs: 300000,
      }),
    );
    // Real publisher authorization produces a queued job, separately cancelled before execution.
    const admittedId = newId();
    await publishRenderJob(deps, pool, {
      jobId: admittedId,
      projectId: project,
      actorId: actor,
      input,
      timeoutMs: 300000,
    });
    await require("@editagent/job-queue").cancelJob(deps, admittedId);
    const sources = input.props.timeline.sources;
    await assert.rejects(resolver.resolve(newId(), sources, new AbortController().signal));
    await pool.query(
      "UPDATE media_assets SET validation_status='pending',validation_policy_signature=NULL,validation_source_sha256=NULL,validation_checked_at=NULL WHERE id=$1",
      [source],
    );
    await assert.rejects(resolver.resolve(project, sources, new AbortController().signal));
    await pool.query(
      "UPDATE media_assets SET validation_status='validated',validation_policy_signature=$2,validation_source_sha256=content_sha256,validation_checked_at=created_at WHERE id=$1",
      [source, "a".repeat(64)],
    );
    const invalid = structuredClone(input);
    invalid.props.timeline.sources = [];
    invalid.props.timeline.tracks = [
      {
        id: track,
        timelineId,
        kind: "graphics",
        clips: [clip("graphics", 0, 0, 1000000)],
        transitions: [],
      },
    ];
    invalid.props.components = [{ componentId: comp, type: "executable-evil", props: {} }];
    const invalidJob = newId();
    await enqueueJob(deps, {
      id: invalidJob,
      queueName: q,
      jobType: "render.remotion",
      idempotencyKey: "invalid-component:" + invalidJob,
      payload: invalid,
      subject: { kind: "project", projectId: projectId(project) },
      timeoutMs: 300000,
      maxAttempts: 1,
      backoffBaseMs: 100,
    });
    await runNextJob(deps, q, handler);
    assert.equal((await jobs.findById(invalidJob)).status, "Failed");
    assert.deepEqual(await fs.readdir("/render-work"), []);
    await resolver.resolve(project, sources, new AbortController().signal);
    const artifacts = [];
    artifacts.push(await render(input, "cut-offset-gap"));
    const fractional = structuredClone(input);
    fractional.props.timeline.composition.frameRate = { numerator: "30000", denominator: "1001" };
    fractional.props.timeline.composition.durationUs = "2002000";
    fractional.props.timeline.tracks[0].transitions = [];
    fractional.props.timeline.tracks[0].clips = [
      clip("video", 0, 0, 1001000),
      clip("video", 1001000, 1000000, 2000000),
    ];
    // The second fractional clip ends before the two-second composition but has 30 visible frames.
    artifacts.push(await render(fractional, "fractional-cut"));
    const graphics = structuredClone(input);
    graphics.props.timeline.sources = [];
    graphics.props.components = [
      { componentId: comp, type: "solid-v1", props: { color: "#ffffff" } },
    ];
    graphics.props.timeline.tracks = [
      {
        id: track,
        timelineId,
        kind: "graphics",
        clips: [clip("graphics", 0, 0, 1000000)],
        transitions: [],
      },
    ];
    artifacts.push(await render(graphics, "graphics"));
    const captions = structuredClone(graphics);
    captions.props.components = [];
    captions.props.timeline.tracks[0].kind = "caption";
    captions.props.timeline.tracks[0].clips = [clip("caption", 0, 0, 1000000)];
    artifacts.push(await render(captions, "caption-unicode"));
    const dissolve = structuredClone(input);
    dissolve.props.timeline.tracks[0].transitions[0].kind = "dissolve";
    dissolve.props.timeline.tracks[0].transitions[0].durationUs = "200000";
    artifacts.push(await render(dissolve, "dissolve"));
    const audio = structuredClone(input),
      audioTrack = newId();
    audio.props.timeline.tracks[0].clips.forEach((c) => {
      c.volumeDb = -60;
    });
    audio.props.timeline.tracks.push({
      id: audioTrack,
      timelineId,
      kind: "audio",
      transitions: [],
      clips: [{ ...clip("audio", 500000, 1000000, 2000000), trackId: audioTrack }],
    });
    artifacts.push(await render(audio, "audio-track-offset"));
    const title = structuredClone(graphics);
    title.props.components[0] = {
      componentId: comp,
      type: "title-v1",
      props: {
        text: "<script>مرحبا 👋</script>",
        color: "#ffffff",
        background: "#000000",
        fontSize: 16,
      },
    };
    artifacts.push(await render(title, "title-safe-text"));
    console.log(
      "TIMELINE_EVIDENCE " +
        JSON.stringify({
          artifacts,
          frameMapping: "absolute-rounded-microsecond-clock",
          crossProjectRejected: true,
          unvalidatedRejected: true,
          viewerRejected: true,
          unknownComponentRejectedBeforeRender: true,
          publisherOwnerAccepted: true,
          renderVersion: catalog.renderVersion,
        }),
    );
  } finally {
    await queue.close(true);
    s3.destroy();
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
