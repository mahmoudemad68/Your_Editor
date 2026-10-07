import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import { Pool } from "pg";
import { Redis } from "ioredis";
import {
  createUuidV7,
  instant,
  projectId,
  userId,
  jobId,
  type JobEvent,
  type JobSubject,
  MediaAsset,
  mediaAssetId,
  derivedAssetId,
} from "@editagent/domain";
import {
  BullMqJobQueue,
  RedisJobEventPublisher,
  RedisJobEventSubscriber,
  PostgresJobRepository,
  enqueueJob,
  cancelJob,
  projectJobChannel,
} from "@editagent/job-queue";
import { createApiApplication } from "./create-api-application.js";
import { PostgresMediaAssetRepository } from "./infrastructure/postgres-media-repository.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { authenticateRequest } from "./presentation/authenticate-request.js";

const newId = () => createUuidV7(Date.now(), randomBytes(10));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), "condition did not arrive");
}
interface Received {
  event: JobEvent;
  receivedAt: number;
}
interface Reports {
  type: string;
  jobId: string;
  attempt: number;
  percentage: number;
  stage: string;
  reportedAt: number;
}
interface Stream {
  events: Received[];
  req: ClientRequest;
  res: IncomingMessage;
  close(): void;
}
async function connect(url: string, token: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const events: Received[] = [];
    const req = request(url, { headers: { authorization: `Bearer ${token}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
      assert.match(res.headers["cache-control"] ?? "", /no-store/);
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (data)
            events.push({ event: JSON.parse(data.slice(6)) as JobEvent, receivedAt: Date.now() });
        }
      });
      resolve({
        events,
        req,
        res,
        close: () => {
          res.destroy();
          req.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test(
  "US-130 authenticated real SSE/Redis/Postgres worker latency, ordering, retries, cancellation, isolation and cleanup",
  { timeout: 60000 },
  async () => {
    const adminUrl =
      process.env["DATABASE_URL"] ??
      "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
    const db = `editagent_us130_${process.pid}`;
    const admin = new Pool({ connectionString: adminUrl });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(adminUrl);
    url.pathname = `/${db}`;
    const pool = new Pool({ connectionString: url.toString() });
    pool.on("error", () => undefined);
    const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0";
    const publisher = new RedisJobEventPublisher(pool, redisUrl);
    const subscriber = new RedisJobEventSubscriber(redisUrl);
    const redis = new Redis(redisUrl);
    redis.on("error", () => undefined);
    const queue = new BullMqJobQueue(redisUrl, { events: publisher });
    const jobs = new PostgresJobRepository(pool);
    const queueName = `events-${process.pid}-${newId()}`;
    const actor = userId(newId()),
      other = userId(newId()),
      viewer = userId(newId());
    const a = projectId(newId()),
      b = projectId(newId()),
      deleted = projectId(newId());
    const tokens = new JwtSessionTokens("us130-test-signing-secret-at-least-32");
    const now = () => instant(BigInt(Date.now()));
    const issued = await tokens.issueAccess(actor, now());
    const viewerToken = await tokens.issueAccess(viewer, now());
    const reports: Reports[] = [];
    const streams: Stream[] = [];
    const deps = { jobs, queue, now, newAttemptId: newId, supervisor: { async run() {} } };
    const app = await createApiApplication(
      {
        projects: new PostgresProjectRepository(pool),
        clock: { now },
        ids: new NodeProjectIdGenerator(),
        media: new InMemoryMediaAssetRepository(),
        objects: new MemoryObjectStorage(),
        mediaIds: new NodeMediaAssetIdGenerator(),
        presignTtlSeconds: 900,
        jobEvents: subscriber,
      },
      (use) => use(authenticateRequest(tokens, now)),
    );
    const runWorker = (mode = "success", transportUrl = redisUrl) =>
      new Promise<void>((resolve, reject) => {
        const child = fork(path.join(__dirname, "infrastructure/job-event-test-worker.js"), [], {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        child.send({ databaseUrl: url.toString(), redisUrl, transportUrl, queueName, mode });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("message", (raw) => {
          const report = raw as Reports;
          if (report.type === "reported") reports.push(report);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker failed ${stderr}`));
        });
      });
    const create = async (
      project = a,
      subject: JobSubject = { kind: "project", projectId: project },
    ) => {
      const id = newId();
      await enqueueJob(deps, {
        id,
        queueName,
        jobType: "sample.progress",
        idempotencyKey: id,
        subject,
        payload: { correlationId: "us130-evidence", projectId: b },
        timeoutMs: 10000,
        maxAttempts: 2,
        backoffBaseMs: 1,
      });
      return id;
    };
    try {
      await applyMigrations(pool);
      for (const id of [actor, other, viewer])
        await pool.query(
          "INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ($1,$2,$3,1,1)",
          [id, `${id}@example.test`, "$argon2id$test-fixture"],
        );
      for (const [id, owner, gone] of [
        [a, actor, false],
        [b, other, false],
        [deleted, actor, true],
      ] as const) {
        await pool.query(
          "INSERT INTO projects (id,name,created_at,updated_at,deleted_at) VALUES ($1,'safe test',1,1,$2)",
          [id, gone ? 1 : null],
        );
        await pool.query(
          "INSERT INTO project_memberships (project_id,user_id,role,created_at) VALUES ($1,$2,'owner',1)",
          [id, owner],
        );
      }
      await pool.query(
        "INSERT INTO project_memberships (project_id,user_id,role,created_at) VALUES ($1,$2,'viewer',1)",
        [a, viewer],
      );
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as { port: number };
      const base = `http://127.0.0.1:${address.port}`;
      const route = (id: string) => `${base}/projects/${id}/jobs/events`;
      assert.equal((await fetch(route(a))).status, 401);
      assert.equal(
        (await fetch(route("invalid"), { headers: { authorization: `Bearer ${issued.token}` } }))
          .status,
        400,
      );
      for (const id of [b, newId(), deleted]) {
        const denied = await fetch(route(id), {
          headers: { authorization: `Bearer ${issued.token}` },
        });
        assert.equal(denied.status, 404);
        assert.equal(((await denied.json()) as { message: string }).message, "Project not found.");
      }
      const stream = await connect(route(a), issued.token);
      streams.push(stream);
      const view = await connect(route(a), viewerToken.token);
      streams.push(view);
      const id = await create();
      await runWorker();
      await until(() =>
        stream.events.some(
          ({ event }) =>
            event.jobId === id && event.kind === "state" && event.status === "Completed",
        ),
      );
      const flow = stream.events.filter(({ event }) => event.jobId === id);
      assert.deepEqual(
        flow
          .filter(({ event }) => event.kind === "state")
          .map(({ event }) => (event.kind === "state" ? event.status : "")),
        ["Queued", "Running", "Completed"],
      );
      assert.ok(flow.some(({ event }) => event.kind === "progress"));
      for (let i = 1; i < flow.length; i++)
        assert.ok(flow[i]!.event.sequence > flow[i - 1]!.event.sequence);
      const latencies = flow
        .filter(({ event }) => event.kind === "progress")
        .map(({ event, receivedAt }) => {
          assert.equal(event.kind, "progress");
          if (event.kind !== "progress") throw new Error();
          const report = reports.find(
            (r) =>
              r.jobId === id &&
              r.attempt === event.attempt &&
              r.percentage === event.percentage &&
              r.stage === event.stage,
          );
          assert.ok(report);
          const latency = receivedAt - report.reportedAt;
          assert.ok(latency <= 1000, `${latency}ms`);
          return latency;
        });
      assert.equal((await jobs.findById(jobId(id)))?.status, "Completed");
      assert.ok(view.events.some(({ event }) => event.jobId === id));
      const q = await create(b);
      await runWorker();
      assert.equal((await jobs.findById(jobId(q)))?.status, "Completed");
      await delay(100);
      assert.equal(
        stream.events.filter(({ event }) => event.projectId === b || event.jobId === q).length,
        0,
      );
      const media = mediaAssetId(newId()),
        derived = derivedAssetId(newId());
      await new PostgresMediaAssetRepository(pool).save(
        MediaAsset.createUploaded({
          id: media,
          projectId: b,
          createdAt: now(),
          displayFilename: "safe.mp4",
          mimeType: "video/mp4",
          byteSize: 1,
          contentSha256: "ab".repeat(32),
        }),
      );
      const signature = "cd".repeat(32);
      await pool.query(
        `INSERT INTO derived_assets (id,media_asset_id,project_id,kind,storage_key,parameter_signature,mime_type,byte_size,content_sha256,metadata,created_at,updated_at) VALUES ($1,$2,$3,'proxy',$4,$5,'video/mp4',1,$6,$7::jsonb,1,1)`,
        [
          derived,
          media,
          b,
          `projects/${b}/derived/${media}/proxy/${signature}/proxy.mp4`,
          signature,
          "ab".repeat(32),
          JSON.stringify({ variant: "proxy", parameters: {} }),
        ],
      );
      for (const subject of [
        { kind: "media-asset", mediaAssetId: media },
        { kind: "derived-asset", derivedAssetId: derived },
      ] as const) {
        const before = stream.events.length;
        const owned = await create(a, subject);
        await runWorker();
        await delay(30);
        assert.equal((await jobs.findById(jobId(owned)))?.status, "Completed");
        assert.equal(
          stream.events.length,
          before,
          "persisted media/derived ownership overrides payload and caller project",
        );
      }
      const missing = await create(a, { kind: "media-asset", mediaAssetId: mediaAssetId(newId()) });
      const beforeMissing = stream.events.length;
      await runWorker();
      await delay(30);
      assert.equal(stream.events.length, beforeMissing, "missing persisted ownership fails closed");
      assert.equal((await jobs.findById(jobId(missing)))?.status, "Completed");
      // Same payload tries to spoof B; trusted project subject routed the first job to A.
      const burst = await create();
      await runWorker("burst");
      await until(() =>
        stream.events.some(
          ({ event }) =>
            event.jobId === burst && event.kind === "state" && event.status === "Completed",
        ),
      );
      const burstEvents = stream.events.filter(
        ({ event }) => event.jobId === burst && event.kind === "progress",
      );
      const inputs = reports.filter((r) => r.jobId === burst).length;
      assert.ok(inputs >= 100);
      assert.ok(burstEvents.length < inputs / 4);
      assert.ok(
        burstEvents.some(({ event }) => event.kind === "progress" && event.percentage === 100),
      );
      const terminal = stream.events.find(
        ({ event }) =>
          event.jobId === burst && event.kind === "state" && event.status === "Completed",
      )!;
      assert.ok(terminal.receivedAt - Date.parse(terminal.event.occurredAt) <= 1000);
      const concurrent = await create();
      await jobs.save((await jobs.findById(jobId(concurrent)))!.start(now()));
      await queue.publishState(concurrent);
      const secondPublisher = new RedisJobEventPublisher(pool, redisUrl);
      try {
        await Promise.all([
          publisher.progress(concurrent, { attempt: 1, percentage: 25, stage: "proxy" }),
          secondPublisher.progress(concurrent, { attempt: 1, percentage: 25, stage: "proxy" }),
        ]);
      } finally {
        await secondPublisher.close();
      }
      await runWorker();
      await until(() =>
        stream.events.some(
          ({ event }) =>
            event.jobId === concurrent && event.kind === "state" && event.status === "Completed",
        ),
      );
      const concurrentFlow = stream.events.filter(({ event }) => event.jobId === concurrent);
      assert.equal(
        new Set(concurrentFlow.map(({ event }) => event.sequence)).size,
        concurrentFlow.length,
      );
      for (let i = 1; i < concurrentFlow.length; i++)
        assert.ok(concurrentFlow[i]!.event.sequence > concurrentFlow[i - 1]!.event.sequence);
      assert.ok(
        concurrentFlow.some(({ event }) => event.kind === "progress" && event.attempt === 2),
      );
      const beforeDuplicate = stream.events.length;
      await enqueueJob(deps, {
        id,
        queueName,
        jobType: "sample.progress",
        idempotencyKey: id,
        subject: { kind: "project", projectId: a },
        payload: { correlationId: "us130-evidence", projectId: b },
        timeoutMs: 10000,
        maxAttempts: 2,
        backoffBaseMs: 1,
      });
      await delay(30);
      assert.equal(
        stream.events.length,
        beforeDuplicate,
        "duplicate acknowledgement does not manufacture a transition",
      );
      const retry = await create();
      await runWorker("retry");
      await delay(20);
      await runWorker("retry");
      await until(() =>
        stream.events.some(
          ({ event }) =>
            event.jobId === retry && event.kind === "state" && event.status === "Completed",
        ),
      );
      const retryFlow = stream.events
        .filter(({ event }) => event.jobId === retry)
        .map(({ event }) => event);
      assert.deepEqual(
        retryFlow
          .filter((e) => e.kind === "state")
          .map((e) => (e.kind === "state" ? `${e.status}:${e.attempt}` : "")),
        ["Queued:0", "Running:1", "Retrying:1", "Running:2", "Completed:2"],
      );
      assert.ok(
        retryFlow.some((e) => e.kind === "progress" && e.attempt === 2 && e.percentage === 0),
      );
      for (let i = 1; i < retryFlow.length; i++)
        assert.ok(retryFlow[i]!.sequence > retryFlow[i - 1]!.sequence);
      for (const [mode, status] of [
        ["fail", "Failed"],
        ["cancel", "Cancelled"],
      ]) {
        const failed = await create();
        await runWorker(mode);
        await until(() =>
          stream.events.some(
            ({ event }) =>
              event.jobId === failed && event.kind === "state" && event.status === status,
          ),
        );
        assert.equal((await jobs.findById(jobId(failed)))?.status, status);
      }
      const cancelled = await create();
      await cancelJob(deps, cancelled);
      await until(() =>
        stream.events.some(
          ({ event }) =>
            event.jobId === cancelled && event.kind === "state" && event.status === "Cancelled",
        ),
      );
      assert.deepEqual(
        stream.events
          .filter(({ event }) => event.jobId === cancelled)
          .map(({ event }) => (event.kind === "state" ? event.status : "progress")),
        ["Queued", "Cancelled"],
      );
      assert.ok(!JSON.stringify(stream.events).includes("unsafe secret"));
      const clients = String(await redis.client("LIST"));
      const subscriberClient = clients
        .split("\n")
        .find((line) => line.includes(`name=${subscriber.connectionName} `));
      assert.ok(subscriberClient);
      const subscriberId = subscriberClient.match(/id=(\d+)/)?.[1];
      assert.ok(subscriberId);
      await redis.client("KILL", "ID", subscriberId);
      await delay(500);
      const afterReconnect = await create();
      await runWorker();
      await until(() =>
        stream.events.some(
          ({ event }) =>
            event.jobId === afterReconnect &&
            event.kind === "state" &&
            event.status === "Completed",
        ),
      );
      const count = stream.events.length;
      await redis.publish(projectJobChannel(a), "{broken");
      await redis.publish(
        projectJobChannel(a),
        JSON.stringify({ ...flow[0]!.event, projectId: b }),
      );
      await delay(50);
      assert.equal(stream.events.length, count);
      const viewerCount = view.events.length;
      await pool.query("DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2", [
        a,
        viewer,
      ]);
      const afterRevocation = await create();
      await runWorker();
      await until(() => subscriber.subscriptionCount === 1);
      assert.equal(
        view.events.length,
        viewerCount,
        "revoked Viewer receives no subsequent job information",
      );
      assert.ok(stream.events.some(({ event }) => event.jobId === afterRevocation));
      view.close();
      stream.close();
      await until(() => subscriber.subscriptionCount === 0);
      const reconnected = await connect(route(a), issued.token);
      streams.push(reconnected);
      const resumed = await create();
      await runWorker();
      await until(() =>
        reconnected.events.some(
          ({ event }) =>
            event.jobId === resumed && event.kind === "state" && event.status === "Completed",
        ),
      );
      assert.ok(reconnected.events.every(({ event }) => event.projectId === a));
      reconnected.res.pause();
      for (let i = 0; i < 1000; i++)
        await redis.publish(
          projectJobChannel(a),
          JSON.stringify({ ...flow[0]!.event, sequence: i + 1, eventId: `${id}:${i + 1}` }),
        );
      // Client read speed never participates in publisher acknowledgement or worker completion.
      await until(() => subscriber.subscriptionCount === 0);
      reconnected.close();
      await until(() => subscriber.subscriptionCount === 0);
      const noClient = await create();
      await runWorker();
      assert.equal((await jobs.findById(jobId(noClient)))?.status, "Completed");
      for (const value of [NaN, Infinity, -1, 101])
        await assert.rejects(
          queue.publishProgress(id, { attempt: 1, stage: "proxy", percentage: value }),
        );
      const unavailable = new RedisJobEventPublisher(pool, "redis://127.0.0.1:1");
      const outageJob = await create();
      const active = (await jobs.findById(jobId(outageJob)))!.start(now());
      await jobs.save(active);
      await assert.rejects(unavailable.state(outageJob));
      await assert.rejects(
        unavailable.progress(outageJob, { attempt: 1, stage: "proxy", percentage: 50 }),
      );
      await unavailable.close();
      await runWorker("success", "redis://127.0.0.1:1");
      assert.equal((await jobs.findById(jobId(outageJob)))?.status, "Completed");
      console.log(
        "US130_EVIDENCE",
        JSON.stringify({
          projectId: a,
          otherProjectId: b,
          jobId: id,
          otherJobId: q,
          otherDurableStatus: (await jobs.findById(jobId(q)))?.status,
          events: flow.map(({ event, receivedAt }) => {
            const report =
              event.kind === "progress"
                ? reports.find(
                    (r) =>
                      r.jobId === id &&
                      r.attempt === event.attempt &&
                      r.percentage === event.percentage &&
                      r.stage === event.stage,
                  )
                : undefined;
            return {
              event,
              receivedAt,
              ...(report
                ? {
                    reportedAt: report.reportedAt,
                    reportToReceiveMs: receivedAt - report.reportedAt,
                  }
                : { occurrenceToReceiveMs: receivedAt - Date.parse(event.occurredAt) }),
            };
          }),
          finalDurableStatus: "Completed",
          maxLatencyMs: Math.max(...latencies),
          crossProjectEvents: 0,
          burstInput: inputs,
          burstOutput: burstEvents.length,
          terminalOccurrenceToReceiveMs:
            terminal.receivedAt - Date.parse(terminal.event.occurredAt),
          terminalDelivered: true,
          retryFlow,
          disconnectSubscriptions: subscriber.subscriptionCount,
        }),
      );
    } finally {
      for (const stream of streams) stream.close();
      await app.close();
      await queue.close();
      await subscriber.close();
      redis.disconnect();
      await pool.end();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
    }
  },
);
