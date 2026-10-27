/** Real PostgreSQL/Redis authorization and persistence; media rendering is verified separately. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  createUuidV7,
  instant,
  MediaAsset,
  mediaAssetId,
  projectId,
  userId,
  frameRate,
} from "@editagent/domain";
import { BullMqJobQueue, PostgresJobRepository } from "@editagent/job-queue";
import { createApiApplication } from "./create-api-application.js";
import { TimelineEditor } from "./application/timeline-editor.js";
import { TimelineExports, type TimelineRenderSnapshot } from "./application/timeline-exports.js";
import { GetMediaDetails } from "./application/media-details.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { PostgresTimelineStore } from "./infrastructure/postgres-timeline-store.js";
import { PostgresTimelineRenders } from "./infrastructure/postgres-timeline-renders.js";
import { timelineProposals } from "./infrastructure/timeline-proposals.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { authenticateRequest } from "./presentation/authenticate-request.js";
import { requireCookieCsrf } from "./presentation/csrf.js";
import { TimelineCaptions } from "./application/timeline-captions.js";
import { PostgresCaptionEdits } from "./infrastructure/postgres-caption-edits.js";
import { fork } from "node:child_process";
import path from "node:path";
import { parseMediaAnalysis } from "@editagent/schemas";
import { contentHash, ToolExecutor } from "@editagent/tool-sdk";
import {
  DEFAULT_CAPTION_STYLE,
  type UserId,
  type ProjectId,
  type MediaAssetId,
} from "@editagent/domain";
type EditorView = Awaited<ReturnType<TimelineEditor["read"]>>;

test(
  "manual editor fences real SDK proposals, CAS, membership, idempotent Jobs and cancellation",
  { timeout: 45_000 },
  async () => {
    const newId = () => createUuidV7(Date.now(), randomBytes(10));
    const adminUrl =
      process.env["DATABASE_URL"] ??
      "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
    const name = `editagent_editor_${process.pid}`,
      url = new URL(adminUrl);
    url.pathname = "/" + name;
    const admin = new Pool({ connectionString: adminUrl }),
      pool = new Pool({ connectionString: url.href });
    const redis = new URL(process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0");
    redis.pathname = "/10";
    const queue = new BullMqJobQueue(redis.href),
      jobs = new PostgresJobRepository(pool);
    const now = () => instant(BigInt(Date.now())),
      projects = new PostgresProjectRepository(pool),
      media = new PostgresMediaAssetRepository(pool);
    const store = new PostgresTimelineStore(pool),
      proposals = timelineProposals(pool, store),
      objects = new MemoryObjectStorage();
    let revoke = false;
    const owner = userId(newId()),
      editorId = userId(newId()),
      viewer = userId(newId()),
      stranger = userId(newId());
    const project = projectId(newId()),
      other = projectId(newId()),
      source = mediaAssetId(newId());
    const editor = new TimelineEditor(
      projects,
      new GetMediaDetails(projects, media),
      store,
      {
        async propose(...args) {
          const result = await proposals.propose(...args);
          if (revoke)
            await pool.query(
              "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
              [project, editorId],
            );
          return result;
        },
      },
      { now },
      newId,
    );
    const renders = new PostgresTimelineRenders(
      pool,
      {
        jobs,
        queue,
        now,
        newAttemptId: newId,
        supervisor: {
          async run() {
            throw new Error("No renderer in authorization test.");
          },
        },
      },
      "a".repeat(64),
    );
    const tokens = new JwtSessionTokens("editor-integration-signing-key-32chars");
    const app = await createApiApplication(
      {
        editor,
        timelineCaptions: new TimelineCaptions(new PostgresCaptionEdits(pool)),
        timelineExports: new TimelineExports(projects, editor, renders, objects, (key) =>
          objects.presignGet(key),
        ),
        projects,
        media,
        objects,
        clock: { now },
        ids: new NodeProjectIdGenerator(),
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 60,
      },
      (use) => {
        use(authenticateRequest(tokens, now));
        const csrf = requireCookieCsrf();
        use((req, res, next) => csrf(req, res as Parameters<typeof csrf>[1], next));
      },
    );
    let created = false;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
      await applyMigrations(pool);
      for (const actor of [owner, editorId, viewer, stranger])
        await pool.query(
          "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$test-fixture',1,1)",
          [actor, actor + "@example.test"],
        );
      for (const id of [project, other])
        await pool.query(
          "INSERT INTO projects(id,name,created_at,updated_at) VALUES($1,'editor fixture',1,1)",
          [id],
        );
      for (const [actor, role] of [
        [owner, "owner"],
        [editorId, "editor"],
        [viewer, "viewer"],
      ])
        await pool.query(
          "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,1)",
          [project, actor, role],
        );
      await pool.query(
        "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',1)",
        [other, stranger],
      );
      const uploaded = MediaAsset.createUploaded({
        id: source,
        projectId: project,
        createdAt: now(),
        displayFilename: "fixture.mp4",
        mimeType: "video/mp4",
        byteSize: 100,
        contentSha256: "b".repeat(64),
      });
      await media.save(uploaded);
      await media.saveInspection(
        uploaded.recordInspection(
          {
            container: "mp4",
            videoCodec: "h264",
            audioCodec: null,
            width: 640,
            height: 360,
            displayWidth: 640,
            displayHeight: 360,
            rotation: 0,
            frameRate: frameRate(30n, 1n),
            frameRateMode: "constant",
            duration: 2_000_000n,
            colorSpace: null,
            audioChannels: null,
            sampleRate: null,
            streams: [
              {
                codecType: "video",
                codecName: "h264",
                width: 640,
                height: 360,
                sampleRate: null,
                channels: null,
              },
            ],
          },
          now(),
        ),
        0n,
      );
      // Validated fixture state for authorization tests only. The demo uses real sandbox inspection.
      await pool.query(
        "UPDATE media_assets SET validation_status='validated',validation_policy_signature=$2,validation_source_sha256=content_sha256,validation_checked_at=updated_at WHERE id=$1",
        [source, "c".repeat(64)],
      );
      await app.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/projects`;
      const headers = async (actor = owner) => ({
        "content-type": "application/json",
        cookie: `editagent_access=${(await tokens.issueAccess(actor, now())).token}; editagent_csrf=fixture-csrf`,
        "x-editagent-csrf": "fixture-csrf",
      });
      const post = async (route: string, body: object, actor = owner) =>
        fetch(base + route, {
          method: "POST",
          headers: await headers(actor),
          body: JSON.stringify(body),
        });
      assert.equal(
        (
          await fetch(base + `/${project}/timelines`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-user-id": owner },
            body: JSON.stringify({ mediaAssetId: source }),
          })
        ).status,
        401,
      );
      const noCsrf = await headers();
      delete (noCsrf as Partial<typeof noCsrf>)["x-editagent-csrf"];
      assert.equal(
        (
          await fetch(base + `/${project}/timelines`, {
            method: "POST",
            headers: noCsrf,
            body: JSON.stringify({ mediaAssetId: source }),
          })
        ).status,
        403,
      );
      assert.equal(
        (await post(`/${project}/timelines`, { mediaAssetId: source }, viewer)).status,
        403,
      );
      assert.equal(
        (await post(`/${other}/timelines`, { mediaAssetId: source }, stranger)).status,
        404,
      );
      assert.equal(
        (await post(`/${project}/timelines`, { mediaAssetId: source, actorId: stranger })).status,
        400,
      );
      const creation = await post(`/${project}/timelines`, { mediaAssetId: source });
      assert.equal(creation.status, 201);
      const initial = (await creation.json()) as EditorView,
        timeline = initial.timeline.id,
        clip = initial.timeline.tracks[0]!.clips[0]!.id;
      const edits = await Promise.all(
        ["200000", "300000"].map((startUs) =>
          post(`/${project}/timelines/${timeline}/trim`, {
            stateSha256: initial.stateSha256,
            clipId: clip,
            startUs,
            endUs: "1800000",
          }),
        ),
      );
      assert.deepEqual(edits.map((response) => response.status).sort(), [201, 409]);
      let current = (await (
        await fetch(base + `/${project}/timelines/${timeline}`, { headers: await headers(viewer) })
      ).json()) as EditorView;
      revoke = true;
      assert.equal(
        (
          await post(
            `/${project}/timelines/${timeline}/split`,
            { stateSha256: current.stateSha256, clipId: clip, atUs: "1000000" },
            editorId,
          )
        ).status,
        409,
      );
      assert.equal((await store.load(project, timeline)).stateSha256, current.stateSha256);
      revoke = false;
      const request = {
        stateSha256: current.stateSha256,
        requestId: "req_" + randomBytes(16).toString("hex"),
      };
      const submitted = await post(`/${project}/timelines/${timeline}/render`, request);
      assert.equal(submitted.status, 201);
      const first = (await submitted.json()) as TimelineRenderSnapshot,
        duplicate = (await (
          await post(`/${project}/timelines/${timeline}/render`, request)
        ).json()) as TimelineRenderSnapshot;
      assert.equal(first.jobId, duplicate.jobId);
      assert.equal(
        (
          await fetch(base + `/${other}/exports/${first.jobId}`, {
            headers: await headers(stranger),
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(base + `/${project}/exports/${first.jobId}/download`, {
            headers: await headers(),
          })
        ).status,
        409,
      );
      assert.equal(
        (await post(`/${project}/exports/${first.jobId}/cancel`, {}, viewer)).status,
        403,
      );
      const cancelled = await post(`/${project}/exports/${first.jobId}/cancel`, {});
      assert.equal(cancelled.status, 201);
      assert.equal(((await cancelled.json()) as TimelineRenderSnapshot).status, "Cancelled");
      assert.equal(
        (await pool.query("SELECT count(*) FROM jobs WHERE job_type='render.remotion'")).rows[0]
          .count,
        "1",
      );
      current = (await (
        await fetch(base + `/${project}/timelines/${timeline}`, { headers: await headers() })
      ).json()) as EditorView;
      assert.equal(current.timeline.tracks[0]!.clips.length, 1);
      await checkCaptionLifecycle({
        pool,
        url: url.href,
        owner,
        viewer,
        stranger,
        project,
        other,
        source,
        current,
        base,
        headers,
        post,
        newId,
      });
    } finally {
      await app.close();
      await queue.close(true);
      await pool.end();
      if (created) await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);

/** Synthetic analysis below qualifies lifecycle authority only, never ASR accuracy. */
async function checkCaptionLifecycle(p: {
  pool: Pool;
  url: string;
  owner: UserId;
  viewer: UserId;
  stranger: UserId;
  project: ProjectId;
  other: ProjectId;
  source: MediaAssetId;
  current: Awaited<ReturnType<TimelineEditor["read"]>>;
  base: string;
  headers: (actor?: UserId) => Promise<Record<string, string>>;
  post: (route: string, body: object, actor?: UserId) => Promise<Response>;
  newId: () => string;
}) {
  const {
      pool,
      owner,
      viewer,
      stranger,
      project,
      other,
      source,
      current,
      base,
      headers,
      post,
      newId,
    } = p,
    timeline = current.timeline.id;
  const doc = parseMediaAnalysis({
    schemaVersion: "1.0.0",
    mediaAssetId: source,
    source: { sha256: "b".repeat(64), durationUs: "2000000" },
    provenance: { producer: "caption-lifecycle-fixture", producerVersion: "1.0.0" },
    sections: {
      metadata: { status: "not_available" },
      audio: { status: "not_available" },
      scenes: { status: "not_available" },
      faces: { status: "not_available" },
      objects: { status: "not_available" },
      transcript: {
        status: "completed",
        provenance: {
          analyzer: "caption-lifecycle-fixture",
          analyzerVersion: "1.0.0",
          sourceSha256: "b".repeat(64),
          configurationSha256: "c".repeat(64),
          model: { name: "faster-whisper-small", version: "fixture-only", sha256: "d".repeat(64) },
        },
        data: {
          language: "en",
          segments: [
            {
              id: "fixture-0",
              text: "Hi مَرْحَبًا",
              startUs: "300000",
              endUs: "1200000",
              words: [
                { text: "Hi", startUs: "300000", endUs: "600000", confidence: 0.9 },
                { text: "مَرْحَبًا", startUs: "700000", endUs: "1200000" },
              ],
            },
          ],
        },
      },
    },
  });
  await pool.query(
    "INSERT INTO media_analyses(media_asset_id,project_id,source_sha256,document) VALUES($1,$2,$3,$4::jsonb)",
    [source, project, "b".repeat(64), JSON.stringify(doc)],
  );
  const route = `/${project}/timelines/${timeline}/captions`;
  const request = {
    stateSha256: current.stateSha256,
    requestId: newId(),
    assetId: source,
    sourceSha256: "b".repeat(64),
    analysisSha256: contentHash(doc),
    style: DEFAULT_CAPTION_STYLE,
  };
  assert.equal(
    (await fetch(base + route + `/sources/${source}`, { headers: await headers() })).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + route, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": owner },
        body: JSON.stringify(request),
      })
    ).status,
    401,
  );
  const noCsrf = await headers();
  delete noCsrf["x-editagent-csrf"];
  assert.equal(
    (await fetch(base + route, { method: "POST", headers: noCsrf, body: JSON.stringify(request) }))
      .status,
    403,
  );
  const tiny = structuredClone(doc);
  if (tiny.sections.transcript.status !== "completed") throw new Error("Fixture must be complete.");
  tiny.sections.transcript.provenance.model = {
    name: "faster-whisper-tiny",
    version: "fixture-only",
    sha256: "e".repeat(64),
  };
  await pool.query("UPDATE media_analyses SET document=$2::jsonb WHERE media_asset_id=$1", [
    source,
    JSON.stringify(tiny),
  ]);
  try {
    assert.equal(
      (await fetch(base + route + `/sources/${source}`, { headers: await headers() })).status,
      409,
    );
  } finally {
    await pool.query("UPDATE media_analyses SET document=$2::jsonb WHERE media_asset_id=$1", [
      source,
      JSON.stringify(doc),
    ]);
  }
  assert.equal((await post(route, request, viewer)).status, 404);
  assert.equal((await post(route, request, stranger)).status, 404);
  assert.equal(
    (await post(`/${other}/timelines/${timeline}/captions`, request, stranger)).status,
    404,
  );
  for (const mutation of [
    { style: { ...DEFAULT_CAPTION_STYLE, css: "url(https://example.com)" } },
    { actorId: stranger },
    { permissions: ["project.owner"] },
  ])
    assert.equal((await post(route, { ...request, ...mutation })).status, 400);
  const bad = await post(route, { ...request, requestId: newId(), analysisSha256: "e".repeat(64) });
  assert.equal(bad.status, 409);
  const before = contentHash(
    await new PostgresCaptionEdits(pool).source(owner, project, timeline, source),
  );
  const added = await post(route, request);
  assert.equal(added.status, 201);
  const saved = (await added.json()) as typeof current;
  const caption = saved.timeline.captionsV1![0]!;
  assert.equal(caption.blocks.flatMap((b) => b.lines.flat()).length, 2);
  assert.equal(caption.blocks[0]!.lines.flat()[1]!.confidence, null);
  assert.equal((await post(route, request)).status, 201);
  assert.equal(
    (await pool.query("SELECT count(*) FROM editing_caption_commands WHERE status='committed'"))
      .rows[0].count,
    "1",
  );
  const read = await fetch(base + `/${project}/timelines/${timeline}`, {
    headers: await headers(),
  });
  assert.deepEqual(((await read.json()) as typeof current).timeline, saved.timeline);
  const history = await fetch(base + route + "/history", { headers: await headers(viewer) });
  const list = (await history.json()) as { id: string; status: string }[];
  assert.equal(list.filter((r) => r.status === "committed").length, 1);
  assert.equal(JSON.stringify(list).includes("مَرْحَبًا"), false);
  assert.equal(
    (await fetch(base + route + "/history", { headers: await headers(stranger) })).status,
    404,
  );
  const styleRequest = {
    stateSha256: saved.stateSha256,
    requestId: newId(),
    style: { ...DEFAULT_CAPTION_STYLE, highlight: "#00ff00" },
  };
  const styledResponse = await post(route + `/${caption.id}/style`, styleRequest);
  assert.equal(styledResponse.status, 201);
  const styled = (await styledResponse.json()) as typeof current;
  assert.deepEqual(styled.timeline.captionsV1![0]!.blocks, caption.blocks);
  // Real process death after durable proposal receipt, before Timeline commit.
  const crashRequest = {
    stateSha256: styled.stateSha256,
    requestId: newId(),
    operation: "update-caption-style" as const,
    input: { captionId: caption.id, style: { ...DEFAULT_CAPTION_STYLE, highlight: "#ff0000" } },
  };
  const child = fork(path.resolve(__dirname, "../../../tools/test/caption-crash-worker.cjs"), [], {
    env: { ...process.env, DATABASE_URL: p.url, CAPTION_CRASH_TEST: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const barrier = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Caption receipt barrier timed out.")),
        10000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Caption test process exited before its barrier."));
      });
      child.once("message", (m: unknown) => {
        clearTimeout(timer);
        if ((m as { phase: string }).phase === "receipt-recorded") resolve();
        else reject(new Error("Caption receipt barrier failed."));
      });
      child.once("error", reject);
    });
    child.send({ actor: owner, project, timeline, request: crashRequest });
    await barrier;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  const restarted = new PostgresCaptionEdits(pool);
  await assert.rejects(() => restarted.execute(owner, project, timeline, crashRequest));
  assert.equal(
    (await pool.query("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [timeline])).rows[0]
      .state_sha256,
    styled.stateSha256,
  );
  const pending = (
    await pool.query("SELECT id,status FROM editing_caption_commands WHERE request_id=$1", [
      crashRequest.requestId,
    ])
  ).rows[0];
  assert.equal(pending.status, "admitted");
  assert.equal(
    (await pool.query("SELECT outcome FROM tool_executions WHERE id=$1", [pending.id])).rows[0]
      .outcome,
    "succeeded",
  );
  const latest = (
    await pool.query(
      "SELECT id FROM editing_caption_commands WHERE status='committed' ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0].id;
  assert.equal(
    (await post(route + `/${latest}/undo`, { stateSha256: saved.stateSha256 })).status,
    409,
  );
  const undone = await post(route + `/${latest}/undo`, { stateSha256: styled.stateSha256 });
  assert.equal(undone.status, 201);
  assert.deepEqual(((await undone.json()) as typeof current).timeline, saved.timeline);
  assert.equal(
    (await post(route + `/${latest}/undo`, { stateSha256: saved.stateSha256 })).status,
    409,
  );
  assert.equal(contentHash(await restarted.source(owner, project, timeline, source)), before);
  // Revoke AFTER the successful proposal receipt and before the durable edit.
  const original = ToolExecutor.prototype.executeWithIdentity;
  ToolExecutor.prototype.executeWithIdentity = async function (
    ...args: Parameters<ToolExecutor["executeWithIdentity"]>
  ) {
    const result = await original.apply(this, args);
    await pool.query(
      "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [project, owner],
    );
    return result;
  };
  try {
    await assert.rejects(() =>
      restarted.execute(owner, project, timeline, {
        requestId: newId(),
        stateSha256: saved.stateSha256,
        operation: "update-caption-style",
        input: { captionId: caption.id, style: { ...DEFAULT_CAPTION_STYLE, highlight: "#ff00ff" } },
      }),
    );
  } finally {
    ToolExecutor.prototype.executeWithIdentity = original;
    await pool.query(
      "UPDATE project_memberships SET role='owner' WHERE project_id=$1 AND user_id=$2",
      [project, owner],
    );
  }
  assert.equal(
    (await pool.query("SELECT state_sha256 FROM editing_timelines WHERE id=$1", [timeline])).rows[0]
      .state_sha256,
    saved.stateSha256,
  );
  const priorAdmission = (await pool.query("SELECT count(*) FROM editing_caption_commands")).rows[0]
    .count;
  await pool.query(
    "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
    [project, owner],
  );
  try {
    assert.equal((await post(route, { ...request, requestId: newId() })).status, 404);
  } finally {
    await pool.query(
      "UPDATE project_memberships SET role='owner' WHERE project_id=$1 AND user_id=$2",
      [project, owner],
    );
  }
  assert.equal(
    (await pool.query("SELECT count(*) FROM editing_caption_commands")).rows[0].count,
    priorAdmission,
  );
}
