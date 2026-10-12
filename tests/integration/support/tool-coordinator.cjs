// Fixed test coordinator: SIGKILL uses the real SDK/PG/BullMQ production adapters.
const process = require("node:process");
const { Pool } = require("pg");
const sdk = require("../../../packages/tool-sdk/dist/index.js");
const jobsSdk = require("../../../packages/job-queue/dist/index.js");
const { instant, createUuidV7 } = require("../../../packages/domain/dist/index.js");
const { randomBytes } = require("crypto");
process.once(
  "message",
  async ({ mode, manifest, call, pauseEnqueue, pauseTransaction, pausePublication }) => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${process.env.TOOL_TEST_SCHEMA}`,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      max: 3,
    });
    const jobs = new jobsSdk.PostgresJobRepository(pool);
    const queue = new jobsSdk.BullMqJobQueue(process.env.REDIS_URL);
    if (pausePublication) {
      queue.enqueue = async (input) => {
        process.send({ stage: "postgres-commit-before-redis", id: input.id });
        await new Promise(() => {});
      };
    }
    const registry = new sdk.ToolRegistry();
    registry.register(manifest, { mode: "remote", target: "media" });
    const audit = new sdk.PostgresToolAuditRepository(pool, 10000);
    const deps = {
      jobs,
      queue,
      now: () => instant(BigInt(Date.now())),
      newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
    };
    const dispatcher = new sdk.QueueToolDispatcher(
      jobs,
      {
        enqueue: async (input) => {
          const result = await jobsSdk.enqueueJob(deps, input);
          process.send({ stage: "queued", id: input.id });
          if (pauseEnqueue) await new Promise(() => {});
          return result;
        },
        cancel: (id) => jobsSdk.cancelJob(deps, id),
      },
      new sdk.PostgresRemoteCallStore(pool),
      audit,
    );
    const authority = new sdk.PostgresToolAuthority(pool, async () => {
      throw new sdk.ToolError("invalid_subject");
    });
    const executor = new sdk.ToolExecutor(registry, authority, audit, dispatcher);
    try {
      if (mode === "recover-concurrent") {
        const finish = audit.finish.bind(audit);
        audit.finish = async (...args) => {
          process.send({ stage: "settlement-ready" });
          await new Promise((resolve) => process.once("message", resolve));
          return finish(...args);
        };
      }
      if (mode.startsWith("recover")) {
        const rows = await executor.recover();
        process.send({ stage: "recovered", rows });
      } else {
        const finish = audit.finish.bind(audit);
        let settling = false;
        if (pauseTransaction) {
          const connect = pool.connect.bind(pool);
          pool.connect = (...connectArgs) => {
            if (connectArgs.length) return connect(...connectArgs);
            return connect().then((client) => {
              const query = client.query.bind(client);
              client.query = async (...args) => {
                if (settling && args[0] === "COMMIT") {
                  process.send({ stage: "before-finish", id: call.executionId });
                  await new Promise(() => {});
                }
                return query(...args);
              };
              return client;
            });
          };
          // Install the COMMIT gate only inside settlement, never on admission reservation.
        }
        audit.finish = async (...args) => {
          if (pauseTransaction) {
            settling = true;
            call.executionId = args[0];
            return finish(...args);
          }
          const id = args[0];
          process.send({ stage: "before-finish", id });
          await new Promise(() => {});
        };
        await executor.execute(call);
      }
    } catch (error) {
      process.send({
        stage: "error",
        code: error instanceof sdk.ToolError ? error.code : "test_failed",
      });
    } finally {
      await queue.close();
      await pool.end();
      process.disconnect();
    }
  },
);
