// Test-only separate process for a committed manual edit and stale-hash replay.
// No production entry point, transaction bypass, credentials or raw data output.
const process = require("node:process");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const requireApi = require("node:module").createRequire(
  path.resolve(__dirname, "../../apps/api/package.json"),
);
const { Pool } = requireApi("pg");
const { instant, createUuidV7 } = requireApi("@editagent/domain");
const {
  TimelineEditor,
  TimelineConflict,
} = require("../../apps/api/dist/application/timeline-editor.js");
const { GetMediaDetails } = require("../../apps/api/dist/application/media-details.js");
const {
  PostgresProjectRepository,
} = require("../../apps/api/dist/infrastructure/postgres-project-repository.js");
const {
  PostgresMediaAssetRepository,
} = require("../../apps/api/dist/infrastructure/postgres-media-repository.js");
const {
  PostgresTimelineStore,
} = require("../../apps/api/dist/infrastructure/postgres-timeline-store.js");
const { timelineProposals } = require("../../apps/api/dist/infrastructure/timeline-proposals.js");
if (!process.send || process.env.TIMELINE_CAS_TEST !== "1") throw new Error("Test driver only.");
process.once("message", async (request) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const projects = new PostgresProjectRepository(pool),
      store = new PostgresTimelineStore(pool);
    const editor = new TimelineEditor(
      projects,
      new GetMediaDetails(projects, new PostgresMediaAssetRepository(pool)),
      store,
      timelineProposals(pool, store),
      { now: () => instant(BigInt(Date.now())) },
      () => createUuidV7(Date.now(), randomBytes(10)),
    );
    const result = await editor.edit(
      request.actor,
      request.project,
      request.timeline,
      request.expectedSha256,
      "trim-video",
      request.input,
    );
    if (request.mode !== "commit") throw new Error("Unexpected replay success.");
    process.send({ phase: "committed", hash: result.stateSha256 });
    await new Promise(() => {});
  } catch (error) {
    process.send({
      phase: request.mode === "replay" && error instanceof TimelineConflict ? "conflict" : "failed",
    });
  } finally {
    await pool.end();
  }
});
