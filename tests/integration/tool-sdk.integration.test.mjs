import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import {
  ToolExecutor,
  ToolRegistry,
  PostgresToolAuditRepository,
  PostgresToolAuthority,
  PostgresRemoteCallStore,
  QueueToolDispatcher,
  RemoteToolConsumer,
  RemoteToolSupervisor,
  IsolatedTool,
  ToolError,
  contentHash,
} from "../../packages/tool-sdk/dist/index.js";
import { createUuidV7, instant } from "../../packages/domain/dist/index.js";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  enqueueJob,
  cancelJob,
  runNextJob,
  PermanentJobError,
  JobCancelledError,
  RedisJobEventPublisher,
  RedisJobEventSubscriber,
} from "../../packages/job-queue/dist/index.js";
import { startPostgres, startRedis } from "./support/containers.mjs";
const newId = () => createUuidV7(Date.now(), randomBytes(10));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", minLength: 1, maxLength: 128 } },
};
const root = path.resolve(import.meta.dirname, "../..");
test(
  "real Tool SDK remote lifecycle, durable audit, permission and owned-work security",
  { timeout: 90000 },
  async (t) => {
    let pg, redis, pool, bootstrap, queue, events, subscriber, subscription;
    const namespace = `tools_${randomUUID().replaceAll("-", "")}`;
    try {
      if (!process.env.DATABASE_URL) pg = await startPostgres();
      if (!process.env.REDIS_URL) redis = await startRedis();
      bootstrap = new Pool({ connectionString: process.env.DATABASE_URL ?? pg.url });
      await bootstrap.query(`CREATE SCHEMA ${namespace}`);
      pool = new Pool({
        connectionString: process.env.DATABASE_URL ?? pg.url,
        options: `-c search_path=${namespace}`,
        max: 8,
        connectionTimeoutMillis: 1000,
        statement_timeout: 2000,
      });
      for (const file of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      const owner = newId(),
        viewer = newId(),
        outsider = newId(),
        project = newId(),
        otherProject = newId();
      for (const [i, id] of [owner, viewer, outsider].entries())
        await pool.query(
          "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES ($1,$2,'$argon2id$test',0,0)",
          [id, `test${i}@example.com`],
        );
      for (const id of [project, otherProject])
        await pool.query(
          "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'test',0,0)",
          [id],
        );
      await pool.query(
        "INSERT INTO project_memberships VALUES ($1,$2,'owner',0),($1,$3,'viewer',0)",
        [project, owner, viewer],
      );
      const authority = new PostgresToolAuthority(pool, async () => {
        throw new ToolError("missing_timeline");
      });
      const audit = new PostgresToolAuditRepository(pool, 10000),
        store = new PostgresRemoteCallStore(pool),
        jobs = new PostgresJobRepository(pool);
      const seen = [];
      events = new RedisJobEventPublisher(pool, process.env.REDIS_URL ?? redis.url);
      subscriber = new RedisJobEventSubscriber(process.env.REDIS_URL ?? redis.url);
      subscription = await subscriber.subscribe(
        project,
        (e) => seen.push(e),
        () => undefined,
      );
      queue = new BullMqJobQueue(process.env.REDIS_URL ?? redis.url, {
        events,
        lockDurationMs: 2000,
        stalledIntervalMs: 200,
      });
      const registry = new ToolRegistry(),
        toolId = newId();
      const base = {
        schemaVersion: 1,
        id: toolId,
        name: "proof.echo",
        version: "1.0.0",
        description: "Fixed proof worker",
        inputSchema: schema,
        outputSchema: schema,
        permissions: ["project.read", "render.create"],
        capabilities: ["render"],
        estimatedCostMicros: 1,
        maximumCostMicros: 10,
        timeoutMs: 3000,
        mutating: false,
        validationRules: [],
      };
      registry.register(base, { mode: "remote", target: "media" });
      registry.register(
        { ...base, id: newId(), name: "proof.busy", timeoutMs: 1000 },
        { mode: "remote", target: "media" },
      );
      registry.register(
        { ...base, id: newId(), name: "proof.busy-cancel", timeoutMs: 10000 },
        { mode: "remote", target: "media" },
      );
      const implementations = new Map([
        [
          "proof.echo@1.0.0",
          new IsolatedTool(
            path.join(root, "tests/integration/support/tool-operations.cjs"),
            "echo",
          ),
        ],
        [
          "proof.busy@1.0.0",
          new IsolatedTool(
            path.join(root, "tests/integration/support/tool-operations.cjs"),
            "busy",
          ),
        ],
      ]);
      implementations.set("proof.busy-cancel@1.0.0", implementations.get("proof.busy@1.0.0"));
      const consumer = new RemoteToolConsumer(
        registry,
        authority,
        store,
        audit,
        queue,
        implementations,
        "media",
      );
      const supervisor = new RemoteToolSupervisor(
        consumer,
        (code) => new PermanentJobError(code),
        () => new JobCancelledError(),
      );
      const deps = {
        jobs,
        queue,
        supervisor,
        now: () => instant(BigInt(Date.now())),
        newAttemptId: newId,
      };
      const dispatcher = new QueueToolDispatcher(
        jobs,
        { enqueue: (i) => enqueueJob(deps, i), cancel: (id) => cancelJob(deps, id) },
        store,
        audit,
      );
      const executor = new ToolExecutor(registry, authority, audit, dispatcher);
      const call = {
        name: "proof.echo",
        version: "1.0.0",
        callerId: owner,
        projectId: project,
        resource: { kind: "project", id: project },
        input: { text: "مرحبا 👩‍💻" },
      };
      let activeQueue = "tools-media-v1",
        activeDeps = deps;
      let consuming = false,
        stopped = false;
      const pump = async () => {
        while (!stopped) {
          if (consuming)
            await runNextJob(activeDeps, activeQueue, {
              modulePath: "registered-only",
              exportName: "fixed",
            });
          await delay(10);
        }
      };
      const worker = pump();
      try {
        await t.test(
          "unauthorized scopes/roles denied before a queue or worker side effect",
          async () => {
            for (const bad of [
              { ...call, callerId: viewer },
              { ...call, callerId: outsider },
              { ...call, projectId: otherProject },
              { ...call, resource: { kind: "project", id: otherProject } },
              { ...call, input: { text: 1 } },
            ])
              await assert.rejects(executor.execute(bad));
            assert.equal((await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n, 0);
            assert.equal((await executor.records(owner, project)).length, 4);
          },
        );
        await t.test(
          "real queue consumer + isolated worker + correlated durable result and progress",
          async () => {
            consuming = true;
            const result = await executor.execute(call);
            assert.deepEqual(result.output, call.input);
            assert.equal(result.record.outcome, "succeeded");
            assert.equal((await jobs.findById(result.record.jobId)).status, "Completed");
            await delay(250);
            assert.ok(seen.some((e) => e.kind === "progress" && e.jobId === result.record.jobId));
            assert.ok(seen.some((e) => e.kind === "state" && e.status === "Completed"));
            const query = await promisify(execFile)(
              process.execPath,
              [
                path.join(root, "tests/integration/support/tool-audit-query.cjs"),
                owner,
                result.record.id,
              ],
              {
                env: {
                  PATH: process.env.PATH,
                  DATABASE_URL: process.env.DATABASE_URL ?? pg.url,
                  TOOL_TEST_SCHEMA: namespace,
                },
                timeout: 5000,
              },
            );
            assert.deepEqual(JSON.parse(query.stdout), result.record);
            const restartedAudit = new PostgresToolAuditRepository(pool, 10000);
            assert.deepEqual(await restartedAudit.get(result.record.id), result.record);
            await assert.rejects(executor.record(outsider, result.record.id), /denied/);
            assert.ok(
              !JSON.stringify(await executor.records(owner, project)).includes(call.input.text),
            );
          },
        );
        await t.test(
          "queued cancellation, duplicate cancellation, no eventual result",
          async () => {
            consuming = false;
            const controller = new globalThis.AbortController();
            const execution = executor.execute(call, controller.signal);
            let record;
            for (let i = 0; i < 100; i++) {
              record = (await executor.records(owner, project)).find(
                (r) => r.outcome === "running" && r.jobId,
              );
              if (record) break;
              await delay(10);
            }
            assert.ok(record);
            controller.abort();
            await assert.rejects(execution, /cancelled/);
            await cancelJob(deps, record.jobId);
            assert.equal((await jobs.findById(record.jobId)).status, "Cancelled");
            assert.equal(await store.result(record.id), null);
            consuming = true;
          },
        );
        await t.test(
          "non-cooperative active remote work killed on timeout and cancellation",
          async () => {
            for (const cancel of [false, true]) {
              const controller = new globalThis.AbortController();
              const execution = executor.execute(
                { ...call, name: cancel ? "proof.busy-cancel" : "proof.busy" },
                controller.signal,
              );
              void execution.catch(() => undefined);
              let record;
              for (let i = 0; i < 100; i++) {
                const candidate = (await executor.records(owner, project)).find(
                  (r) =>
                    r.outcome === "running" &&
                    r.toolName === (cancel ? "proof.busy-cancel" : "proof.busy"),
                );
                record = candidate ?? record;
                if (
                  record?.jobId &&
                  (!cancel || (await jobs.findById(record.jobId))?.status === "Running") &&
                  seen.some((e) => e.kind === "progress" && e.jobId === record.jobId)
                )
                  break;
                await delay(10);
              }
              assert.ok(record?.jobId);
              assert.ok(
                seen.some((e) => e.kind === "progress" && e.jobId === record.jobId),
                "real busy operation must be active before cancellation",
              );
              if (cancel)
                assert.equal(implementations.get("proof.busy@1.0.0").activeWorkerCount, 1);
              if (cancel) controller.abort();
              await assert.rejects(execution, cancel ? /cancelled/ : /timed_out/);
              const final = await executor.record(owner, record.id);
              assert.equal(final.outcome, cancel ? "cancelled" : "timed_out");
              const jobStatus = (await jobs.findById(record.jobId)).status;
              if (cancel) assert.equal(jobStatus, "Cancelled");
              else assert.ok(["Cancelled", "Failed"].includes(jobStatus));
              assert.equal(await store.result(record.id), null);
              assert.equal(implementations.get("proof.busy@1.0.0").activeWorkerCount, 0);
            }
          },
        );
        await t.test(
          "retry transient work and crash-after-result reuse are input-bound",
          async () => {
            const original = implementations.get("proof.echo@1.0.0");
            let invocations = 0;
            implementations.set("proof.echo@1.0.0", {
              start(input, context) {
                invocations++;
                if (invocations === 1)
                  return {
                    result: Promise.reject(new Error("transient proof")),
                    cancel: async () => undefined,
                  };
                return original.start(input, context);
              },
            });
            const result = await executor.execute(call);
            assert.equal(result.record.outcome, "succeeded");
            assert.equal(invocations, 2);
            assert.equal((await jobs.listAttempts(result.record.jobId)).length, 2);
            // Redelivery after a committed result must not run implementation again.
            const record = await audit.get(result.record.id);
            const existing = await store.get(record.id);
            assert.equal(existing.inputHash, contentHash(call.input));
            assert.equal((await store.result(record.id)).costMicros, 1);
            await assert.rejects(store.put({ ...existing, input: { text: "tamper" } }), /mismatch/);
            implementations.set("proof.echo@1.0.0", original);
          },
        );
        await t.test(
          "committed result survives pre-ack failure without repeating implementation",
          async () => {
            const original = implementations.get("proof.echo@1.0.0");
            let executed = 0,
              fail = true;
            implementations.set("proof.echo@1.0.0", {
              start(input, context) {
                executed++;
                return original.start(input, context);
              },
            });
            const originalSupervisor = deps.supervisor;
            deps.supervisor = {
              async run(envelope, handler, signal) {
                await originalSupervisor.run(envelope, handler, signal);
                if (fail) {
                  fail = false;
                  throw new Error("crash before acknowledgement");
                }
              },
            };
            try {
              const result = await executor.execute(call);
              assert.equal(result.record.outcome, "succeeded");
              assert.equal(executed, 1);
              assert.equal((await jobs.listAttempts(result.record.jobId)).length, 2);
            } finally {
              deps.supervisor = originalSupervisor;
              implementations.set("proof.echo@1.0.0", original);
            }
          },
        );
        await t.test(
          "output failure and resource-scoped permissions remain fail-closed",
          async () => {
            const original = implementations.get("proof.echo@1.0.0");
            implementations.set("proof.echo@1.0.0", {
              start() {
                return {
                  result: Promise.resolve({ output: { text: 1 }, costMicros: 1 }),
                  cancel: async () => undefined,
                };
              },
            });
            await assert.rejects(executor.execute(call), /invalid_output/);
            implementations.set("proof.echo@1.0.0", original);
            await assert.rejects(
              authority.authorize({ ...call, resource: { kind: "asset", id: newId() } }, [
                "asset.read",
              ]),
              /denied/,
            );
          },
        );
        await t.test(
          "concurrent project budget admits only one held maximum reservation",
          async () => {
            const fresh = newId();
            await pool.query(
              "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'fresh',0,0)",
              [fresh],
            );
            await pool.query("INSERT INTO project_memberships VALUES ($1,$2,'owner',0)", [
              fresh,
              owner,
            ]);
            const limited = new PostgresToolAuditRepository(pool, 10);
            const ex = new ToolExecutor(
              registry,
              authority,
              limited,
              new QueueToolDispatcher(
                jobs,
                { enqueue: (i) => enqueueJob(deps, i), cancel: (id) => cancelJob(deps, id) },
                store,
                limited,
              ),
            );
            consuming = false;
            const request = { ...call, projectId: fresh, resource: { kind: "project", id: fresh } };
            const attempts = [ex.execute(request), ex.execute(request)];
            const resultsPromise = Promise.allSettled(attempts);
            for (let i = 0; i < 100; i++) {
              const rows = await ex.records(owner, fresh);
              if (rows.some((r) => r.outcome === "rejected")) break;
              await delay(10);
            }
            const rows = await ex.records(owner, fresh);
            assert.equal(rows.filter((r) => r.outcome === "rejected").length, 1);
            assert.equal(rows.filter((r) => r.outcome === "running").length, 1);
            consuming = true;
            const results = await resultsPromise;
            assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          },
        );
        await t.test(
          "QA49 F2 coordinator SIGKILL at queued/running/result/completed/failure/cancellation stages reconciles exactly once",
          async () => {
            const childSet = new Set();
            const startChild = (config) => {
              const child = fork(
                path.join(root, "tests/integration/support/tool-coordinator.cjs"),
                [],
                {
                  stdio: ["ignore", "ignore", "ignore", "ipc"],
                  env: {
                    PATH: process.env.PATH,
                    DATABASE_URL: process.env.DATABASE_URL ?? pg.url,
                    REDIS_URL: process.env.REDIS_URL ?? redis.url,
                    TOOL_TEST_SCHEMA: namespace,
                  },
                },
              );
              childSet.add(child);
              const messages = [];
              child.on("message", (m) => messages.push(m));
              child.send(config);
              return { child, messages };
            };
            const waitUntil = async (predicate) => {
              for (let i = 0; i < 600; i++) {
                if (await predicate()) return;
                await delay(10);
              }
              assert.fail("real crash stage not reached");
            };
            const kill = async (child) => {
              const ended = new Promise((resolve) =>
                child.once("exit", (_code, signal) => resolve(signal)),
              );
              child.kill("SIGKILL");
              assert.equal(await ended, "SIGKILL");
              childSet.delete(child);
            };
            const recoveredRows = [];
            try {
              for (const stage of [
                "queued",
                "running-timeout",
                "result-before-ack",
                "completed-before-finish",
                "settlement-transaction",
                "completed-missing-result",
                "completed-corrupt-result",
                "failed-with-receipt",
                "failed-before-finish",
                "cancelled-before-finish",
                "timeout-before-finish",
              ]) {
                consuming = stage !== "queued" && stage !== "cancelled-before-finish";
                const name =
                  stage === "running-timeout" || stage === "timeout-before-finish"
                    ? "proof.busy"
                    : "proof.echo";
                const selected = registry.lookup(name, "1.0.0").manifest;
                const originalImpl = implementations.get("proof.echo@1.0.0"),
                  originalSupervisor = deps.supervisor;
                let releaseGate;
                if (stage === "result-before-ack")
                  deps.supervisor = {
                    run: async (...args) => {
                      await originalSupervisor.run(...args);
                      await new Promise((resolve) => (releaseGate = resolve));
                    },
                  };
                if (stage === "failed-with-receipt")
                  deps.supervisor = {
                    run: async (...args) => {
                      await originalSupervisor.run(...args);
                      throw new PermanentJobError("execution_failed");
                    },
                  };
                if (stage === "failed-before-finish")
                  implementations.set("proof.echo@1.0.0", {
                    start() {
                      return {
                        result: Promise.resolve({ output: { text: 1 }, costMicros: 1 }),
                        cancel: async () => undefined,
                      };
                    },
                  });
                const spawned = startChild({
                  mode: "execute",
                  manifest: selected,
                  call: { ...call, name },
                  pauseEnqueue: stage === "queued",
                  pauseTransaction: stage === "settlement-transaction",
                });
                let id;
                try {
                  await waitUntil(() => spawned.messages.some((m) => m.stage === "queued"));
                  id = spawned.messages.find((m) => m.stage === "queued").id;
                  if (stage === "running-timeout")
                    await waitUntil(
                      async () =>
                        (await jobs.findById(id)).status === "Running" &&
                        implementations.get("proof.busy@1.0.0").activeWorkerCount === 1,
                    );
                  else if (stage === "result-before-ack")
                    await waitUntil(async () => !!(await store.result(id)) && !!releaseGate);
                  else if (stage === "cancelled-before-finish") {
                    await cancelJob(deps, id);
                    await waitUntil(() =>
                      spawned.messages.some((m) => m.stage === "before-finish"),
                    );
                  } else if (stage !== "queued")
                    await waitUntil(() =>
                      spawned.messages.some((m) => m.stage === "before-finish"),
                    );
                  await kill(spawned.child);
                  const abandoned = await audit.get(id);
                  assert.equal(abandoned.outcome, "running");
                  assert.equal(abandoned.durationMs, null);
                  assert.equal(abandoned.costMicros, 10);
                  if (stage === "queued") {
                    assert.equal((await jobs.findById(id)).status, "Queued");
                    assert.deepEqual(await executor.recover(), []);
                    consuming = true;
                  }
                  releaseGate?.();
                  await waitUntil(async () =>
                    ["Completed", "Failed", "Cancelled"].includes((await jobs.findById(id)).status),
                  );
                  if (stage === "completed-missing-result")
                    await pool.query(
                      "UPDATE tool_remote_calls SET result=NULL WHERE execution_id=$1",
                      [id],
                    );
                  if (stage === "completed-corrupt-result")
                    await pool.query(
                      "UPDATE tool_remote_calls SET result=$2::jsonb WHERE execution_id=$1",
                      [id, JSON.stringify({ output: { text: 123 }, costMicros: 1 })],
                    );
                  if (stage === "completed-before-finish") {
                    const unavailable = new QueueToolDispatcher(
                      jobs,
                      { enqueue: (i) => enqueueJob(deps, i), cancel: (id) => cancelJob(deps, id) },
                      {
                        put: (c) => store.put(c),
                        get: (id) => store.get(id),
                        complete: (id, r) => store.complete(id, r),
                        result: async () => {
                          throw new Error("SECRET transient database path");
                        },
                      },
                      audit,
                    );
                    await assert.rejects(
                      new ToolExecutor(registry, authority, audit, unavailable).recover(),
                      /audit_recovery_failed/,
                    );
                    assert.equal((await audit.get(id)).outcome, "running");
                  }
                  const expected = stage.includes("timeout")
                    ? "timed_out"
                    : stage.includes("failed") ||
                        stage === "completed-missing-result" ||
                        stage === "completed-corrupt-result"
                      ? "failed"
                      : stage.includes("cancelled")
                        ? "cancelled"
                        : "succeeded";
                  // A fresh OS coordinator recovers from real PG/Redis state; parent does not finalize it.
                  const restarts = [
                    startChild({ mode: "recover-concurrent", manifest: selected }),
                    startChild({ mode: "recover-concurrent", manifest: selected }),
                  ];
                  await waitUntil(() =>
                    restarts.every((r) => r.messages.some((m) => m.stage === "settlement-ready")),
                  );
                  const ended = restarts.map(
                    (r) => new Promise((resolve) => r.child.once("exit", resolve)),
                  );
                  for (const restart of restarts) restart.child.send({ release: true });
                  await waitUntil(() =>
                    restarts.every((r) => r.messages.some((m) => m.stage === "recovered")),
                  );
                  await Promise.all(ended);
                  for (const restart of restarts) childSet.delete(restart.child);
                  const row = await audit.get(id),
                    job = await jobs.findById(id);
                  assert.equal(row.outcome, expected);
                  assert.equal(row.finishedAtMs, Number(job.updatedAt));
                  assert.equal(row.durationMs, row.finishedAtMs - row.startedAtMs);
                  assert.equal(
                    row.costMicros,
                    expected === "succeeded" || stage === "failed-with-receipt" ? 1 : 10,
                  );
                  assert.equal(
                    row.costBasis,
                    expected === "succeeded" || stage === "failed-with-receipt"
                      ? "actual"
                      : "reserved",
                  );
                  assert.equal(row.cleanupStatus, "succeeded");
                  const sumBefore = (
                    await pool.query(
                      "SELECT sum(cost_micros)::text AS n FROM tool_cost_reservations",
                    )
                  ).rows[0].n;
                  await Promise.all([
                    executor.recover(),
                    new ToolExecutor(registry, authority, audit, dispatcher).recover(),
                    executor.recover(),
                  ]);
                  assert.deepEqual(await audit.get(id), row);
                  assert.equal(
                    (
                      await pool.query(
                        "SELECT sum(cost_micros)::text AS n FROM tool_cost_reservations",
                      )
                    ).rows[0].n,
                    sumBefore,
                  );
                  assert.equal(
                    (await jobs.listAttempts(id)).filter((a) => a.status === "Completed").length,
                    job.status === "Completed" ? 1 : 0,
                  );
                  assert.equal(implementations.get("proof.busy@1.0.0").activeWorkerCount, 0);
                  recoveredRows.push({
                    stage,
                    outcome: row.outcome,
                    cost: row.costMicros,
                    duration: row.durationMs,
                  });
                } finally {
                  releaseGate?.();
                  deps.supervisor = originalSupervisor;
                  implementations.set("proof.echo@1.0.0", originalImpl);
                }
              }
            } finally {
              for (const child of childSet) child.kill("SIGKILL");
              consuming = true;
            }
            t.diagnostic(JSON.stringify({ coordinatorSigkillRecovery: recoveredRows }));
          },
        );
        await t.test(
          "QA49 F3 actual isolated Worker cleanup escalation and sanitized combined failure finalize audits",
          async () => {
            const original = implementations.get("proof.busy@1.0.0");
            let escalated = 0;
            implementations.set("proof.busy@1.0.0", {
              start(input, context) {
                const run = original.start(input, context);
                return {
                  result: run.result,
                  cancel: async () => {
                    throw new Error("postgres://SECRET@internal/private");
                  },
                  forceStop: async () => {
                    escalated++;
                    await run.cancel();
                  },
                };
              },
            });
            try {
              await assert.rejects(executor.execute({ ...call, name: "proof.busy" }), /timed_out/);
              assert.ok(escalated > 0);
              assert.equal(original.activeWorkerCount, 0);
            } finally {
              implementations.set("proof.busy@1.0.0", original);
            }
            const echo = implementations.get("proof.echo@1.0.0");
            implementations.set("proof.echo@1.0.0", {
              start(input, context) {
                const run = echo.start(input, context);
                return {
                  result: run.result.then(() => ({ output: { text: 123 }, costMicros: 1 })),
                  cancel: async () => {
                    await run.cancel();
                    throw new Error("SECRET /private/path");
                  },
                };
              },
            });
            let error;
            try {
              await executor.execute(call);
              assert.fail("invalid output passed");
            } catch (e) {
              error = e;
            } finally {
              implementations.set("proof.echo@1.0.0", echo);
            }
            assert.match(error.message, /invalid_output/);
            assert.ok(!error.stack.includes("SECRET"));
            const failed = (await executor.records(owner, project)).find(
              (r) => r.cleanupStatus === "failed",
            );
            assert.ok(failed);
            assert.equal(failed.outcome, "failed");
            assert.equal(failed.code, "invalid_output");
            assert.equal(failed.cleanupCode, "cleanup_unconfirmed");
            assert.ok(failed.durationMs !== null);
            assert.equal((await jobs.findById(failed.jobId)).failureReason, "invalid_output");
            assert.equal(await store.result(failed.id), null);
            assert.equal(echo.activeWorkerCount, 0);
            assert.ok(!JSON.stringify(await executor.records(owner, project)).includes("SECRET"));
          },
        );
        await t.test(
          "QA49 F4 same authenticated session loses record/list access immediately on membership revocation",
          async () => {
            const result = await executor.execute(call);
            await pool.query(
              "UPDATE project_memberships SET role='editor' WHERE project_id=$1 AND user_id=$2",
              [project, owner],
            );
            assert.equal((await executor.record(owner, result.record.id)).outcome, "succeeded");
            await pool.query(
              "UPDATE project_memberships SET role='viewer' WHERE project_id=$1 AND user_id=$2",
              [project, owner],
            );
            assert.equal((await executor.record(owner, result.record.id)).outcome, "succeeded");
            await assert.rejects(executor.execute(call), /denied/);
            await pool.query("DELETE FROM project_memberships WHERE project_id=$1 AND user_id=$2", [
              project,
              owner,
            ]);
            await assert.rejects(executor.record(owner, result.record.id), /denied/);
            for (const limit of [1, 50, 100])
              await assert.rejects(executor.records(owner, project, limit), /denied/);
            await assert.rejects(executor.record(outsider, result.record.id), /denied/);
            await pool.query(
              "INSERT INTO project_memberships VALUES ($1,$2,'owner',0),($3,$4,'owner',0)",
              [project, owner, otherProject, outsider],
            );
            await assert.rejects(executor.record(outsider, result.record.id), /denied/);
            assert.equal((await executor.record(owner, result.record.id)).outcome, "succeeded");
            assert.equal((await audit.get(result.record.id)).outcome, "succeeded");
          },
        );
        await t.test(
          "same real adapter dispatches explicit ai and render worker targets",
          async () => {
            for (const target of ["ai", "render"]) {
              const name = `proof.echo-${target}`;
              registry.register({ ...base, id: newId(), name }, { mode: "remote", target });
              const impl = new Map([
                [
                  `${name}@1.0.0`,
                  new IsolatedTool(
                    path.join(root, "tests/integration/support/tool-operations.cjs"),
                    "echo",
                  ),
                ],
              ]);
              const targetConsumer = new RemoteToolConsumer(
                registry,
                authority,
                store,
                audit,
                queue,
                impl,
                target,
              );
              const targetDeps = {
                ...deps,
                supervisor: new RemoteToolSupervisor(
                  targetConsumer,
                  (code) => new PermanentJobError(code),
                  () => new JobCancelledError(),
                ),
              };
              const targetDispatcher = new QueueToolDispatcher(
                jobs,
                {
                  enqueue: (i) => enqueueJob(targetDeps, i),
                  cancel: (id) => cancelJob(targetDeps, id),
                },
                store,
                audit,
              );
              activeQueue = `tools-${target}-v1`;
              activeDeps = targetDeps;
              const result = await new ToolExecutor(
                registry,
                authority,
                audit,
                targetDispatcher,
              ).execute({ ...call, name });
              assert.deepEqual(result.output, call.input);
              assert.equal((await jobs.findById(result.record.jobId)).queueName, activeQueue);
            }
          },
        );
        t.diagnostic(
          JSON.stringify({
            realRemoteJobs: (await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
            progressEvents: seen.filter((e) => e.kind === "progress").length,
            auditRows: (await pool.query("SELECT count(*)::int AS n FROM tool_executions")).rows[0]
              .n,
            targets: ["media", "ai", "render"],
          }),
        );
      } finally {
        stopped = true;
        await worker;
      }
    } finally {
      await subscription?.close();
      await subscriber?.close();
      await queue?.close();
      await events?.close();
      await pool?.end();
      if (bootstrap) {
        await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
        await bootstrap.end();
      }
      await redis?.close();
      await pg?.close();
    }
  },
);
