import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test, before, after } from "node:test";
import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { createUuidV7, instant, jobId, JobAttempt } from "../../packages/domain/dist/index.js";
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
const until = async (check, label) => {
  const end = performance.now() + 10000;
  while (performance.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Admission handshake not reached: ${label}`);
};
let pg, redis;
before(
  async () => {
    try {
      pg = await startPostgres();
      redis = await startRedis();
    } catch (e) {
      await Promise.allSettled([pg?.close(), redis?.close()]);
      throw e;
    }
  },
  { timeout: 300000 },
);
after(async () => {
  const result = await Promise.allSettled([pg?.close(), redis?.close()]);
  assert.ok(
    result.every((r) => r.status === "fulfilled"),
    "Service cleanup",
  );
});
test(
  "QA49 H1 real admission SIGKILL, full-budget expiry and fenced recovery",
  { timeout: 180000 },
  async (t) => {
    const namespace = `admission_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = new Pool({ connectionString: pg.url });
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const pool = new Pool({
      connectionString: pg.url,
      options: `-c search_path=${namespace}`,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      max: 8,
    });
    const children = new Set();
    const events = new RedisJobEventPublisher(pool, redis.url);
    const queue = new BullMqJobQueue(redis.url, {
      events,
      lockDurationMs: 2000,
      stalledIntervalMs: 200,
    });
    try {
      for (const file of (await readdir(path.join(root, "apps/api/migrations")))
        .filter(
          (f) =>
            f.endsWith(".sql") && (!process.env.TOOL_TEST_BASELINE_SDK || !f.startsWith("0016")),
        )
        .sort())
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      const owner = id(),
        project = id();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES ($1,'admission@example.com','$argon2id$test',0,0)",
        [owner],
      );
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'admission',0,0)",
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
      const manifest = {
        schemaVersion: 1,
        id: id(),
        name: "proof.admission",
        version: "1.0.0",
        description: "Admission proof",
        inputSchema: schema,
        outputSchema: schema,
        permissions: ["project.read"],
        capabilities: ["audio"],
        estimatedCostMicros: 1,
        maximumCostMicros: 10000,
        timeoutMs: 2000,
        mutating: false,
        validationRules: [],
      };
      const registry = new ToolRegistry();
      registry.register(manifest, { mode: "remote", target: "media" });
      const audit = new PostgresToolAuditRepository(pool, 10000),
        calls = new PostgresRemoteCallStore(pool),
        jobs = new PostgresJobRepository(pool);
      const authority = new PostgresToolAuthority(pool, async () => {
        throw new ToolError("invalid_subject");
      });
      const actual = new IsolatedTool(
        path.join(root, "tests/integration/support/tool-operations.cjs"),
        "echo",
      );
      let effects = 0;
      // Real isolated implementation with a zero-cost receipt, keeping full-budget tests independent.
      const implementation = {
        start(input, context) {
          effects++;
          const run = actual.start(input, context);
          return { ...run, result: run.result.then((r) => ({ ...r, costMicros: 0 })) };
        },
      };
      const consumer = new RemoteToolConsumer(
        registry,
        authority,
        calls,
        audit,
        queue,
        new Map([["proof.admission@1.0.0", implementation]]),
        "media",
      );
      const deps = {
        jobs,
        queue,
        supervisor: new RemoteToolSupervisor(
          consumer,
          (c) => new PermanentJobError(c),
          () => new JobCancelledError(),
        ),
        now: () => instant(BigInt(Date.now())),
        newAttemptId: id,
      };
      const dispatcher = new QueueToolDispatcher(
        jobs,
        { enqueue: (i) => enqueueJob(deps, i), cancel: (i) => cancelJob(deps, i) },
        calls,
        audit,
      );
      const executor = new ToolExecutor(registry, authority, audit, dispatcher);
      const call = {
        name: manifest.name,
        version: manifest.version,
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
            ...(process.env.TOOL_TEST_BASELINE_SDK
              ? { TOOL_TEST_BASELINE_SDK: process.env.TOOL_TEST_BASELINE_SDK }
              : {}),
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
        child.send({ manifest, ...config });
        return { child, messages, ended };
      };
      const freshRecover = async () => {
        // Fresh, concurrent coordinators may lose a bounded connection acquisition on
        // a loaded real service. Retry that transport failure only; never mask SQL/rule errors.
        await Promise.all(
          [0, 1].map(async () => {
            let retries = 0;
            for (let attempt = 0; attempt < 3; attempt++) {
              const c = spawn({ mode: "recover" });
              await c.ended;
              if (c.messages.some((m) => m.stage === "recovered")) {
                if (retries) t.diagnostic(JSON.stringify({ recoveryConnectionRetries: retries }));
                return;
              }
              assert.ok(
                c.messages.some(
                  (m) =>
                    m.stage === "recovery-sql-error" && m.category === "connection_unavailable",
                ),
                JSON.stringify(c.messages),
              );
              retries++;
            }
            assert.fail("Fresh recovery did not regain its bounded database connection");
          }),
        );
      };
      const newAuthorizedCall = async () => {
        const before = effects;
        let settled = false;
        const result = executor
          .execute(call)
          .then(
            (value) => ({ value }),
            (error) => ({ error }),
          )
          .finally(() => {
            settled = true;
          });
        // Consume all retained transport receipts, including fenced prior jobs, until this call settles.
        while (!settled) {
          await runNextJob(deps, "tools-media-v1", {
            modulePath: "registered",
            exportName: "fixed",
          });
          await new Promise((r) => setTimeout(r, 10));
        }
        const settledResult = await result;
        if (settledResult.error) throw settledResult.error;
        const execution = settledResult.value;
        assert.equal(execution.record.outcome, "succeeded");
        assert.equal(execution.record.costMicros, 0);
        assert.equal(effects, before + 1);
      };
      const stages = process.env.QA49_H1_REPRO_ONLY
        ? [process.env.QA49_H1_STAGE ?? "after-reserve"]
        : [
            "before-audit",
            "after-audit",
            "before-reserve",
            "after-reserve",
            "after-reserve",
            "before-attach",
            "during-attach",
            "after-attach",
            "startup-recovery",
          ];
      for (const stage of stages)
        await t.test(
          `SIGKILL ${stage}, independent SQL checks and next full-budget call`,
          async () => {
            const child = spawn({ mode: "execute", call, pauseAdmission: stage });
            await until(() => child.messages.some((m) => m.stage === stage), stage);
            const executionId = child.messages.find((m) => m.stage === stage).id;
            const before = effects;
            child.child.kill("SIGKILL");
            assert.equal((await child.ended).signal, "SIGKILL");
            const original = (
              await pool.query("SELECT * FROM tool_executions WHERE id=$1", [executionId])
            ).rows[0];
            if (original) {
              if (stage === "after-reserve") assert.equal(Number(original.cost_micros), 10000);
              // Deadline comes from the declared contract, not a sleep: wait on authoritative SQL clock.
              await until(
                async () =>
                  (
                    await pool.query(
                      "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint >= started_at_ms+2000 AS expired FROM tool_executions WHERE id=$1",
                      [executionId],
                    )
                  ).rows[0].expired,
                "durable expiry",
              );
              await freshRecover();
              if (!process.env.TOOL_TEST_BASELINE_SDK)
                await Promise.all([executor.recover(), executor.recover(), executor.recover()]);
              const row = (
                await pool.query("SELECT * FROM tool_executions WHERE id=$1", [executionId])
              ).rows[0];
              t.diagnostic(
                JSON.stringify({
                  phase: "independent_SQL",
                  stage,
                  outcome: row.outcome,
                  jobId: row.job_id,
                  cost: row.cost_micros,
                  finishedAt: row.finished_at_ms,
                }),
              );
              assert.equal(row.outcome, "timed_out");
              assert.equal(row.code, "timed_out");
              assert.equal(Number(row.finished_at_ms), Number(row.started_at_ms) + 2000);
              assert.equal(Number(row.cost_micros), 0);
              assert.equal(row.cost_basis, "none");
              assert.equal(row.cleanup_status, "not_required");
              assert.equal(await jobs.findById(jobId(executionId)), null);
              assert.equal(
                (
                  await pool.query("SELECT * FROM tool_job_publications WHERE job_id=$1", [
                    executionId,
                  ])
                ).rowCount,
                0,
              );
              assert.equal(
                Number(
                  (
                    await pool.query(
                      "SELECT COALESCE(sum(cost_micros),0) AS cost FROM tool_cost_reservations WHERE project_id=$1",
                      [project],
                    )
                  ).rows[0].cost,
                ),
                0,
              );
              const snapshot = JSON.stringify(row);
              await executor.recover();
              assert.equal(
                JSON.stringify(
                  (await pool.query("SELECT * FROM tool_executions WHERE id=$1", [executionId]))
                    .rows[0],
                ),
                snapshot,
              );
              await assert.rejects(audit.attachJob(executionId, executionId), {
                code: "timed_out",
              });
              await assert.rejects(audit.reserve(executionId, project, 10000), {
                code: "timed_out",
              });
              if (original.cost_basis === "reserved")
                await assert.rejects(
                  pool.query(
                    "UPDATE tool_cost_reservations SET cost_micros=10000 WHERE execution_id=$1",
                    [executionId],
                  ),
                  /remote_admission_closed/,
                );
              else
                assert.equal(
                  (
                    await pool.query(
                      "UPDATE tool_cost_reservations SET cost_micros=10000 WHERE execution_id=$1",
                      [executionId],
                    )
                  ).rowCount,
                  0,
                );
              await assert.rejects(
                pool.query("INSERT INTO tool_cost_reservations VALUES ($1,$2,10000)", [
                  executionId,
                  project,
                ]),
                /remote_admission_closed/,
              );
            } else assert.equal(stage, "before-audit");
            assert.equal(effects, before);
            await newAuthorizedCall();
            t.diagnostic(
              JSON.stringify({
                stage,
                id: executionId,
                outcome: original ? "timed_out" : "no_audit",
                reservation: 0,
                lateEffects: 0,
                newAuthorizedCall: "succeeded",
              }),
            );
          },
        );
      if (!process.env.QA49_H1_REPRO_ONLY) {
        await t.test(
          "expired pre-lease audit upgrades from trusted registry and releases the full unused budget",
          async () => {
            const executionId = id(),
              startedAtMs = Date.now();
            await audit.begin({
              schemaVersion: 1,
              id: executionId,
              callerId: owner,
              projectId: project,
              toolName: manifest.name,
              toolVersion: manifest.version,
              inputHash: null,
              startedAtMs,
              finishedAtMs: null,
              durationMs: null,
              outcome: "running",
              code: null,
              costMicros: 0,
              jobId: null,
              cleanupStatus: "not_required",
              cleanupCode: null,
              stopCode: null,
              costBasis: "none",
            });
            await audit.reserve(executionId, project, 10000);
            await until(
              async () =>
                (
                  await pool.query(
                    "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint >= $1 AS expired",
                    [startedAtMs + 2000],
                  )
                ).rows[0].expired,
              "legacy declared deadline",
            );
            await freshRecover();
            const row = await audit.get(executionId);
            assert.equal(row.outcome, "timed_out");
            assert.equal(row.costMicros, 0);
            assert.equal(row.finishedAtMs, startedAtMs + 2000);
            await newAuthorizedCall();
          },
        );
        await t.test(
          "legitimate admission lease and ownership remain fenced before expiry",
          async () => {
            const child = spawn({ mode: "execute", call, pauseAdmission: "after-reserve" });
            await until(
              () => child.messages.some((m) => m.stage === "after-reserve"),
              "live admission",
            );
            const executionId = child.messages.find((m) => m.stage === "after-reserve").id;
            const before = await audit.get(executionId);
            await assert.rejects(audit.finish(executionId, "succeeded", null, 1), {
              code: "remote_missing",
            });
            assert.deepEqual(await audit.get(executionId), before);
            await executor.recover();
            assert.deepEqual(await audit.get(executionId), before);
            await assert.rejects(
              pool.query(
                "UPDATE tool_executions SET admission_deadline_at_ms=admission_deadline_at_ms+1 WHERE id=$1",
                [executionId],
              ),
              /admission_identity_immutable/,
            );
            await assert.rejects(audit.attachJob(executionId, executionId, id()), {
              code: "timed_out",
            });
            await assert.rejects(audit.reserve(executionId, project, 10000, id()), {
              code: "timed_out",
            });
            child.child.kill("SIGKILL");
            await child.ended;
            await until(
              async () =>
                (
                  await pool.query(
                    "SELECT admission_deadline_at_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint AS expired FROM tool_executions WHERE id=$1",
                    [executionId],
                  )
                ).rows[0].expired,
              "lease expiry",
            );
            await executor.recover();
            assert.equal((await audit.get(executionId)).costMicros, 0);
          },
        );
        await t.test(
          "SIGKILL inside admission recovery transaction rolls back; fresh concurrent recovery settles once",
          async () => {
            const child = spawn({ mode: "execute", call, pauseAdmission: "after-reserve" });
            await until(() => child.messages.some((m) => m.stage === "after-reserve"), "reserve");
            const executionId = child.messages.find((m) => m.stage === "after-reserve").id;
            child.child.kill("SIGKILL");
            await child.ended;
            await until(
              async () =>
                (
                  await pool.query(
                    "SELECT admission_deadline_at_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint AS expired FROM tool_executions WHERE id=$1",
                    [executionId],
                  )
                ).rows[0].expired,
              "expiry",
            );
            const recovering = spawn({ mode: "recover", pauseAdmission: "recovery-transaction" });
            await until(
              () => recovering.messages.some((m) => m.stage === "recovery-transaction"),
              "recovery before commit",
            );
            await executor.recover(); // SKIP LOCKED must not settle the other coordinator's uncommitted row.
            assert.equal((await audit.get(executionId)).outcome, "running");
            recovering.child.kill("SIGKILL");
            await recovering.ended;
            await freshRecover();
            await executor.recover();
            assert.equal((await audit.get(executionId)).outcome, "timed_out");
            assert.equal((await audit.get(executionId)).costMicros, 0);
            await newAuthorizedCall();
          },
        );
        for (const window of ["publication", "acknowledgment", "lost-attachment"])
          await t.test(
            `SIGKILL ${window}; outbox authority, terminal SQL row count and budget recovery`,
            async () => {
              const child = spawn({
                mode: "execute",
                call,
                pausePublication: window !== "acknowledgment",
                pauseEnqueue: window === "acknowledgment",
              });
              const stage = window === "acknowledgment" ? "queued" : "postgres-commit-before-redis";
              await until(() => child.messages.some((m) => m.stage === stage), "durable Job");
              const executionId = child.messages.find((m) => m.stage === stage).id;
              const queued = await jobs.findById(jobId(executionId));
              assert.equal(queued.status, "Queued");
              child.child.kill("SIGKILL");
              await child.ended;
              if (window === "lost-attachment")
                await pool.query("UPDATE tool_executions SET job_id=NULL WHERE id=$1", [
                  executionId,
                ]);
              const before = effects;
              await until(
                async () =>
                  (
                    await pool.query(
                      "SELECT admission_deadline_at_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint AS expired FROM tool_executions WHERE id=$1",
                      [executionId],
                    )
                  ).rows[0].expired,
                "expiry",
              );
              await freshRecover();
              await executor.recover();
              const row = await audit.get(executionId);
              assert.equal(row.jobId, executionId);
              assert.equal(row.outcome, "timed_out");
              assert.equal(row.costMicros, 0);
              assert.equal(row.costBasis, "none");
              assert.equal((await jobs.findById(jobId(executionId))).status, "Cancelled");
              assert.equal(await calls.result(executionId), null);
              assert.equal(
                (await pool.query("SELECT * FROM job_attempts WHERE job_id=$1", [executionId]))
                  .rowCount,
                0,
              );
              const stale = await pool.query(
                "UPDATE jobs SET status='Running' WHERE id=$1 RETURNING id",
                [executionId],
              );
              assert.equal(stale.rowCount, 0);
              const started = queued.start(instant(queued.createdAt + 1n));
              const completed = started.complete(instant(started.updatedAt + 1n));
              const attempt = JobAttempt.start(
                id(),
                started.id,
                started.attemptCount,
                started.updatedAt,
              ).finish("Completed", completed.updatedAt, null);
              await assert.rejects(
                jobs.recordCompletion(completed, attempt),
                /terminal write fenced/,
              );
              assert.equal(
                (await pool.query("SELECT * FROM job_attempts WHERE job_id=$1", [executionId]))
                  .rowCount,
                0,
              );
              assert.equal(effects, before);
              await newAuthorizedCall(); // consumes any late Redis receipt without executing it.
              assert.equal(effects, before + 1);
              await executor.recover();
              assert.deepEqual(await audit.get(executionId), row);
            },
          );
        await t.test(
          "M1 production rejection, emitted records and PostgreSQL audit never contain untrusted keys",
          async () => {
            const emitted = [];
            const guarded = new ToolExecutor(registry, authority, audit, dispatcher, 4, (r) =>
              emitted.push(r),
            );
            for (const key of [
              "SECRET_TOKEN=private",
              "secret/~path",
              "secret\n\t\u0001",
              "SECRET_".repeat(1000),
            ]) {
              await assert.rejects(
                guarded.execute({ ...call, input: { text: "ok", [key]: "private" } }),
                (e) => {
                  assert.equal(e.code, "invalid_input");
                  assert.ok(e.message.includes("/[additional-property]"));
                  assert.ok(
                    !e.message.includes("SECRET") &&
                      !e.message.includes("secret") &&
                      !e.message.includes("private"),
                  );
                  return true;
                },
              );
            }
            const rows = (
              await pool.query("SELECT * FROM tool_executions WHERE code='invalid_input'")
            ).rows;
            assert.equal(rows.length, 4);
            assert.equal(emitted.length, 4);
            assert.ok(
              !JSON.stringify({ rows, emitted }).includes("SECRET") &&
                !JSON.stringify({ rows, emitted }).includes("secret"),
            );
            assert.ok(
              rows.every(
                (r) => r.outcome === "rejected" && r.job_id === null && Number(r.cost_micros) === 0,
              ),
            );
          },
        );
      }
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await queue.close();
      await events.close();
      await pool.end();
      await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`);
      await bootstrap.end();
    }
  },
);
