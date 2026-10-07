/** Integration fixture: real queue reservation + durable lifecycle in a separate worker process. */
import { Pool } from "pg";
import { instant, createUuidV7 } from "@editagent/domain";
import { randomBytes } from "node:crypto";
import {
  BullMqJobQueue,
  RedisJobEventPublisher,
  PostgresJobRepository,
  runNextJob,
  PermanentJobError,
  JobCancelledError,
} from "@editagent/job-queue";

interface FixtureConfig {
  databaseUrl: string;
  redisUrl: string;
  transportUrl: string;
  queueName: string;
  mode: string;
}
async function main(config: FixtureConfig): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const publisher = new RedisJobEventPublisher(pool, config.transportUrl);
  const queue = new BullMqJobQueue(config.redisUrl, { events: publisher });
  const mode = config.mode;
  try {
    const report = async (
      id: string,
      attempt: number,
      percentage: number,
      stage: "staging" | "proxy" | "finalizing",
    ) => {
      process.send?.({
        type: "reported",
        jobId: id,
        attempt,
        percentage,
        stage,
        reportedAt: Date.now(),
      });
      await queue.publishProgress(id, { attempt, percentage, stage });
    };
    await runNextJob(
      {
        jobs: new PostgresJobRepository(pool),
        queue,
        supervisor: {
          async run(envelope) {
            await report(envelope.jobId, envelope.attempt, 0, "staging");
            // F-1 permits immediate intermediate stages to coalesce while the
            // API authorizes a frame. Hold this fixture stage so the ordered
            // retry test can observe its attempt reset without changing the
            // production delivery guarantee or weakening its assertions.
            if (mode === "retry") await new Promise((resolve) => setTimeout(resolve, 250));
            if (mode === "burst") {
              for (let i = 0; i <= 100; i++)
                await report(envelope.jobId, envelope.attempt, i, "proxy");
              await new Promise((resolve) => setTimeout(resolve, 250));
            } else {
              await report(envelope.jobId, envelope.attempt, 25, "proxy");
              await report(envelope.jobId, envelope.attempt, 75, "proxy");
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            if (mode === "retry" && envelope.attempt === 1)
              throw new Error("unsafe secret test failure");
            if (mode === "fail") throw new PermanentJobError("unsafe secret test failure");
            if (mode === "cancel") throw new JobCancelledError();
            await report(envelope.jobId, envelope.attempt, 100, "finalizing");
          },
        },
        now: () => instant(BigInt(Date.now())),
        newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
      },
      config.queueName,
      { modulePath: "fixture", exportName: "fixture" },
    );
  } finally {
    await queue.close();
    await pool.end();
  }
}
process.once("message", (config: FixtureConfig) => {
  void main(config).catch(() => {
    process.exitCode = 1;
  });
});
