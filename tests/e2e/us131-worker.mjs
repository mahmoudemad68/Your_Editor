import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
const require = createRequire(new URL("../../workers/media-worker/package.json", import.meta.url));
const { Pool } = require("pg");
const { instant, createUuidV7 } = require("@editagent/domain");
const {
  BullMqJobQueue,
  RedisJobEventPublisher,
  PostgresJobRepository,
  runNextJob,
  PermanentJobError,
} = require("@editagent/job-queue");
const { ChildProcessJobSupervisor } = require("./dist/infrastructure/child-job-supervisor.js");
process.once("message", ({ queueName, mode }) => {
  void (async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const queue = new BullMqJobQueue(process.env.REDIS_URL, {
      events: new RedisJobEventPublisher(pool, process.env.REDIS_URL),
    });
    try {
      await runNextJob(
        {
          jobs: new PostgresJobRepository(pool),
          queue,
          now: () => instant(BigInt(Date.now())),
          newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
          supervisor: {
            async run(envelope, handler, signal) {
              // Test pacing makes a real worker-reported stage observable to the DOM.
              // Actual validation runs unchanged through the production isolated handler.
              await queue.publishProgress(envelope.jobId, {
                stage: "staging",
                percentage: 0,
                attempt: envelope.attempt,
              });
              await new Promise((resolve) => setTimeout(resolve, 700));
              if (mode === "fail")
                throw new PermanentJobError("fixture internal failure /secret/path?token=unsafe");
              await new ChildProcessJobSupervisor().run(envelope, handler, signal);
            },
          },
        },
        queueName,
        {
          modulePath: require.resolve("./dist/handlers/media-jobs.js"),
          exportName: "handleMediaJob",
        },
      );
    } finally {
      await queue.close();
      await pool.end();
    }
  })().catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
});
