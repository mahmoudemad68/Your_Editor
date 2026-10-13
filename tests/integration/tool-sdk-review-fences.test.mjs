import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { createUuidV7, instant, jobId } from "../../packages/domain/dist/index.js";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  RedisJobEventPublisher,
  enqueueJob,
  cancelJob,
  runNextJob,
  PermanentJobError,
  JobCancelledError,
} from "../../packages/job-queue/dist/index.js";
import {
  ToolRegistry,
  ToolError,
  ToolExecutor,
  contentHash,
  PostgresToolAuthority,
  PostgresToolAuditRepository,
  PostgresRemoteCallStore,
  QueueToolDispatcher,
  RemoteToolConsumer,
  RemoteToolSupervisor,
  IsolatedTool,
} from "../../packages/tool-sdk/dist/index.js";
import { startPostgres, startRedis } from "./support/containers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const id = () => createUuidV7(Date.now(), randomBytes(10));

test(
  "PR49 review: real terminal-save fencing and legacy ten-minute admission",
  { timeout: 300000 },
  async (t) => {
    let pg, redis, pool, bootstrap, queue, events;
    const namespace = `review_${randomUUID().replaceAll("-", "")}`;
    try {
      pg = await startPostgres();
      redis = await startRedis();
      bootstrap = new Pool({ connectionString: pg.url });
      await bootstrap.query(`CREATE SCHEMA ${namespace}`);
      pool = new Pool({ connectionString: pg.url, options: `-c search_path=${namespace}` });
      const migrations = (await readdir(path.join(root, "apps/api/migrations")))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of migrations.filter((f) => f < "0016"))
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      const owner = id();
      let project = id();
      await pool.query(
        "INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES ($1,'review@example.com','$argon2id$test',0,0)",
        [owner],
      );
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'review',0,0)",
        [project],
      );
      await pool.query("INSERT INTO project_memberships VALUES ($1,$2,'owner',0)", [
        project,
        owner,
      ]);
      const legacyId = id(),
        legacyStart = Date.now() - 360000;
      // A real pre-lease in-process execution, six minutes into a valid ten-minute call.
      await pool.query(
        "INSERT INTO tool_executions(id,schema_version,caller_id,project_id,tool_name,tool_version,started_at_ms,outcome,cost_micros,cost_basis) VALUES ($1,1,$2,$3,'review.long','1.0.0',$4,'running',10000,'reserved')",
        [legacyId, owner, project, legacyStart],
      );
      await pool.query("INSERT INTO tool_cost_reservations VALUES ($1,$2,10000)", [
        legacyId,
        project,
      ]);
      for (const file of migrations.filter((f) => f.startsWith("0016")))
        await pool.query(await readFile(path.join(root, "apps/api/migrations", file), "utf8"));
      const audit = new PostgresToolAuditRepository(pool, 10000);
      const policies = [
        { name: "review.long", version: "1.0.0", timeoutMs: 600000, mode: "in-process" },
      ];
      await t.test(
        "migration preserves a legitimately active ten-minute pre-lease execution",
        async () => {
          await Promise.all([
            audit.recoverAdmissions(100, legacyId, policies),
            audit.recoverAdmissions(100, legacyId, policies),
          ]);
          const record = await audit.get(legacyId);
          t.diagnostic(
            JSON.stringify({
              legacyAgeMs: Date.now() - legacyStart,
              outcome: record.outcome,
              finishedAtMs: record.finishedAtMs,
              costMicros: record.costMicros,
            }),
          );
          assert.equal(record.outcome, "running");
          assert.equal(record.finishedAtMs, null);
          assert.equal(record.costMicros, 10000);
          assert.equal(
            Number(
              (
                await pool.query(
                  "SELECT admission_deadline_at_ms FROM tool_executions WHERE id=$1",
                  [legacyId],
                )
              ).rows[0].admission_deadline_at_ms,
            ),
            legacyStart + 600000,
          );
        },
      );
      // Finish the legitimate call, acknowledging its real in-process outcome; no refund by recovery.
      if ((await audit.get(legacyId)).outcome === "running")
        await audit.finish(legacyId, "succeeded", null, 0, Date.now(), "succeeded", "actual");

      await t.test(
        "new legacy-compatible admissions use the maximum supported timeout",
        async () => {
          const executionId = id(),
            start = Date.now();
          await audit.begin(baseRecord(executionId, owner, project, start));
          assert.equal(
            Number(
              (
                await pool.query(
                  "SELECT admission_deadline_at_ms FROM tool_executions WHERE id=$1",
                  [executionId],
                )
              ).rows[0].admission_deadline_at_ms,
            ),
            start + 600000,
          );
          await audit.finish(executionId, "rejected", "invalid_call", 0, Date.now());
        },
      );

      await t.test(
        "upgrade repairs previously-applied five-minute backfill without extending managed leases or reviving terminal audits",
        async () => {
          const unmanaged = id(),
            managed = id(),
            start = Date.now() - 360000,
            liveStart = Date.now();
          await audit.begin(baseRecord(unmanaged, owner, project, start));
          await pool.query(
            "UPDATE tool_executions SET admission_deadline_at_ms=started_at_ms+300000 WHERE id=$1",
            [unmanaged],
          );
          await audit.begin(baseRecord(managed, owner, project, liveStart), {
            ownerId: id(),
            deadlineAtMs: liveStart + 2000,
            mode: "remote",
          });
          const terminal = await audit.get(legacyId);
          await pool.query(
            await readFile(
              path.join(
                root,
                "apps/api/migrations/0017_tool_legacy_deadline_and_terminal_snapshot.sql",
              ),
              "utf8",
            ),
          );
          await Promise.all([
            audit.recoverAdmissions(100, unmanaged, policies),
            audit.recoverAdmissions(100, unmanaged, policies),
          ]);
          assert.equal((await audit.get(unmanaged)).outcome, "running");
          const leases = (
            await pool.query(
              "SELECT id,admission_deadline_at_ms FROM tool_executions WHERE id=ANY($1::uuid[])",
              [[unmanaged, managed]],
            )
          ).rows;
          assert.equal(
            Number(leases.find((r) => r.id === unmanaged).admission_deadline_at_ms),
            start + 600000,
          );
          assert.equal(
            Number(leases.find((r) => r.id === managed).admission_deadline_at_ms),
            liveStart + 2000,
          );
          assert.deepEqual(await audit.get(legacyId), terminal);
          await audit.finish(unmanaged, "succeeded", null, 0, Date.now(), "succeeded", "actual");
          await audit.finish(managed, "rejected", "invalid_call", 0, Date.now());
        },
      );
      await t.test(
        "ten-minute legacy expiry uses trusted policy and retains unverified in-process exposure",
        async () => {
          const executionId = id(),
            exposureProject = id(),
            start = Date.now() - 540000;
          await pool.query(
            "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'exposure',0,0)",
            [exposureProject],
          );
          await audit.begin(baseRecord(executionId, owner, exposureProject, start));
          await audit.reserve(executionId, exposureProject, 10000);
          await audit.recoverAdmissions(100, executionId, policies);
          assert.equal((await audit.get(executionId)).outcome, "running");
          // Persisted historical timestamps advance this fixture past the declared deadline;
          // production recovery still uses the real PostgreSQL clock, never a mocked clock.
          await pool.query(
            "UPDATE tool_executions SET started_at_ms=started_at_ms-120000,admission_deadline_at_ms=admission_deadline_at_ms-120000 WHERE id=$1",
            [executionId],
          );
          await Promise.all([
            audit.recoverAdmissions(100, executionId, policies),
            audit.recoverAdmissions(100, executionId, policies),
          ]);
          const terminal = await audit.get(executionId);
          assert.equal(terminal.outcome, "timed_out");
          assert.equal(terminal.finishedAtMs, start - 120000 + 600000);
          assert.equal(terminal.costMicros, 10000);
          assert.equal(terminal.costBasis, "reserved");
          assert.equal(terminal.cleanupStatus, "unconfirmed");
          await audit.recoverAdmissions(100, executionId, policies);
          assert.deepEqual(await audit.get(executionId), terminal);
        },
      );

      // Independent projects isolate the two reproductions without rewriting failed audit costs.
      project = id();
      await pool.query(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES ($1,'remote review',0,0)",
        [project],
      );
      await pool.query("INSERT INTO project_memberships VALUES ($1,$2,'owner',0)", [
        project,
        owner,
      ]);
      events = new RedisJobEventPublisher(pool, redis.url);
      queue = new BullMqJobQueue(redis.url, { events });
      const jobs = new PostgresJobRepository(pool),
        calls = new PostgresRemoteCallStore(pool);
      const schema = {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", maxLength: 64 } },
      };
      const manifest = {
        schemaVersion: 1,
        id: id(),
        name: "review.remote",
        version: "1.0.0",
        description: "Review race proof",
        inputSchema: schema,
        outputSchema: schema,
        permissions: ["project.read"],
        capabilities: ["audio"],
        estimatedCostMicros: 0,
        maximumCostMicros: 10000,
        timeoutMs: 2000,
        mutating: false,
        validationRules: [],
      };
      const registry = new ToolRegistry();
      registry.register(manifest, { mode: "remote", target: "media" });
      const authority = new PostgresToolAuthority(pool, async () => {
        throw new ToolError("invalid_subject");
      });
      const actual = new IsolatedTool(
        path.join(root, "tests/integration/support/tool-operations.cjs"),
        "echo",
      );
      let effects = 0;
      const consumer = new RemoteToolConsumer(
        registry,
        authority,
        calls,
        audit,
        queue,
        new Map([
          [
            "review.remote@1.0.0",
            {
              start(input, context) {
                effects++;
                const run = actual.start(input, context);
                return { ...run, result: run.result.then((r) => ({ ...r, costMicros: 0 })) };
              },
            },
          ],
        ]),
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
      const registered = registry.lookup(manifest.name, manifest.version);

      await t.test(
        "cancel wins between worker read and Running save: no phantom attempt or retained budget",
        async () => {
          const executionId = id(),
            start = Date.now(),
            leaseOwner = id();
          await audit.begin(
            {
              ...baseRecord(executionId, owner, project, start),
              toolName: manifest.name,
              inputHash: contentHash({ text: "race" }),
            },
            { ownerId: leaseOwner, deadlineAtMs: start + 2000, mode: "remote" },
          );
          await audit.reserve(executionId, project, 10000, leaseOwner);
          await calls.put({
            executionId,
            callerId: owner,
            projectId: project,
            resource: { kind: "project", id: project },
            name: manifest.name,
            version: manifest.version,
            fingerprint: registered.fingerprint,
            input: { text: "race" },
            inputHash: contentHash({ text: "race" }),
          });
          await audit.attachJob(executionId, executionId, leaseOwner);
          await enqueueJob(deps, {
            id: executionId,
            queueName: "tools-media-v1",
            jobType: "tool.execute.v1",
            idempotencyKey: `tool:${executionId}:${registered.fingerprint}`,
            payload: { schemaVersion: 1, executionId },
            subject: { kind: "project", projectId: project },
            timeoutMs: 2000,
            maxAttempts: 3,
            backoffBaseMs: 50,
          });
          const initial = await jobs.findById(jobId(executionId));
          let injected = false;
          const racedJobs = Object.create(jobs);
          racedJobs.save = async (job) => {
            if (!injected && job.status === "Running") {
              injected = true;
              // Exactly the disputed boundary: real durable cancellation AFTER stale read.
              await audit.requestStop(executionId, "cancelled");
              await calls.fence(executionId);
              assert.equal((await jobs.findById(jobId(executionId))).status, "Cancelled");
            }
            return jobs.save(job);
          };
          const before = effects;
          await runNextJob({ ...deps, jobs: racedJobs }, "tools-media-v1", {
            modulePath: "unused",
            exportName: "unused",
          });
          const durable = await jobs.findById(jobId(executionId)),
            attempts = await jobs.listAttempts(jobId(executionId));
          await executor.recover();
          const result = await audit.get(executionId);
          t.diagnostic(
            JSON.stringify({
              status: durable.status,
              attemptCount: durable.attemptCount,
              attempts: attempts.length,
              outcome: result.outcome,
              costMicros: result.costMicros,
              costBasis: result.costBasis,
              effects: effects - before,
            }),
          );
          assert.equal(injected, true);
          assert.equal(durable.status, "Cancelled");
          assert.equal(durable.attemptCount, 0);
          assert.equal(attempts.length, 0);
          assert.equal(effects, before);
          assert.equal(result.outcome, "cancelled");
          assert.equal(result.costMicros, 0);
          assert.equal(result.costBasis, "none");
          await assert.rejects(
            jobs.save(initial.start(instant(BigInt(Date.now())))),
            /Job terminal write fenced/,
          );
          // An old worker may also hold a stale same-status Cancelled snapshot with attemptCount=1.
          await assert.rejects(
            jobs.save(
              initial.start(instant(BigInt(Date.now()))).cancel(instant(BigInt(Date.now()))),
            ),
            /Job terminal write fenced/,
          );
          await jobs.save(durable); // exact idempotent terminal snapshot remains legal
          await Promise.all([executor.recover(), executor.recover()]);
          assert.equal(
            Number(
              (
                await pool.query(
                  "SELECT sum(cost_micros) AS cost FROM tool_cost_reservations WHERE project_id=$1",
                  [project],
                )
              ).rows[0].cost,
            ),
            0,
          );

          // Real authorized remote execution consumes the freed full project budget.
          let settled = false;
          const next = executor
            .execute({
              name: manifest.name,
              version: manifest.version,
              callerId: owner,
              projectId: project,
              resource: { kind: "project", id: project },
              input: { text: "after recovery" },
            })
            .finally(() => {
              settled = true;
            });
          while (!settled)
            await runNextJob(deps, "tools-media-v1", {
              modulePath: "unused",
              exportName: "unused",
            });
          assert.equal((await next).output.text, "after recovery");
          assert.equal(effects, before + 1);
        },
      );
    } finally {
      const clients = await Promise.allSettled([queue?.close(), events?.close(), pool?.end()]);
      const database = await Promise.allSettled([
        bootstrap
          ? (async () => {
              try {
                await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`);
              } finally {
                await bootstrap.end();
              }
            })()
          : undefined,
      ]);
      const cleanup = await Promise.allSettled([pg?.close(), redis?.close()]);
      assert.ok(
        [...clients, ...database].every((r) => r.status === "fulfilled"),
        "Client/database cleanup",
      );
      assert.ok(
        cleanup.every((r) => r.status === "fulfilled"),
        "Real service cleanup",
      );
    }
  },
);

function baseRecord(executionId, callerId, projectId, startedAtMs) {
  return {
    schemaVersion: 1,
    id: executionId,
    callerId,
    projectId,
    toolName: "review.long",
    toolVersion: "1.0.0",
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
  };
}
