import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Pool } from "pg";
import { createUuidV7, instant, Job, jobId, projectId } from "../../packages/domain/dist/index.js";
import {
  ToolRegistry,
  ToolExecutor,
  ToolError,
  PostgresToolAuthority,
  PostgresToolAuditRepository,
  PostgresRemoteCallStore,
  QueueToolDispatcher,
  RemoteToolConsumer,
  RemoteToolSupervisor,
  IsolatedTool,
} from "../../packages/tool-sdk/dist/index.js";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  enqueueJob,
  cancelJob,
  runNextJob,
  PermanentJobError,
  JobCancelledError,
  RedisJobEventPublisher,
} from "../../packages/job-queue/dist/index.js";
import { startPostgres, startRedis } from "./support/containers.mjs";
const root = path.resolve(import.meta.dirname, "../..");
const id = () => createUuidV7(Date.now(), randomBytes(10));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, label) => {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(`Fault-injection handshake not reached: ${label}`);
};
const docker = promisify(execFile);

// Provisioning patched infrastructure images is a prerequisite, not execution time.
// Keep every fault/assertion deadline unchanged once actual dependencies are ready.
let pg, redis;
before(
  async () => {
    try {
      pg = await startPostgres();
      redis = await startRedis();
    } catch (error) {
      await Promise.allSettled([pg?.close(), redis?.close()]);
      throw error;
    }
  },
  { timeout: 300000 },
);
after(async () => {
  const closed = await Promise.allSettled([pg?.close(), redis?.close()]);
  const failed = closed.filter((result) => result.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      "Fault-test infrastructure cleanup failed",
    );
});

test(
  "QA49 F5/F6/F7 real durable publication, deadline and cleanup faults",
  { timeout: 90000 },
  async (t) => {
    let pool,
      bootstrap,
      queue,
      events,
      paused = false,
      pumping = false,
      pump;
    const children = new Set();
    const namespace = `publication_${randomUUID().replaceAll("-", "")}`;
    try {
      // Dedicated Redis: pausing it cannot interrupt other concurrently running suites.
      bootstrap = new Pool({ connectionString: pg.url });
      await bootstrap.query(`CREATE SCHEMA ${namespace}`);
      pool = new Pool({
        connectionString: pg.url,
        options: `-c search_path=${namespace}`,
        connectionTimeoutMillis: 1000,
        statement_timeout: 2000,
        max: 8,
      });
      for (const file of (await readdir(path.join(root, "apps/api/migrations")))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      const owner = id(),
        project = id();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES ($1,'recovery@example.com','$argon2id$test',0,0)",
        [owner],
      );
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'recovery',0,0)",
        [project],
      );
      await pool.query("INSERT INTO project_memberships VALUES ($1,$2,'owner',0)", [
        project,
        owner,
      ]);
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", maxLength: 128 } },
      };
      const base = {
        schemaVersion: 1,
        id: id(),
        name: "proof.echo",
        version: "1.0.0",
        description: "Recovery proof",
        inputSchema: schema,
        outputSchema: schema,
        permissions: ["project.read"],
        capabilities: ["audio"],
        estimatedCostMicros: 1,
        maximumCostMicros: 10,
        timeoutMs: 20000,
        mutating: false,
        validationRules: [],
      };
      const registry = new ToolRegistry();
      registry.register(base, { mode: "remote", target: "media" });
      const short = { ...base, id: id(), name: "proof.deadline", timeoutMs: 2000 };
      registry.register(short, { mode: "remote", target: "media" });
      const audit = new PostgresToolAuditRepository(pool, 10000),
        calls = new PostgresRemoteCallStore(pool),
        jobs = new PostgresJobRepository(pool);
      const authority = new PostgresToolAuthority(pool, async () => {
        throw new ToolError("missing_timeline");
      });
      events = new RedisJobEventPublisher(pool, redis.url);
      queue = new BullMqJobQueue(redis.url, {
        events,
        lockDurationMs: 2000,
        stalledIntervalMs: 200,
      });
      const actual = new IsolatedTool(
        path.join(root, "tests/integration/support/tool-operations.cjs"),
        "echo",
      );
      let sideEffects = 0;
      const echo = {
        start(input, context) {
          sideEffects++;
          return actual.start(input, context);
        },
      };
      const implementations = new Map([
        ["proof.echo@1.0.0", echo],
        ["proof.deadline@1.0.0", echo],
      ]);
      const consumer = new RemoteToolConsumer(
        registry,
        authority,
        calls,
        audit,
        queue,
        implementations,
        "media",
      );
      const deps = {
        jobs,
        queue,
        supervisor: new RemoteToolSupervisor(
          consumer,
          (code) => new PermanentJobError(code),
          () => new JobCancelledError(),
        ),
        now: () => instant(BigInt(Date.now())),
        newAttemptId: id,
      };
      const lifecycle = {
        enqueue: (input) => enqueueJob(deps, input),
        cancel: (job) => cancelJob(deps, job),
      };
      const dispatcher = new QueueToolDispatcher(jobs, lifecycle, calls, audit);
      const executor = new ToolExecutor(registry, authority, audit, dispatcher);
      const call = {
        name: base.name,
        version: base.version,
        callerId: owner,
        projectId: project,
        resource: { kind: "project", id: project },
        input: { text: "مرحبا 👩‍💻" },
      };
      const spawn = (config) => {
        const child = fork(path.join(root, "tests/integration/support/tool-coordinator.cjs"), [], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            PATH: process.env.PATH,
            DATABASE_URL: pg.url,
            REDIS_URL: redis.url,
            TOOL_TEST_SCHEMA: namespace,
          },
        });
        children.add(child);
        const messages = [];
        child.on("message", (m) => messages.push(m));
        const ended = new Promise((resolve) =>
          child.once("exit", (code, signal) => {
            children.delete(child);
            resolve({ code, signal });
          }),
        );
        child.send(config);
        return { child, messages, ended };
      };
      const startPump = () => {
        pumping = true;
        pump = (async () => {
          while (pumping) {
            await runNextJob(deps, "tools-media-v1", {
              modulePath: "registered",
              exportName: "fixed",
            });
            await delay(10);
          }
        })().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      };
      await t.test("publication triggers preserve canonical non-Tool job lifecycle", async () => {
        const job = Job.create(
          jobId(id()),
          { kind: "project", projectId: projectId(project) },
          instant(BigInt(Date.now())),
          {
            queueName: "media-inspect-v1",
            jobType: "media.inspect",
            idempotencyKey: `non-tool:${id()}`,
            payload: {},
            timeoutMs: 2000,
            maxAttempts: 1,
          },
        );
        await jobs.save(job);
        assert.equal(
          (await pool.query("SELECT job_id FROM tool_job_publications WHERE job_id=$1", [job.id]))
            .rowCount,
          0,
        );
        const completed = job
          .start(instant(job.createdAt + 1n))
          .complete(instant(job.createdAt + 2n));
        await jobs.save(completed);
        assert.equal((await jobs.findById(job.id)).status, "Completed");
      });
      await t.test(
        "F5 SIGKILL after atomic PG commit before Redis publish, concurrent fresh restart convergence",
        async () => {
          for (let repetition = 0; repetition < 3; repetition++) {
            const child = spawn({ mode: "execute", manifest: base, call, pausePublication: true });
            await until(
              () => child.messages.some((m) => m.stage === "postgres-commit-before-redis"),
              "PG commit",
            );
            const jobId = child.messages.find((m) => m.stage === "postgres-commit-before-redis").id;
            assert.equal((await jobs.findById(jobId)).status, "Queued");
            assert.equal((await audit.get(jobId)).outcome, "running");
            assert.equal(
              (
                await pool.query("SELECT published FROM tool_job_publications WHERE job_id=$1", [
                  jobId,
                ])
              ).rows[0].published,
              false,
            );
            child.child.kill("SIGKILL");
            assert.equal((await child.ended).signal, "SIGKILL");
            if (repetition === 1) {
              const leased = spawn({ mode: "recover", manifest: base, pausePublication: true });
              await until(
                () => leased.messages.some((m) => m.stage === "postgres-commit-before-redis"),
                "leased publication",
              );
              leased.child.kill("SIGKILL");
              assert.equal((await leased.ended).signal, "SIGKILL");
              await until(
                async () =>
                  (
                    await pool.query(
                      "SELECT lease_until_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint AS expired FROM tool_job_publications WHERE job_id=$1",
                      [jobId],
                    )
                  ).rows[0].expired,
                "expired publisher lease",
              );
            }
            const before = sideEffects;
            const restarts = [
              spawn({ mode: "recover", manifest: base }),
              spawn({ mode: "recover", manifest: base }),
            ];
            await Promise.all(restarts.map((r) => r.ended));
            for (const r of restarts) assert.ok(r.messages.some((m) => m.stage === "recovered"));
            assert.equal(
              await runNextJob(deps, "tools-media-v1", {
                modulePath: "registered",
                exportName: "fixed",
              }),
              "done",
            );
            const final = spawn({ mode: "recover", manifest: base });
            await final.ended;
            assert.equal((await jobs.findById(jobId)).status, "Completed");
            const record = await audit.get(jobId);
            assert.equal(record.outcome, "succeeded");
            assert.equal(record.costMicros, 1);
            assert.equal(sideEffects, before + 1);
            assert.equal((await jobs.listAttempts(jobId)).length, 1);
            await Promise.all([executor.recover(), executor.recover(), executor.recover()]);
            assert.deepEqual(await audit.get(jobId), record);
            assert.equal(
              await runNextJob(deps, "tools-media-v1", {
                modulePath: "registered",
                exportName: "fixed",
              }),
              "idle",
            );
            t.diagnostic(
              JSON.stringify({
                stage: "commit-before-publication-SIGKILL",
                repetition,
                jobId,
                outcome: record.outcome,
                attempts: 1,
                effects: 1,
                settledCost: 1,
              }),
            );
          }
        },
      );
      await t.test(
        "F7 paused Redis cannot hold 2000ms admission; cancellation and late publication are fenced",
        async () => {
          // Warm BullMQ connections before pausing the real server process.
          await queue.reserve("tools-media-v1");
          const before = sideEffects;
          for (const mode of ["timeout", "cancel", "timeout"]) {
            await docker("docker", ["pause", redis.container.getId()]);
            paused = true;
            const abort = new globalThis.AbortController(),
              started = performance.now();
            const execution = executor.execute({ ...call, name: short.name }, abort.signal);
            const settled = execution.then(
              () => assert.fail("paused admission completed"),
              (e) => e,
            );
            await until(
              async () =>
                (await pool.query("SELECT id FROM jobs WHERE status='Queued'")).rowCount === 1,
              "durable queued job",
            );
            const jobId = (await pool.query("SELECT id FROM jobs WHERE status='Queued'")).rows[0]
              .id;
            if (mode === "cancel") {
              abort.abort();
              abort.abort();
            }
            const error = await settled,
              elapsedMs = performance.now() - started;
            assert.equal(error.code, mode === "cancel" ? "cancelled" : "timed_out");
            assert.ok(elapsedMs < 3500, `deadline plus bounded PG settlement: ${elapsedMs}`);
            assert.equal((await jobs.findById(jobId)).status, "Cancelled");
            const record = await audit.get(jobId);
            assert.equal(record.outcome, mode === "cancel" ? "cancelled" : "timed_out");
            assert.equal(record.cleanupStatus, "not_required");
            await docker("docker", ["unpause", redis.container.getId()]);
            paused = false;
            // Wait for actual late Redis publication acknowledgment, never an arbitrary sleep.
            await until(
              async () =>
                (
                  await pool.query("SELECT published FROM tool_job_publications WHERE job_id=$1", [
                    jobId,
                  ])
                ).rows[0].published,
              "late publication acknowledgment",
            );
            await runNextJob(deps, "tools-media-v1", {
              modulePath: "registered",
              exportName: "fixed",
            });
            assert.equal((await jobs.findById(jobId)).status, "Cancelled");
            assert.equal(await calls.result(jobId), null);
            assert.equal(sideEffects, before);
            await Promise.all([executor.recover(), executor.recover()]);
            assert.deepEqual(await audit.get(jobId), record);
            assert.equal((await jobs.listAttempts(jobId)).length, 0);
            t.diagnostic(
              JSON.stringify({
                mode,
                elapsedMs,
                declaredDeadlineMs: 2000,
                jobId,
                terminal: record.outcome,
                lateEffects: 0,
              }),
            );
          }
        },
      );
      await t.test(
        "F5 Redis outage with live coordinator then reconnect republishes without duplicate effects",
        async () => {
          const before = sideEffects;
          await docker("docker", ["pause", redis.container.getId()]);
          paused = true;
          const outcome = executor.execute(call);
          await until(
            async () =>
              (await pool.query("SELECT id FROM jobs WHERE status='Queued'")).rowCount === 1,
            "outage admission",
          );
          const jobId = (await pool.query("SELECT id FROM jobs WHERE status='Queued'")).rows[0].id;
          await docker("docker", ["unpause", redis.container.getId()]);
          paused = false;
          await until(
            async () =>
              (
                await pool.query("SELECT published FROM tool_job_publications WHERE job_id=$1", [
                  jobId,
                ])
              ).rows[0].published,
            "reconnected publication",
          );
          await executor.recover();
          await runNextJob(deps, "tools-media-v1", {
            modulePath: "registered",
            exportName: "fixed",
          });
          assert.equal((await outcome).record.outcome, "succeeded");
          assert.equal(sideEffects, before + 1);
          assert.equal((await jobs.listAttempts(jobId)).length, 1);
        },
      );
      await t.test(
        "F5 unpublished job expires after crash and fresh restart without side effects",
        async () => {
          const child = spawn({
            mode: "execute",
            manifest: short,
            call: { ...call, name: short.name },
            pausePublication: true,
          });
          await until(
            () => child.messages.some((m) => m.stage === "postgres-commit-before-redis"),
            "expiring commit",
          );
          const jobId = child.messages.find((m) => m.stage === "postgres-commit-before-redis").id;
          child.child.kill("SIGKILL");
          assert.equal((await child.ended).signal, "SIGKILL");
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT deadline_at_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint AS expired FROM tool_job_publications WHERE job_id=$1",
                  [jobId],
                )
              ).rows[0].expired,
            "expired unpublished deadline",
          );
          const before = sideEffects;
          const restarted = spawn({ mode: "recover", manifest: short });
          await restarted.ended;
          const record = await audit.get(jobId);
          assert.equal(record.outcome, "timed_out");
          assert.equal((await jobs.findById(jobId)).status, "Cancelled");
          assert.equal(record.cleanupStatus, "not_required");
          assert.equal(sideEffects, before);
          await executor.recover();
          assert.deepEqual(await audit.get(jobId), record);
        },
      );
      await t.test(
        "F7 queue wait and active non-cooperative worker share deadline despite paused Redis",
        async () => {
          const before = sideEffects,
            started = performance.now();
          const queued = executor.execute({ ...call, name: short.name }).then(
            () => assert.fail("queue wait exceeded deadline"),
            (e) => e,
          );
          const error = await queued;
          assert.equal(error.code, "timed_out");
          assert.ok(performance.now() - started < 3500);
          assert.equal(sideEffects, before);
          await runNextJob(deps, "tools-media-v1", {
            modulePath: "registered",
            exportName: "fixed",
          });
          const busy = new IsolatedTool(
            path.join(root, "tests/integration/support/tool-operations.cjs"),
            "busy",
          );
          implementations.set("proof.deadline@1.0.0", busy);
          try {
            for (const mode of ["timeout", "cancel"]) {
              const abort = new globalThis.AbortController(),
                begin = performance.now();
              const execution = executor.execute({ ...call, name: short.name }, abort.signal).then(
                () => assert.fail("busy worker succeeded"),
                (e) => e,
              );
              await until(
                async () =>
                  (
                    await pool.query(
                      "SELECT published FROM tool_job_publications p JOIN jobs j ON j.id=p.job_id WHERE j.status='Queued' AND p.published",
                    )
                  ).rowCount === 1,
                "busy publication",
              );
              const targetJobId = (await pool.query("SELECT id FROM jobs WHERE status='Queued'"))
                .rows[0].id;
              // A prior paused attempt may still need its terminal Redis acknowledgment. Run the
              // normal consumer loop until THIS job settles, rather than assuming the next receipt is it.
              const work = (async () => {
                while (
                  !["Completed", "Failed", "Cancelled"].includes(
                    (await jobs.findById(targetJobId)).status,
                  )
                ) {
                  await runNextJob(deps, "tools-media-v1", {
                    modulePath: "registered",
                    exportName: "fixed",
                  });
                  await delay(10);
                }
              })().then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
              await until(() => busy.activeWorkerCount === 1, "actual non-cooperative Worker");
              await docker("docker", ["pause", redis.container.getId()]);
              paused = true;
              if (mode === "cancel") {
                abort.abort();
                abort.abort();
              }
              const result = await execution;
              assert.equal(result.code, mode === "cancel" ? "cancelled" : "timed_out");
              assert.ok(performance.now() - begin < 3500);
              assert.equal(busy.activeWorkerCount, 0);
              await docker("docker", ["unpause", redis.container.getId()]);
              paused = false;
              assert.equal((await work).error, undefined);
              assert.equal(
                (await audit.get(targetJobId)).outcome,
                mode === "cancel" ? "cancelled" : "timed_out",
              );
              assert.equal(await calls.result(targetJobId), null);
              t.diagnostic(
                JSON.stringify({
                  stage: "active-worker-Redis-paused",
                  mode,
                  elapsedMs: performance.now() - begin,
                  workers: busy.activeWorkerCount,
                }),
              );
            }
          } finally {
            implementations.set("proof.deadline@1.0.0", echo);
          }
        },
      );
      await t.test(
        "F6 actual SQL cleanup-note rejection preserves invalid_output and one permanent attempt",
        async () => {
          await pool.query(`CREATE FUNCTION reject_cleanup_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.outcome=OLD.outcome AND NEW.cleanup_status='failed' THEN RAISE EXCEPTION 'SECRET postgres://private/internal'; END IF;
        RETURN NEW; END $$; CREATE TRIGGER reject_cleanup_note BEFORE UPDATE ON tool_executions FOR EACH ROW EXECUTE FUNCTION reject_cleanup_note()`);
          const original = implementations.get("proof.echo@1.0.0");
          implementations.set("proof.echo@1.0.0", {
            start(input, context) {
              const run = original.start(input, context);
              return {
                result: run.result.then(() => ({ output: { text: 42 }, costMicros: 1 })),
                cancel: async () => {
                  await run.cancel();
                  throw new Error("SECRET postgres://private/internal");
                },
              };
            },
          });
          startPump();
          try {
            const error = await executor.execute(call).then(
              () => assert.fail("invalid output accepted"),
              (e) => e,
            );
            assert.equal(error.code, "invalid_output");
            assert.ok(!error.stack.includes("SECRET"));
            const record = (await audit.list(project, 100)).find(
              (r) => r.code === "invalid_output",
            );
            assert.ok(record);
            assert.equal(record.outcome, "failed");
            assert.equal(record.cleanupStatus, "failed");
            assert.equal((await jobs.findById(record.jobId)).failureReason, "invalid_output");
            assert.equal((await jobs.listAttempts(record.jobId)).length, 1);
            assert.equal(await calls.result(record.id), null);
            assert.equal(actual.activeWorkerCount, 0);
            await Promise.all([executor.recover(), executor.recover()]);
            assert.deepEqual(await audit.get(record.id), record);
            t.diagnostic(
              JSON.stringify({
                code: record.code,
                cleanupStatus: record.cleanupStatus,
                attempts: 1,
                workers: actual.activeWorkerCount,
              }),
            );
          } finally {
            implementations.set("proof.echo@1.0.0", original);
            await pool.query(
              "DROP TRIGGER reject_cleanup_note ON tool_executions; DROP FUNCTION reject_cleanup_note()",
            );
          }
        },
      );
      await t.test(
        "F6 missing cleanup receipt is unconfirmed and reconciles only from acknowledged durable fact",
        async () => {
          await pool.query(`CREATE FUNCTION reject_cleanup_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF OLD.cleanup_status='unconfirmed' AND NEW.cleanup_status='succeeded' THEN RAISE EXCEPTION 'SECRET cleanup unavailable'; END IF;
        RETURN NEW; END $$; CREATE TRIGGER reject_cleanup_receipt BEFORE UPDATE ON tool_remote_calls FOR EACH ROW EXECUTE FUNCTION reject_cleanup_receipt()`);
          try {
            const error = await executor.execute(call).then(
              () => assert.fail("unacknowledged cleanup accepted"),
              (e) => e,
            );
            assert.equal(error.code, "cleanup_unconfirmed");
            assert.ok(!error.stack.includes("SECRET"));
            const record = (await audit.list(project, 100)).find(
              (r) => r.cleanupStatus === "unconfirmed",
            );
            assert.ok(record);
            assert.equal(record.outcome, "failed");
            assert.equal((await jobs.listAttempts(record.id)).length, 1);
            assert.equal(actual.activeWorkerCount, 0);
            await executor.recover();
            assert.equal((await audit.get(record.id)).cleanupStatus, "unconfirmed");
            await pool.query(
              "DROP TRIGGER reject_cleanup_receipt ON tool_remote_calls; DROP FUNCTION reject_cleanup_receipt()",
            );
            // Fault harness observes the actual owned Worker is gone; only then writes the independent receipt.
            await calls.noteCleanup(record.id, "succeeded");
            await Promise.all([executor.recover(), executor.recover(), executor.recover()]);
            const reconciled = await audit.get(record.id);
            assert.equal(reconciled.cleanupStatus, "succeeded");
            assert.equal(reconciled.code, record.code);
            assert.equal(reconciled.outcome, record.outcome);
            assert.equal(reconciled.costMicros, record.costMicros);
          } finally {
            await pool.query(
              "DROP TRIGGER IF EXISTS reject_cleanup_receipt ON tool_remote_calls; DROP FUNCTION IF EXISTS reject_cleanup_receipt()",
            );
          }
        },
      );
    } finally {
      pumping = false;
      if (paused && redis) await docker("docker", ["unpause", redis.container.getId()]);
      for (const child of children) child.kill("SIGKILL");
      const pumpOutcome = await pump;
      await queue?.close();
      await events?.close();
      await pool?.end();
      if (bootstrap) {
        await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
        await bootstrap.end();
      }
      assert.equal(pumpOutcome?.error, undefined);
    }
  },
);
