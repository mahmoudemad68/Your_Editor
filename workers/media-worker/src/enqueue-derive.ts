import { randomBytes } from "node:crypto";
import { createUuidV7, instant } from "@editagent/domain";
import { BullMqJobQueue, PostgresJobRepository } from "@editagent/job-queue";
import { Pool } from "pg";
import { publishMediaDeriveJob } from "./application/publish-media-derive.js";
import { ChildProcessJobSupervisor } from "./infrastructure/child-job-supervisor.js";
import { loadMediaWorkerConfig } from "./infrastructure/config.js";

export async function enqueueDerivation(projectId: string, mediaAssetId: string): Promise<void> {
  const config = loadMediaWorkerConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const queue = new BullMqJobQueue(config.redisUrl);
  try {
    const result = await publishMediaDeriveJob(
      {
        jobs: new PostgresJobRepository(pool),
        queue,
        supervisor: new ChildProcessJobSupervisor(),
        now: () => instant(BigInt(Date.now())),
        newAttemptId: () => createUuidV7(Date.now(), randomBytes(10)),
      },
      {
        jobId: createUuidV7(Date.now(), randomBytes(10)),
        mediaAssetId,
        projectId,
        correlationId: createUuidV7(Date.now(), randomBytes(10)),
        queueName: config.mediaInspectQueue,
      },
    );
    process.stdout.write(`media.derive ${result.jobId} duplicate=${result.duplicate}\n`);
  } finally {
    await queue.close();
    await pool.end();
  }
}
if (require.main === module) {
  const [project, media] = process.argv.slice(2);
  if (project === undefined || media === undefined || process.argv.length !== 4) {
    process.stderr.write("usage: node dist/enqueue-derive.js <projectId> <mediaAssetId>\n");
    process.exitCode = 1;
  } else
    void enqueueDerivation(project, media).catch(() => {
      process.stderr.write("Derivation enqueue failed.\n");
      process.exitCode = 1;
    });
}
