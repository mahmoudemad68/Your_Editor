import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { createUuidV7, instant, projectId, userId, jobId, type JobEvent } from "@editagent/domain";
import {
  BullMqJobQueue,
  RedisJobEventPublisher,
  RedisJobEventSubscriber,
  PostgresJobRepository,
  enqueueJob,
  runNextJob,
  projectJobChannel,
} from "@editagent/job-queue";
import { createApiApplication } from "./create-api-application.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { NodeMediaAssetIdGenerator } from "./infrastructure/node-media-asset-id-generator.js";
import { InMemoryMediaAssetRepository } from "./application/in-memory-media-repository.js";
import { MemoryObjectStorage } from "./application/memory-object-storage.js";
import { JwtSessionTokens } from "./infrastructure/jwt-session-tokens.js";
import { authenticateRequest } from "./presentation/authenticate-request.js";
import { SSE_HEARTBEAT_MS } from "./presentation/job-events.controller.js";

const newId = () => createUuidV7(Date.now(), randomBytes(10));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 7000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(1);
  assert.ok(predicate(), "condition did not arrive");
}
interface Trace {
  response: ServerResponse;
  socket: Socket;
  remotePort: number;
  connectedAt: number;
  firstWrittenAt?: number;
  lastProgressAt: number;
  lastProgressAtBlock?: number;
  blockedAt?: number;
  forcedAt?: number;
  endedAt?: number;
  closedAt?: number;
  writes: number;
  destroys: number;
  drainBaseline: number;
  closeBaseline: number;
}
async function kernelSocket(trace: Trace, serverPort: number) {
  const port = (value: number) => value.toString(16).toUpperCase().padStart(4, "0");
  const rows = (await readFile("/proc/net/tcp", "utf8")).trim().split("\n").slice(1);
  const row = rows
    .map((line) => line.trim().split(/\s+/))
    .find(
      (fields) =>
        fields[1]?.endsWith(`:${port(serverPort)}`) &&
        fields[2]?.endsWith(`:${port(trace.remotePort)}`),
    );
  return row
    ? { state: row[3], txQueueBytes: parseInt(row[4]!.split(":")[0]!, 16) }
    : { state: "ABSENT", txQueueBytes: 0 };
}

// Real server response instrumentation observes Node write/drain and actual socket close.
// It neither forces write() results nor changes socket buffer sizes/deadlines.
function observe(response: ServerResponse): Trace {
  const socket = response.socket!;
  const trace: Trace = {
    response,
    socket,
    remotePort: socket.remotePort!,
    connectedAt: Date.now(),
    lastProgressAt: Date.now(),
    writes: 0,
    destroys: 0,
    drainBaseline: response.listenerCount("drain"),
    closeBaseline: response.listenerCount("close"),
  };
  const write = response.write.bind(response);
  response.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    trace.writes++;
    trace.firstWrittenAt ??= Date.now();
    const complete = typeof encoding === "function" ? encoding : callback;
    const confirmed = (error?: Error | null) => {
      if (!error) trace.lastProgressAt = Date.now();
      complete?.(error);
    };
    const writable =
      typeof encoding === "string" ? write(chunk, encoding, confirmed) : write(chunk, confirmed);
    if (!writable && !trace.blockedAt) {
      trace.blockedAt = Date.now();
      trace.lastProgressAtBlock = trace.lastProgressAt;
    }
    return writable;
  };
  const emit = response.emit.bind(response);
  response.emit = (name: string | symbol, ...args: unknown[]) => {
    if (name === "drain") trace.lastProgressAt = Date.now();
    return emit(name, ...args);
  };
  const destroy = response.destroy.bind(response);
  response.destroy = (error?: Error) => {
    trace.forcedAt ??= Date.now();
    trace.destroys++;
    return destroy(error);
  };
  const end = response.end.bind(response);
  response.end = ((...args: Parameters<ServerResponse["end"]>) => {
    trace.endedAt ??= Date.now();
    return end(...args);
  }) as ServerResponse["end"];
  // 'once' removes this observer on close, leaving the pre-controller baseline.
  response.once("close", () => {
    trace.closedAt = Date.now();
  });
  return trace;
}

async function nonReading(
  port: number,
  route: string,
  token: string,
  label: string,
): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    let headers = "";
    const readHeaders = (chunk: Buffer) => {
      headers += chunk.toString();
      if (headers.includes("\r\n\r\n")) {
        assert.match(headers, /^HTTP\/1\.1 200/);
        socket.pause();
        socket.removeListener("data", readHeaders);
        resolve();
      }
    };
    socket.on("data", readHeaders);
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nX-F2-Client: ${label}\r\nConnection: keep-alive\r\n\r\n`,
      ),
    );
  });
  return socket;
}

test(
  "F-2: real non-reading TCP clients are forcibly closed; healthy SSE, Redis and jobs survive",
  { timeout: 120000 },
  async (t) => {
    // Track only the controller's timers, without changing their clocks or callbacks.
    const watchdogs = new Set<ReturnType<typeof setTimeout>>();
    const heartbeats = new Set<ReturnType<typeof setInterval>>();
    let maxWatchdogs = 0;
    const owned = () => {
      const frames = new Error().stack?.split("\n") ?? [];
      const controller = frames.findIndex((frame) => frame.includes("job-events.controller.js:"));
      return (
        controller >= 0 &&
        !frames.slice(0, controller).some((frame) => frame.includes("/node_modules/"))
      );
    };
    const timeout = globalThis.setTimeout,
      clearTimeoutOriginal = globalThis.clearTimeout;
    const interval = globalThis.setInterval,
      clearIntervalOriginal = globalThis.clearInterval;
    t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
      if (!owned()) return timeout(...args);
      const [callback, ms, ...params] = args;
      const timer = timeout(() => {
        watchdogs.delete(timer);
        callback(...params);
      }, ms);
      watchdogs.add(timer);
      maxWatchdogs = Math.max(maxWatchdogs, watchdogs.size);
      return timer;
    });
    t.mock.method(globalThis, "clearTimeout", (...args: Parameters<typeof clearTimeout>) => {
      watchdogs.delete(args[0] as ReturnType<typeof setTimeout>);
      return clearTimeoutOriginal(...args);
    });
    t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => {
      const timer = interval(...args);
      if (owned()) heartbeats.add(timer);
      return timer;
    });
    t.mock.method(globalThis, "clearInterval", (...args: Parameters<typeof clearInterval>) => {
      heartbeats.delete(args[0] as ReturnType<typeof setInterval>);
      return clearIntervalOriginal(...args);
    });
    const adminUrl =
      process.env["DATABASE_URL"] ??
      "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent";
    const db = `editagent_f2_${process.pid}`;
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${db}`);
    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${db}`;
    const pool = new Pool({ connectionString: dbUrl.toString() });
    const redisUrl = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379/0";
    const redis = new Redis(redisUrl);
    redis.on("error", () => undefined);
    const subscriber = new RedisJobEventSubscriber(redisUrl);
    // White-box listener observation is confined to the regression, not a public port.
    const subscriberRedis = (subscriber as unknown as { redis: Redis }).redis;
    const messageListenerBaseline = subscriberRedis.listenerCount("message");
    const publisher = new RedisJobEventPublisher(pool, redisUrl);
    const queue = new BullMqJobQueue(redisUrl, { events: publisher });
    const jobs = new PostgresJobRepository(pool);
    const project = projectId(newId()),
      actor = userId(newId()),
      syntheticId = newId();
    const tokens = new JwtSessionTokens("us130-f2-test-signing-secret-at-least-32");
    const now = () => instant(BigInt(Date.now()));
    const issued = await tokens.issueAccess(actor, now());
    const traces = new Map<string, Trace>();
    const clients: Socket[] = [];
    const healthyEvents: JobEvent[] = [];
    let healthyResponse: IncomingMessage | undefined;
    let heartbeatCount = 0;
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
      (use) => {
        use(authenticateRequest(tokens, now));
        use((rawRequest, rawResponse, next) => {
          const label = (rawRequest as IncomingMessage).headers["x-f2-client"];
          if (typeof label === "string") traces.set(label, observe(rawResponse as ServerResponse));
          next();
        });
      },
    );
    let healthyRequest: ReturnType<typeof request> | undefined;
    try {
      await applyMigrations(pool);
      await pool.query(
        "INSERT INTO users (id,email,password_hash,created_at,updated_at) VALUES ($1,$2,$3,1,1)",
        [actor, `${actor}@example.test`, "$argon2id$test-fixture"],
      );
      await pool.query(
        "INSERT INTO projects (id,name,created_at,updated_at) VALUES ($1,'F2 test',1,1)",
        [project],
      );
      await pool.query(
        "INSERT INTO project_memberships (project_id,user_id,role,created_at) VALUES ($1,$2,'owner',1)",
        [project, actor],
      );
      await app.listen(0, "127.0.0.1");
      const server = app.getHttpServer() as Server;
      const port = (server.address() as { port: number }).port;
      const route = `/projects/${project}/jobs/events`;
      await new Promise<void>((resolve, reject) => {
        healthyRequest = request(
          `http://127.0.0.1:${port}${route}`,
          {
            headers: { authorization: `Bearer ${issued.token}`, "x-f2-client": "healthy" },
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            healthyResponse = res;
            let buffer = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              buffer += chunk;
              let end;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.includes(": heartbeat")) heartbeatCount++;
                const data = frame.split("\n").find((line) => line.startsWith("data: "));
                if (data) healthyEvents.push(JSON.parse(data.slice(6)) as JobEvent);
              }
            });
            res.on("error", () => undefined);
            resolve();
          },
        );
        healthyRequest.on("error", reject);
        healthyRequest.end();
      });
      // A watchdog is not a five-second SSE connection lifetime, including idle clients.
      await delay(5500);
      assert.equal(healthyResponse!.destroyed, false);
      assert.equal(watchdogs.size, 0);
      const slowLabels = ["slow-1", "slow-2", "slow-3"];
      for (const label of slowLabels)
        clients.push(await nonReading(port, route, issued.token, label));
      await until(() => subscriber.subscriptionCount === 4);
      const sample = (sequence: number): JobEvent => ({
        schemaVersion: 1,
        eventId: `${syntheticId}:${sequence}`,
        jobId: syntheticId,
        jobType: "sample.progress",
        projectId: project,
        sequence,
        attempt: 1,
        occurredAt: new Date().toISOString(),
        correlationId: "f2-heavy-client-regression",
        kind: "progress",
        percentage: 50,
        stage: "proxy",
      });
      const inputEvents = 16000;
      let maxRedisPublishMs = 0;
      for (let sequence = 1; sequence <= inputEvents; sequence++) {
        const active = [...traces.values()].filter((trace) => !trace.blockedAt && !trace.closedAt);
        const before = active.map((trace) => trace.writes);
        const start = Date.now();
        await redis.publish(projectJobChannel(project), JSON.stringify(sample(sequence)));
        maxRedisPublishMs = Math.max(maxRedisPublishMs, Date.now() - start);
        // Pace pre-backpressure reports by actual server writes, avoiding application
        // coalescing disguising the kernel send-buffer heavy case. Queued events after
        // backpressure keep arriving and must not extend the blocked-write deadline.
        await until(() =>
          active.every((trace, i) => trace.writes > before[i]! || trace.closedAt !== undefined),
        );
        if (slowLabels.every((label) => traces.get(label)!.blockedAt !== undefined)) {
          // Continue generating valid reports without waiting for non-reading clients.
          for (let remaining = sequence + 1; remaining <= inputEvents; remaining++) {
            const start = Date.now();
            await redis.publish(projectJobChannel(project), JSON.stringify(sample(remaining)));
            maxRedisPublishMs = Math.max(maxRedisPublishMs, Date.now() - start);
            if (remaining % 100 === 0) await delay(1);
          }
          break;
        }
      }
      await until(
        () =>
          slowLabels.every((label) => traces.get(label)!.forcedAt || traces.get(label)!.endedAt),
        7000,
      );
      await delay(100);
      const observations = [];
      for (const label of slowLabels) {
        const trace = traces.get(label)!;
        const kernel = await kernelSocket(trace, port);
        observations.push({
          client: label,
          clientConnectedAt: trace.connectedAt,
          firstEventWrittenAt: trace.firstWrittenAt,
          backpressureDetectedAt: trace.blockedAt,
          lastConfirmedForwardProgress: trace.lastProgressAt,
          lastProgressAtBackpressure: trace.lastProgressAtBlock,
          watchdogDeadline: trace.lastProgressAt + 5000,
          forcedSocketDestroyAt: trace.forcedAt ?? null,
          normalEndAt: trace.endedAt ?? null,
          serverSocketClosedAt: trace.closedAt ?? null,
          blockedDurationMs: trace.forcedAt ? trace.forcedAt - trace.blockedAt! : null,
          socketDestroyed: trace.socket.destroyed,
          kernelState: kernel.state,
          kernelTxQueueBytes: kernel.txQueueBytes,
          serverWrites: trace.writes,
          destroyCalls: trace.destroys,
          drainListeners: trace.response.listenerCount("drain"),
          closeListeners: trace.response.listenerCount("close"),
          nodeWritableBytes: trace.response.writableLength,
        });
      }
      console.log(
        "US130_F2_TCP_TIMELINE",
        JSON.stringify({ inputEvents, maxRedisPublishMs, maxWatchdogs, clients: observations }),
      );
      for (const label of slowLabels) {
        const trace = traces.get(label)!;
        assert.ok(trace.blockedAt, "real Node backpressure was required");
        assert.ok(trace.forcedAt, "slow enforcement must destroy, not only end, the response");
        assert.ok(
          trace.closedAt && trace.socket.destroyed,
          "server-side socket must close without client cooperation",
        );
        assert.ok(
          trace.forcedAt - trace.blockedAt <= 5500,
          "bounded deadline after observed backpressure",
        );
        assert.ok(
          trace.forcedAt - trace.lastProgressAt <= 5500,
          "deadline measured from confirmed writable progress",
        );
        assert.equal(trace.destroys, 1);
        assert.equal(trace.response.listenerCount("drain"), trace.drainBaseline);
        assert.equal(trace.response.listenerCount("close"), trace.closeBaseline);
        assert.equal(
          (await kernelSocket(trace, port)).txQueueBytes,
          0,
          "forced cleanup releases queued kernel output",
        );
        assert.notEqual(
          (await kernelSocket(trace, port)).state,
          "01",
          "no ESTAB socket may survive forced cleanup",
        );
      }
      await until(() => subscriber.subscriptionCount === 1);
      assert.ok(maxRedisPublishMs <= 1000, "Redis publication never waits for slow TCP clients");
      assert.equal(subscriberRedis.listenerCount("message"), messageListenerBaseline);
      assert.equal(watchdogs.size, 0, "all slow watchdogs cleared");
      assert.equal(heartbeats.size, 1, "only healthy heartbeat remains");
      assert.ok(maxWatchdogs <= 4, "at most one watchdog per stream");
      const writesAfter = slowLabels.map((label) => traces.get(label)!.writes);
      for (const label of slowLabels) traces.get(label)!.response.emit("drain");
      await redis.publish(projectJobChannel(project), JSON.stringify(sample(inputEvents + 1)));
      await until(() => healthyEvents.some((event) => event.sequence === inputEvents + 1));
      assert.deepEqual(
        slowLabels.map((label) => traces.get(label)!.writes),
        writesAfter,
        "cleared pending buffers cannot pump after close",
      );
      const realId = newId(),
        queueName = `f2-job-${process.pid}`;
      const deps = {
        jobs,
        queue,
        now,
        newAttemptId: newId,
        supervisor: {
          async run() {
            await queue.publishProgress(realId, {
              percentage: 100,
              stage: "finalizing",
              attempt: 1,
            });
          },
        },
      };
      await enqueueJob(deps, {
        id: realId,
        queueName,
        jobType: "sample.progress",
        idempotencyKey: realId,
        subject: { kind: "project", projectId: project },
        payload: {},
        timeoutMs: 10000,
        maxAttempts: 1,
        backoffBaseMs: 1,
      });
      await runNextJob(deps, queueName, { modulePath: "fixture", exportName: "fixture" });
      await until(() =>
        healthyEvents.some(
          (event) =>
            event.jobId === realId && event.kind === "state" && event.status === "Completed",
        ),
      );
      assert.equal((await jobs.findById(jobId(realId)))!.status, "Completed");
      await until(() => heartbeatCount > 0, SSE_HEARTBEAT_MS + 2000);
      assert.equal(
        healthyResponse!.destroyed,
        false,
        "reading/idle/heartbeat client remains healthy",
      );
      const connections = await new Promise<number>((resolve, reject) =>
        server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      );
      assert.equal(connections, 1, "only the healthy TCP socket remains");
      healthyResponse!.destroy();
      healthyRequest!.destroy();
      await until(
        () => subscriber.subscriptionCount === 0 && heartbeats.size === 0 && watchdogs.size === 0,
      );
      console.log(
        "US130_F2_CLEANUP",
        JSON.stringify({
          healthyConnected: true,
          heartbeatCount,
          realJobStatus: "Completed",
          redisSubscriptionsAfter: subscriber.subscriptionCount,
          watchdogsAfter: watchdogs.size,
          heartbeatsAfter: heartbeats.size,
          pendingPumpWritesAfter: 0,
          redisMessageListenerBaseline: messageListenerBaseline,
          redisMessageListenersAfter: subscriberRedis.listenerCount("message"),
          serverConnectionsBeforeHealthyClose: connections,
        }),
      );
    } finally {
      // Failure-path teardown closes test-owned sockets, including the old leaking
      // implementation during intentional before/after reproduction; no process hangs.
      for (const trace of traces.values()) trace.socket.destroy();
      for (const client of clients) client.destroy();
      healthyResponse?.destroy();
      healthyRequest?.destroy();
      await app.close();
      await queue.close();
      await subscriber.close();
      redis.disconnect();
      await pool.end();
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
      await admin.end();
      assert.equal(
        subscriberRedis.listenerCount("message"),
        0,
        "API shutdown removes subscriber listener",
      );
    }
  },
);
