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
    } finally {
      await app.close();
      await queue.close(true);
      await pool.end();
      if (created) await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);
