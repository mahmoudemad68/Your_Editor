// Deterministic test-only barrier AFTER the durable Tool SDK proposal receipt.
// No open transaction is suspended; no credentials or caption text cross IPC.
const process = require("node:process");
const requireApi = require("node:module").createRequire(
  require("node:path").resolve(__dirname, "../../apps/api/package.json"),
);
const { Pool } = requireApi("pg");
const { ToolExecutor } = requireApi("@editagent/tool-sdk");
const {
  PostgresCaptionEdits,
} = require("../../apps/api/dist/infrastructure/postgres-caption-edits.js");
if (!process.send || process.env.CAPTION_CRASH_TEST !== "1") throw new Error("Test driver only.");
const original = ToolExecutor.prototype.executeWithIdentity;
ToolExecutor.prototype.executeWithIdentity = async function (...args) {
  const result = await original.apply(this, args);
  process.send({ phase: "receipt-recorded" });
  await new Promise(() => {});
  return result;
};
process.once("message", async (message) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await new PostgresCaptionEdits(pool).execute(
      message.actor,
      message.project,
      message.timeline,
      message.request,
    );
  } catch {
    process.send({ phase: "failed" });
  }
});
