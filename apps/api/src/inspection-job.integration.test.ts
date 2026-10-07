import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  createUuidV7,
  instant,
  Job,
  jobId,
  projectId,
  mediaAssetId,
  MediaAsset,
  userId,
} from "@editagent/domain";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  RedisJobEventPublisher,
  RedisJobEventSubscriber,
  cancelJob,
} from "@editagent/job-queue";
import { parseValidationPolicy } from "@editagent/shared";
import { createApiApplication } from "./create-api-application.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { PostgresInspectionJobs } from "./infrastructure/postgres-inspection-jobs.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { authenticateRequest } from "./presentation/authenticate-request.js";
import { requireCookieCsrf } from "./presentation/csrf.js";
const newId = () => createUuidV7(Date.now(), randomBytes(10));
test(
  "US-131 authenticated snapshot matrix, latest history and concurrent real BullMQ retry",
  { timeout: 30000 },
  async () => {
    const adminUrl =
      process.env["DATABASE_URL"] ??
      "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
    const db = `editagent_us131_${process.pid}`;
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(adminUrl);
    url.pathname = `/${db}`;
    const pool = new Pool({ connectionString: url.toString() });
    const redis = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0";
    const queue = new BullMqJobQueue(redis, { events: new RedisJobEventPublisher(pool, redis) });
    const subscriber = new RedisJobEventSubscriber(redis);
    const jobs = new PostgresJobRepository(pool);
    const now = () => instant(BigInt(Date.now()));
    const queueName = `us131-${process.pid}`;
    const deps = { jobs, queue, now, newAttemptId: newId, supervisor: { async run() {} } };
    const owner = userId(newId()),
      editor = userId(newId()),
      viewer = userId(newId()),
      stranger = userId(newId());
    const project = projectId(newId()),
      otherProject = projectId(newId()),
      deleted = projectId(newId()),
      media = mediaAssetId(newId()),
      otherMedia = mediaAssetId(newId());
    const tokens = new JwtSessionTokens("us131-integration-signing-key-32chars");
    const mediaRepo = new PostgresMediaAssetRepository(pool);
    const adapter = new PostgresInspectionJobs(pool, deps, {
      queueName,
      policy: parseValidationPolicy(process.env),
      newJobId: newId,
    });
    // Synchronize only the concurrency reproduction's reads so both resolve the
    // same predecessor. The actual enqueue/idempotency path remains real.
    let racing = false,
      reads = 0;
    let release!: () => void;
    let barrier: Promise<void>;
    const port = {
      latest: async (id: typeof media) => {
        const found = await adapter.latest(id);
        if (racing) {
          reads++;
          if (reads === 2) release();
          await barrier;
        }
        return found;
      },
      retry: adapter.retry.bind(adapter),
    };
    const app = await createApiApplication(
      {
        inspectionJobs: port,
        jobEvents: subscriber,
        projects: new PostgresProjectRepository(pool),
        media: mediaRepo,
        clock: { now },
        ids: new NodeProjectIdGenerator(),
        objects: new MemoryObjectStorage(),
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 900,
      },
      (use) => {
        use(authenticateRequest(tokens, now));
        const csrf = requireCookieCsrf();
        use((req, res, next) => csrf(req, res as Parameters<typeof csrf>[1], next));
      },
    );
    const events: unknown[] = [];
    let sub: Awaited<ReturnType<typeof subscriber.subscribe>> | undefined;
    try {
      await applyMigrations(pool);
      for (const id of [owner, editor, viewer, stranger])
        await pool.query(
          "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES($1,$2,'$argon2id$test-fixture',1,1)",
          [id, `${id}@example.test`],
        );
      for (const [id, actor, gone] of [
        [project, owner, false],
        [otherProject, stranger, false],
        [deleted, owner, true],
      ] as const) {
        await pool.query(
          "INSERT INTO projects(id,name,created_at,updated_at,deleted_at) VALUES($1,'fixture',1,1,$2)",
          [id, gone ? 1 : null],
        );
        await pool.query(
          "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,'owner',1)",
          [id, actor],
        );
      }
      for (const [id, role] of [
        [editor, "editor"],
        [viewer, "viewer"],
      ] as const)
        await pool.query(
          "INSERT INTO project_memberships(project_id,user_id,role,created_at) VALUES($1,$2,$3,1)",
          [project, id, role],
        );
      for (const [id, projectId] of [
        [media, project],
        [otherMedia, otherProject],
      ] as const)
        await mediaRepo.save(
          MediaAsset.createUploaded({
            id,
            projectId,
            createdAt: now(),
            displayFilename: "clip.mp4",
            mimeType: "video/mp4",
            byteSize: 12,
            contentSha256: id === media ? "ab".repeat(32) : "cd".repeat(32),
          }),
        );
      await app.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
      const route = (p: string = project, m = media as string, retry = false) =>
        `${base}/projects/${p}/media/${m}/${retry ? "inspection/retry" : "inspection-job"}`;
      const headers = async (actor = owner) => ({
        cookie: `editagent_access=${(await tokens.issueAccess(actor, now())).token}; editagent_csrf=fixture-csrf`,
        "x-editagent-csrf": "fixture-csrf",
      });
      const get = async (actor = owner, p: string = project, m = media as string) =>
        fetch(route(p, m), { headers: await headers(actor) });
      const retry = async (actor = owner, p: string = project, m = media as string) =>
        fetch(route(p, m, true), { method: "POST", headers: await headers(actor) });
      for (const actor of [owner, editor, viewer]) {
        const response = await get(actor);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { job: null });
      }
      assert.equal((await fetch(route())).status, 401);
      assert.equal((await get(owner, "invalid")).status, 400);
      assert.equal((await get(owner, project, "invalid")).status, 400);
      assert.equal((await get(stranger)).status, 404);
      assert.equal((await get(owner, project, otherMedia)).status, 404);
      assert.equal((await get(owner, project, newId())).status, 404);
      assert.equal((await get(owner, deleted)).status, 404);
      for (const status of [
        "Queued",
        "Running",
        "Retrying",
        "Completed",
        "Failed",
        "Cancelled",
      ] as const) {
        const id = newId();
        await jobs.save(
          new Job(
            id,
            { kind: "media-asset", mediaAssetId: media },
            status,
            now(),
            now(),
            status === "Failed" ? "DB credential /path?secret=raw" : null,
            status === "Queued" ? 0 : 1,
            queueName,
            "media.inspect",
            id,
            300000,
            2,
            { secret: "unsafe" },
          ),
        );
        const response = await get();
        const raw = await response.text();
        assert.doesNotMatch(raw, /credential|secret|unsafe|payload|failure_reason/);
        const data = JSON.parse(raw).job;
        assert.equal(data.jobId, id);
        assert.equal(data.status, status);
        assert.equal(
          data.reason,
          status === "Failed" ? "processing_failed" : status === "Cancelled" ? "cancelled" : null,
        );
      }
      assert.equal((await retry(viewer)).status, 403);
      assert.equal((await retry(stranger)).status, 404);
      assert.equal((await retry(owner, project, otherMedia)).status, 404);
      assert.equal((await retry(owner, project, "invalid")).status, 400);
      assert.equal((await fetch(route(project, media, true), { method: "POST" })).status, 401);
      const cookie = await headers();
      delete (cookie as Partial<typeof cookie>)["x-editagent-csrf"];
      assert.equal(
        (await fetch(route(project, media, true), { method: "POST", headers: cookie })).status,
        403,
      );
      for (const status of ["Queued", "Running", "Retrying", "Completed"] as const) {
        const id = newId();
        await jobs.save(
          new Job(
            id,
            { kind: "media-asset", mediaAssetId: media },
            status,
            now(),
            now(),
            null,
            status === "Queued" ? 0 : 1,
            queueName,
            "media.inspect",
            id,
            300000,
            2,
            {},
          ),
        );
        assert.equal((await retry()).status, 409);
      }
      // Equal creation times must not resurrect an ancestor whose UUID sorts later.
      const [childId, ancestorId] = [newId(), newId()].sort();
      const sameTime = now();
      for (const [id, key] of [
        [ancestorId!, ancestorId!],
        [childId!, `media.inspect.${media}.policy.after.${ancestorId}`],
      ] as const) {
        await jobs.save(
          new Job(
            id,
            { kind: "media-asset", mediaAssetId: media },
            "Failed",
            sameTime,
            sameTime,
            "unsafe",
            1,
            queueName,
            "media.inspect",
            key,
            300000,
            2,
            {},
          ),
        );
      }
      assert.equal((await adapter.latest(media))!.jobId, childId);
      const failedId = newId();
      await jobs.save(
        new Job(
          failedId,
          { kind: "media-asset", mediaAssetId: media },
          "Failed",
          now(),
          now(),
          "unsafe path",
          1,
          queueName,
          "media.inspect",
          failedId,
          300000,
          2,
          {},
        ),
      );
      const predecessor = (await jobs.findById(jobId(failedId)))!.toSnapshot();
      sub = await subscriber.subscribe(project, (event) => events.push(event));
      racing = true;
      barrier = new Promise((r) => {
        release = r;
      });
      const responses = await Promise.all([retry(owner), retry(editor)]);
      racing = false;
      for (const response of responses) assert.equal(response.status, 201);
      const winners = await Promise.all(
        responses.map(async (r) => (await r.json()) as { jobId: string; status: string }),
      );
      assert.equal(winners[0]!.jobId, winners[1]!.jobId);
      assert.equal(winners[0]!.status, "Queued");
      const successor = await jobs.findById(jobId(winners[0]!.jobId));
      assert.ok(successor);
      assert.equal(successor.subject.kind, "media-asset");
      assert.equal(successor.timeoutMs, 300000);
      assert.equal(successor.maxAttempts, 2);
      assert.equal(successor.queueName, queueName);
      assert.equal(successor.payload["policySignature"]?.toString().length, 64);
      assert.deepEqual((await jobs.findById(jobId(failedId)))!.toSnapshot(), predecessor);
      assert.equal((await retry()).status, 409);
      const reserved = await queue.reserve(queueName);
      assert.ok(reserved);
      assert.equal(reserved.envelope.jobId, successor.id);
      await queue.complete(reserved.receipt);
      await cancelJob(deps, successor.id);
      assert.equal((await jobs.findById(successor.id))!.status, "Cancelled");
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(events.some((e) => (e as { status: string }).status === "Queued"));
      assert.ok(events.some((e) => (e as { status: string }).status === "Cancelled"));
      console.log(
        "US131_RETRY_EVIDENCE",
        JSON.stringify({
          predecessorId: failedId,
          successorId: successor.id,
          concurrentRequests: 2,
          winnerCount: 1,
          historyImmutable: true,
          actualBullMqReservation: true,
          queuedEvent: true,
        }),
      );
    } finally {
      await sub?.close();
      await app.close();
      await queue.close(true);
      await pool.end();
      await admin.query(`DROP DATABASE ${db}`);
      await admin.end();
    }
  },
);
