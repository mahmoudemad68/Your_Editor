/**
 * Fault injection for the media.inspect outbox.
 * PostgreSQL and Redis are real. Ordinary replay does not create a second job.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const root = path.resolve(".");
const require = createRequire(path.join(root, "apps/api/package.json"));
const domain = require(path.join(root, "packages/domain/dist/index.js"));
const { CompleteMediaUpload } = require(path.join(root, "apps/api/dist/application/uploads.js"));
const { MemoryObjectStorage } = require(
  path.join(root, "apps/api/dist/application/memory-object-storage.js"),
);
const { applyMigrations } = require(path.join(root, "apps/api/dist/infrastructure/migrate.js"));
const { NodeMediaAssetIdGenerator } = require(
  path.join(root, "apps/api/dist/infrastructure/node-media-asset-id-generator.js"),
);
const { PostgresMediaAssetRepository } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-media-repository.js"),
);
const { PostgresProjectRepository } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-project-repository.js"),
);
const { PostgresUploadPublication, DispatcherCrash, startPublicationRecovery } = require(
  path.join(root, "apps/api/dist/infrastructure/postgres-upload-publication.js"),
);
const { createApiApplication } = require(
  path.join(root, "apps/api/dist/create-api-application.js"),
);
const { bindActor } = require(path.join(root, "apps/api/dist/presentation/actor.js"));
const { SystemClock } = require(path.join(root, "apps/api/dist/infrastructure/system-clock.js"));
const { NodeProjectIdGenerator } = require(
  path.join(root, "apps/api/dist/infrastructure/node-project-id-generator.js"),
);
const jobQueue = require(path.join(root, "packages/job-queue/dist/index.js"));
const { runNextJob } = require(path.join(root, "workers/media-worker/dist/application/run-job.js"));
const { ChildProcessJobSupervisor } = require(
  path.join(root, "workers/media-worker/dist/infrastructure/child-job-supervisor.js"),
);
const { logJobLifecycle } = require(
  path.join(root, "workers/media-worker/dist/consume-media-jobs.js"),
);
const { createServiceLogger } = require(path.join(root, "packages/shared/dist/index.js"));
const workerRequire = createRequire(path.join(root, "workers/media-worker/package.json"));
const { Pool } = workerRequire("pg");
const { Queue } = workerRequire("bullmq");

const { Project, instant, mediaStorageKey, projectId, userId, createUuidV7 } = domain;
const { BullMqJobQueue, PostgresJobRepository } = jobQueue;

const DATABASE = "editagent_us115_outbox";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const redisUrl = isolatedRedisUrl(9);
const acknowledge = path.join(root, "workers/media-worker/dist/handlers/acknowledge.js");

let pool;
let projects;
let media;
let objects;
const queues = [];

before(async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  await admin.end();
  pool = new Pool({ connectionString: databaseUrl(DATABASE) });
  await applyMigrations(pool);
  projects = new PostgresProjectRepository(pool);
  media = new PostgresMediaAssetRepository(pool);
  objects = new MemoryObjectStorage();
  await projects.save(Project.create(PROJECT, "Launch", OWNER, instant(10n)), null);
});

after(async () => {
  await Promise.all(queues.map((queue) => queue.close(true).catch(() => undefined)));
  await pool.end();
});

describe("inspect publication outbox", { concurrency: false }, () => {
  test("a failed transaction stores neither the asset nor the intent", async () => {
    const publication = publicationWith(realQueue(), {
      beforeCommit: async () => {
        throw new Error("commit aborted");
      },
    });
    await assert.rejects(
      () => completeUpload(publication, "corr-abort", "abort.mp4"),
      /commit aborted/,
    );
    assert.equal(await countNamed("abort.mp4"), 0);
    const intents = await pool.query(
      "SELECT count(*)::int AS count FROM inspect_publication_outbox WHERE correlation_id = $1",
      ["corr-abort"],
    );
    assert.equal(intents.rows[0].count, 0);
  });

  test("publication failure after commit keeps one recoverable intent", async () => {
    const queue = realQueue();
    const publication = publicationWith(queue, {
      publish: async () => {
        throw new Error("dispatcher down");
      },
    });
    const asset = await completeUpload(publication, "corr-after-commit", "after.mp4");
    const outbox = await outboxFor(asset.id);
    assert.equal(outbox.status, "Pending");
    assert.equal(outbox.correlation_id, "corr-after-commit");
    assert.equal(await countJobsFor(outbox.job_id), 0);
    assert.match(outbox.last_error, /dispatcher down/);
    assert.ok(Array.isArray(outbox.error_history));
    assert.equal(outbox.error_history.length >= 1, true);
  });

  test("failure before the job row is recovered into one BullMQ job", async () => {
    const queue = realQueue();
    const mode = { fail: true };
    const publication = publicationWith(queue, {
      publish: async (record) => {
        if (mode.fail) {
          throw new Error("before job");
        }
        await publishRecord(queue, record);
      },
    });
    const asset = await completeUpload(publication, "corr-before-job", "before-job.mp4");
    assert.equal(await countJobsFor(await jobIdFor(asset.id)), 0);
    mode.fail = false;
    await forceDue(asset.id);
    assert.equal(await publication.dispatchAsset(asset.id), true);
    await expectOneConsumed(queue, asset.id, "corr-before-job");
  });

  test("failure after the job row and before Redis is recovered without a second job", async () => {
    const real = realQueue();
    const mode = { failEnqueue: true };
    const queue = enqueueGate(real, () => mode.failEnqueue);
    const publication = publicationWith(queue, {});
    const asset = await completeUpload(publication, "corr-before-redis", "before-redis.mp4");
    const createdJob = await jobIdFor(asset.id);
    assert.equal(await countJobsFor(createdJob), 1);
    assert.equal(await bullState(createdJob), null);
    mode.failEnqueue = false;
    await forceDue(asset.id);
    assert.equal(await publication.dispatchAsset(asset.id), true);
    assert.equal(await countJobsFor(createdJob), 1);
    await expectOneConsumed(real, asset.id, "corr-before-redis");
  });

  test("a Redis outage keeps the intent and a later dispatch needs no new HTTP request", async () => {
    const down = track(new BullMqJobQueue("redis://127.0.0.1:1"));
    const publication = publicationWith(down, { deadlineMs: 200 });
    const started = Date.now();
    const asset = await completeUpload(publication, "corr-redis-down", "redis-down.mp4");
    assert.ok(Date.now() - started < 1_500, "upload completion waited on Redis");
    const pending = await outboxFor(asset.id);
    assert.equal(pending.status, "Pending");
    assert.match(pending.last_error ?? "", /deadline|redis|ECONNREFUSED|connect/i);
    await down.close(true);
    const restored = realQueue();
    const recovered = publicationWith(restored, { workerId: "restore" });
    await forceDue(asset.id);
    const recovery = startPublicationRecovery(recovered, 50);
    try {
      const deadline = Date.now() + 5_000;
      let status = "Pending";
      while (status !== "Delivered" && Date.now() < deadline) {
        await delay(50);
        status = (await outboxFor(asset.id)).status;
      }
      const row = await outboxFor(asset.id);
      assert.equal(row.status, "Delivered", row.last_error ?? row.status);
    } finally {
      recovery.stop();
    }
    await expectOneConsumed(restored, asset.id, "corr-redis-down");
  });

  test("a crash after Redis enqueue does not create a second logical job", async () => {
    const queue = realQueue();
    let crashed = false;
    const publication = publicationWith(queue, {
      publish: async (record) => {
        await publishRecord(queue, record);
        if (!crashed) {
          crashed = true;
          throw new DispatcherCrash();
        }
      },
    });
    const asset = await completeUpload(publication, "corr-crash", "crash.mp4");
    const leased = await outboxFor(asset.id);
    assert.equal(leased.status, "Delivering");
    assert.equal(await countJobsFor(await jobIdFor(asset.id)), 1);
    await pool.query(
      `UPDATE inspect_publication_outbox SET lease_until = 0 WHERE media_asset_id = $1`,
      [asset.id],
    );
    assert.equal(await publication.dispatchAsset(asset.id), true);
    assert.equal(await countJobsFor(await jobIdFor(asset.id)), 1);
    const delivered = await outboxFor(asset.id);
    assert.equal(delivered.status, "Delivered");
    assert.equal(delivered.correlation_id, "corr-crash");
    await expectOneConsumed(queue, asset.id, "corr-crash");
  });

  test("two dispatchers claim one outbox record", async () => {
    const queue = realQueue();
    const publication = publicationWith(queue, {
      publish: async () => {
        throw new Error("hold");
      },
    });
    const asset = await completeUpload(publication, "corr-race", "race.mp4");
    const first = publicationWith(queue, { workerId: "dispatcher-a" });
    const second = publicationWith(queue, { workerId: "dispatcher-b" });
    await forceDue(asset.id);
    const results = await Promise.all([
      first.dispatchAsset(asset.id),
      second.dispatchAsset(asset.id),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await countJobsFor(await jobIdFor(asset.id)), 1);
    await expectOneConsumed(queue, asset.id, "corr-race");
  });

  test("two clients completing one upload create one asset and one job", async () => {
    const queue = realQueue();
    const publication = publicationWith(queue, {});
    const body = Buffer.from("concurrent-upload-body");
    const declaration = declarationFor(body, "concurrent.mp4");
    await objects.put(
      mediaStorageKey(PROJECT, declaration.sha256),
      body,
      "video/mp4",
      declaration.sha256,
    );
    const complete = uploader(publication);
    const [left, right] = await Promise.all([
      complete.execute(OWNER, PROJECT, declaration, "corr-concurrent"),
      complete.execute(OWNER, PROJECT, declaration, "corr-concurrent-other"),
    ]);
    assert.equal(left.id, right.id);
    assert.equal(await countForAsset(left.id), 1);
    const stored = await outboxFor(left.id);
    assert.equal(
      stored.correlation_id === "corr-concurrent" ||
        stored.correlation_id === "corr-concurrent-other",
      true,
    );
    await forceDue(left.id);
    await publication.dispatchAsset(left.id);
    await expectOneConsumed(queue, left.id, stored.correlation_id);
  });

  test("a repeated completion while publication is pending is not a conflict", async () => {
    const queue = realQueue();
    const mode = { fail: true };
    const publication = publicationWith(queue, {
      publish: async (record) => {
        if (mode.fail) {
          throw new Error("still pending");
        }
        await publishRecord(queue, record);
      },
    });
    const body = Buffer.from("repeat-same-bytes");
    const first = await completeUpload(publication, "corr-repeat", "repeat.mp4", { body });
    const second = await completeUpload(publication, "corr-repeat-new", "repeat.mp4", { body });
    assert.equal(second.id, first.id);
    const outbox = await outboxFor(first.id);
    assert.equal(outbox.correlation_id, "corr-repeat");
    assert.equal(await countForAsset(first.id), 1);
    mode.fail = false;
    await forceDue(first.id);
    await publication.dispatchAsset(first.id);
    await expectOneConsumed(queue, first.id, "corr-repeat");
  });

  test("permanent Redis unavailability returns in a finite time and keeps retry state", async () => {
    const down = track(new BullMqJobQueue("redis://127.0.0.1:1"));
    const publication = publicationWith(down, { deadlineMs: 250, workerId: "finite" });
    const started = Date.now();
    const asset = await completeUpload(publication, "corr-finite", "finite.mp4");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_500, `completion took ${elapsed}ms`);
    const outbox = await outboxFor(asset.id);
    assert.equal(outbox.status, "Pending");
    assert.ok(outbox.attempt_count >= 1);
    assert.ok((outbox.last_error ?? "").length > 0);
    assert.equal(outbox.error_history.length >= 1, true);
    assert.equal(await countAssetsForSha(asset.contentSha256), 1);
    await down.close(true);
  });

  test("conflicting upload metadata is still a conflict", async () => {
    const publication = publicationWith(realQueue(), {
      publish: async () => undefined,
    });
    const body = Buffer.from("conflict-same-bytes");
    await completeUpload(publication, "corr-conflict", "original.mp4", { body });
    await assert.rejects(
      () => completeUpload(publication, "corr-conflict-2", "other-name.mp4", { body }),
      (error) => error.name === "MediaAssetConflict",
    );
  });

  test("an HTTP retry of the same upload returns the stored asset", async () => {
    const queue = realQueue();
    const publication = publicationWith(queue, {
      publish: async () => {
        throw new Error("pending for http");
      },
    });
    const app = await createApiApplication(
      {
        projects,
        clock: new SystemClock(),
        ids: new NodeProjectIdGenerator(),
        media,
        objects,
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 900,
        publication,
      },
      (use) => {
        use((request, _response, next) => {
          const headers = request.headers ?? {};
          const header = headers["x-test-actor"];
          if (typeof header === "string") {
            bindActor(request, userId(header));
          }
          next();
        });
      },
    );
    try {
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address();
      const base = `http://127.0.0.1:${address.port}`;
      const body = Buffer.from("http-repeat-body");
      const hash = sha256(body);
      const declaration = {
        filename: "http.mp4",
        mimeType: "video/mp4",
        byteSize: body.byteLength,
        sha256: hash,
      };
      await objects.put(mediaStorageKey(PROJECT, hash), body, "video/mp4", hash);
      const headers = {
        "content-type": "application/json",
        "x-test-actor": OWNER,
        "x-request-id": "corr-http",
      };
      const first = await fetch(`${base}/projects/${PROJECT}/uploads/complete`, {
        method: "POST",
        headers,
        body: JSON.stringify(declaration),
      });
      assert.equal(first.status, 201, await first.text());
      const again = await fetch(`${base}/projects/${PROJECT}/uploads/complete`, {
        method: "POST",
        headers: { ...headers, "x-request-id": "corr-http-retry" },
        body: JSON.stringify(declaration),
      });
      const againText = await again.text();
      assert.equal(again.status, 201, againText);
      const payload = JSON.parse(againText);
      const outbox = await outboxFor(payload.id);
      assert.equal(outbox.correlation_id, "corr-http");
      assert.equal(await countForAsset(payload.id), 1);
    } finally {
      await app.close();
    }
  });

  test("a stale publisher with the same worker id cannot mark the reclaimed lease delivered", async () => {
    const queue = realQueue();
    const firstHold = gate();
    const firstEntered = gate();
    const secondHold = gate();
    const secondEntered = gate();
    const first = publicationWith(queue, {
      workerId: "api",
      publish: async (record) => {
        firstEntered.open();
        await firstHold.promise;
        await publishRecord(queue, record);
      },
    });
    const finishing = completeUpload(first, "corr-fence-delivered", "fence-delivered.mp4");
    try {
      await firstEntered.promise;
      const assetId = await assetIdForCorrelation("corr-fence-delivered");
      const claimed = await outboxFor(assetId);
      await expireLease(assetId);
      const second = publicationWith(queue, {
        workerId: "api",
        publish: async (record) => {
          secondEntered.open();
          await secondHold.promise;
          await publishRecord(queue, record);
        },
      });
      const secondRun = second.dispatchAsset(assetId);
      await secondEntered.promise;
      const reclaimed = await outboxFor(assetId);
      assert.equal(reclaimed.status, "Delivering");
      assert.equal(reclaimed.lease_owner, "api");
      assert.ok(reclaimed.attempt_count > claimed.attempt_count);
      firstHold.open();
      await finishing;
      const afterStale = await outboxFor(assetId);
      assert.equal(afterStale.status, "Delivering");
      assert.equal(afterStale.attempt_count, reclaimed.attempt_count);
      assert.equal(afterStale.lease_owner, "api");
      secondHold.open();
      assert.equal(await secondRun, true);
      const delivered = await outboxFor(assetId);
      assert.equal(delivered.status, "Delivered");
      assert.equal(await countJobsFor(delivered.job_id), 1);
      await expectOneConsumed(queue, assetId, "corr-fence-delivered");
    } finally {
      firstHold.open();
      secondHold.open();
    }
  });

  test("a stale publisher with the same worker id cannot retry a reclaimed lease", async () => {
    const queue = realQueue();
    const firstHold = gate();
    const firstEntered = gate();
    const secondHold = gate();
    const secondEntered = gate();
    const first = publicationWith(queue, {
      workerId: "api",
      publish: async () => {
        firstEntered.open();
        await firstHold.promise;
        throw new Error("stale retry");
      },
    });
    const finishing = completeUpload(first, "corr-fence-retry", "fence-retry.mp4");
    try {
      await firstEntered.promise;
      const assetId = await assetIdForCorrelation("corr-fence-retry");
      await expireLease(assetId);
      const second = publicationWith(queue, {
        workerId: "api",
        publish: async (record) => {
          secondEntered.open();
          await secondHold.promise;
          await publishRecord(queue, record);
        },
      });
      const secondRun = second.dispatchAsset(assetId);
      await secondEntered.promise;
      const reclaimed = await outboxFor(assetId);
      firstHold.open();
      await finishing;
      const afterStale = await outboxFor(assetId);
      assert.equal(afterStale.status, "Delivering");
      assert.equal(afterStale.attempt_count, reclaimed.attempt_count);
      assert.equal(afterStale.lease_owner, "api");
      assert.equal(
        afterStale.error_history.some((entry) => entry.message === "stale retry"),
        false,
      );
      secondHold.open();
      assert.equal(await secondRun, true);
      const delivered = await outboxFor(assetId);
      assert.equal(delivered.status, "Delivered");
      assert.equal(await countJobsFor(delivered.job_id), 1);
      await expectOneConsumed(queue, assetId, "corr-fence-retry");
    } finally {
      firstHold.open();
      secondHold.open();
    }
  });

  test("a late redis publish after a newer claim does not duplicate the job", async () => {
    const queue = realQueue();
    const late = gate();
    const entered = gate();
    const lateFinished = gate();
    const first = publicationWith(queue, {
      workerId: "instance-a",
      deadlineMs: 200,
      publish: async (record) => {
        entered.open();
        await late.promise;
        await publishRecord(queue, record);
        lateFinished.open();
      },
    });
    const finishing = completeUpload(first, "corr-late-fence", "late-fence.mp4");
    try {
      await entered.promise;
      const assetId = await assetIdForCorrelation("corr-late-fence");
      await expireLease(assetId);
      const second = publicationWith(queue, { workerId: "instance-b" });
      let deliveredBySecond = await second.dispatchAsset(assetId);
      if (!deliveredBySecond) {
        await forceDue(assetId);
        deliveredBySecond = await second.dispatchAsset(assetId);
      }
      assert.equal(deliveredBySecond, true);
      const delivered = await outboxFor(assetId);
      assert.equal(delivered.status, "Delivered");
      late.open();
      await lateFinished.promise;
      await finishing;
      const after = await outboxFor(assetId);
      assert.equal(after.status, "Delivered");
      assert.equal(after.correlation_id, "corr-late-fence");
      assert.equal(await countJobsFor(after.job_id), 1);
      await expectOneConsumed(queue, assetId, "corr-late-fence");
      assert.equal(await second.dispatchAsset(assetId), false);
      const attempts = await pool.query(
        "SELECT count(*)::int AS count FROM job_attempts WHERE job_id = $1 AND status = 'Completed'",
        [after.job_id],
      );
      assert.equal(attempts.rows[0].count, 1);
    } finally {
      late.open();
    }
  });
});

function publicationWith(queue, extra) {
  return new PostgresUploadPublication({
    pool,
    jobs: new PostgresJobRepository(pool),
    queue,
    now: () => BigInt(Date.now()),
    newJobId: () => createUuidV7(Date.now(), randomBytes(10)),
    newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
    queueName: extra.queueName ?? `out${randomBytes(6).toString("hex")}`,
    deadlineMs: extra.deadlineMs ?? 2_000,
    workerId: extra.workerId ?? `worker-${randomBytes(6).toString("hex")}`,
    beforeCommit: extra.beforeCommit,
    publish: extra.publish,
  });
}

function track(queue) {
  queues.push(queue);
  return queue;
}

function realQueue() {
  return track(new BullMqJobQueue(redisUrl));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function enqueueGate(inner, shouldFail) {
  return {
    enqueue: async (...args) => {
      if (shouldFail()) {
        throw new Error("redis enqueue failed");
      }
      return inner.enqueue(...args);
    },
    reserve: (...args) => inner.reserve(...args),
    complete: (...args) => inner.complete(...args),
    fail: (...args) => inner.fail(...args),
    release: (...args) => inner.release(...args),
    requestCancel: (...args) => inner.requestCancel(...args),
    isCancelRequested: (...args) => inner.isCancelRequested(...args),
    whenLockLost: (...args) => inner.whenLockLost(...args),
    ownsReservation: (...args) => inner.ownsReservation(...args),
    discardQueued: (...args) => inner.discardQueued(...args),
    publishProgress: (...args) => inner.publishProgress(...args),
    close: (...args) => inner.close(...args),
  };
}

async function publishRecord(queue, record) {
  await jobQueue.publishMediaInspectJob(
    {
      jobs: new PostgresJobRepository(pool),
      queue,
      supervisor: {
        async run() {
          throw new Error("The API does not run jobs.");
        },
      },
      now: () => BigInt(Date.now()),
      newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
    },
    {
      jobId: record.jobId,
      mediaAssetId: record.mediaAssetId,
      correlationId: record.correlationId,
      queueName: record.queueName,
    },
  );
}

function uploader(publication) {
  return new CompleteMediaUpload(
    projects,
    media,
    objects,
    new NodeMediaAssetIdGenerator(),
    { now: () => BigInt(Date.now()) },
    publication,
  );
}

async function completeUpload(publication, correlationId, filename, options = {}) {
  const body = options.body ?? Buffer.from(`${filename}-${correlationId}`);
  const declaration = declarationFor(body, filename);
  await objects.put(
    mediaStorageKey(PROJECT, declaration.sha256),
    body,
    "video/mp4",
    declaration.sha256,
  );
  return uploader(publication).execute(OWNER, PROJECT, declaration, correlationId);
}

function declarationFor(body, filename, override) {
  return {
    filename,
    mimeType: "video/mp4",
    byteSize: override?.byteSize ?? body.byteLength,
    sha256: override?.sha256 ?? sha256(body),
  };
}

async function expectOneConsumed(queue, assetId, correlationId) {
  const jobId = await jobIdFor(assetId);
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const logger = createServiceLogger("media-worker", stream);
  const row = await outboxFor(assetId);
  let status = "Queued";
  for (let attempt = 0; attempt < 5 && status === "Queued"; attempt += 1) {
    await runNextJob(
      {
        jobs: new PostgresJobRepository(pool),
        queue,
        supervisor: new ChildProcessJobSupervisor(),
        now: () => BigInt(Date.now()),
        newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
        onLifecycle: (event) => logJobLifecycle(logger, event),
      },
      row.queue_name,
      { modulePath: acknowledge, exportName: "acknowledge" },
    );
    const current = await pool.query("SELECT status FROM jobs WHERE id = $1", [jobId]);
    status = current.rows[0]?.status ?? "";
  }
  assert.equal(status, "Completed");
  const attempts = await pool.query("SELECT status FROM job_attempts WHERE job_id = $1", [jobId]);
  assert.equal(
    attempts.rows.some((item) => item.status === "Completed"),
    true,
  );
  assert.equal(await bullState(jobId), "completed");
  const parsed = lines
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(
    parsed.some((line) => line.message === "job.started" && line.correlationId === correlationId),
    true,
  );
  assert.equal(
    parsed.some((line) => line.message === "job.finished" && line.correlationId === correlationId),
    true,
  );
  assert.equal(await countJobsFor(jobId), 1);
}

async function forceDue(assetId) {
  await pool.query(
    `UPDATE inspect_publication_outbox
     SET available_at = 0
     WHERE media_asset_id = $1 AND status = 'Pending'`,
    [assetId],
  );
}

async function outboxFor(assetId) {
  const result = await pool.query(
    `SELECT job_id::text AS job_id, status, correlation_id, attempt_count, last_error,
            error_history, queue_name, lease_owner
     FROM inspect_publication_outbox WHERE media_asset_id = $1`,
    [assetId],
  );
  return result.rows[0];
}

async function assetIdForCorrelation(correlationId) {
  const result = await pool.query(
    `SELECT media_asset_id::text AS id
     FROM inspect_publication_outbox WHERE correlation_id = $1`,
    [correlationId],
  );
  return result.rows[0].id;
}

async function expireLease(assetId) {
  await pool.query(
    `UPDATE inspect_publication_outbox
     SET lease_until = 0
     WHERE media_asset_id = $1 AND status = 'Delivering'`,
    [assetId],
  );
}

function gate() {
  let open = () => undefined;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function jobIdFor(assetId) {
  const result = await pool.query(
    `SELECT job_id::text AS job_id FROM inspect_publication_outbox WHERE media_asset_id = $1`,
    [assetId],
  );
  return result.rows[0].job_id;
}

async function countJobsFor(jobId) {
  const result = await pool.query("SELECT count(*)::int AS count FROM jobs WHERE id = $1", [jobId]);
  return result.rows[0].count;
}

async function countForAsset(assetId) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM inspect_publication_outbox WHERE media_asset_id = $1",
    [assetId],
  );
  return result.rows[0].count;
}

async function countAssetsForSha(sha) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM media_assets WHERE content_sha256 = $1",
    [sha],
  );
  return result.rows[0].count;
}

async function bullState(jobId) {
  const names = await pool.query("SELECT queue_name FROM jobs WHERE id = $1", [jobId]);
  const queueName = names.rows[0]?.queue_name;
  if (queueName === undefined) {
    return null;
  }
  const named = new Queue(queueName, {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    prefix: "bull",
  });
  try {
    const job = await named.getJob(jobId);
    return job ? await job.getState() : null;
  } finally {
    await named.close();
  }
}

async function countNamed(filename) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM media_assets WHERE display_filename = $1",
    [filename],
  );
  return result.rows[0].count;
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function isolatedRedisUrl(database) {
  const base = process.env.REDIS_URL ?? "redis://127.0.0.1:6379/0";
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function adminUrl() {
  return (
    process.env.DATABASE_URL ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function databaseUrl(database) {
  const parsed = new URL(adminUrl());
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
