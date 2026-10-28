/** One caption execute in its own process so the parent can SIGKILL it. */
import { createRequire } from "node:module";
import path from "node:path";

const payload = JSON.parse(process.argv[2]);
const app = process.env.QA_APP_ROOT;
const require = createRequire(path.join(app, "apps/api/package.json"));
const { Pool } = require("pg");
const { PostgresCaptionEdits } = require(
  path.join(app, "apps/api/dist/infrastructure/postgres-caption-edits.js"),
);
const pool = new Pool({ connectionString: payload.databaseUrl });
try {
  const edits = new PostgresCaptionEdits(pool);
  const result = await edits.execute(
    payload.actor,
    payload.project,
    payload.timeline,
    payload.request,
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      stateSha256: result.stateSha256,
      captions: result.timeline.captionsV1?.length ?? 0,
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({ ok: false, name: error?.name ?? "Error", code: error?.code ?? null }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
