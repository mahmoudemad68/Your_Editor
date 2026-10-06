import { randomBytes } from "node:crypto";
import { createUuidV7, instant } from "@editagent/domain";
import {
  BullMqJobQueue,
  PostgresJobRepository,
  requestMediaRevalidation,
} from "@editagent/job-queue";
import { Pool } from "pg";
import { ChildProcessJobSupervisor } from "./infrastructure/child-job-supervisor.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";

/** Operator/application entry point: enqueues normal production work, never validates directly. */
export async function enqueueInspection(
  mediaAssetId: string,
  previousJobId: string,
): Promise<void> {
  const config = loadMediaWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const queue = new BullMqJobQueue(config.redisUrl);
  const id = () => createUuidV7(Date.now(), randomBytes(10));
  try {
    const result = await requestMediaRevalidation(
      {
        jobs: new PostgresJobRepository(pool),
        queue,
        supervisor: new ChildProcessJobSupervisor(),
        now: () => instant(BigInt(Date.now())),
        newAttemptId: id,
      },
      {
        jobId: id(),
        mediaAssetId,
        previousJobId,
        correlationId: id(),
        queueName: config.mediaInspectQueue,
        policy: config.validationPolicy,
      },
    );
    process.stdout.write(`media.inspect ${result.jobId} duplicate=${result.duplicate}\n`);
  } finally {
    await queue.close();
    await pool.end();
  }
}
if (require.main === module) {
  const [media, previous] = process.argv.slice(2);
  if (media === undefined || previous === undefined || process.argv.length !== 4) {
    process.stderr.write(
      "usage: node dist/enqueue-inspect.js <mediaAssetId> <terminalInspectJobId>\n",
    );
    process.exitCode = 1;
  } else
    void enqueueInspection(media, previous).catch(() => {
      process.stderr.write("Inspection enqueue failed.\n");
      process.exitCode = 1;
    });
}
