const process = require("node:process");
const { Pool } = require("pg");
const {
  PostgresToolAuditRepository,
  PostgresToolAuthority,
  ToolExecutor,
  ToolRegistry,
} = require("../../../packages/tool-sdk/dist/index.js");
async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${process.env.TOOL_TEST_SCHEMA}`,
    connectionTimeoutMillis: 1000,
    statement_timeout: 2000,
  });
  try {
    const authority = new PostgresToolAuthority(pool, async () => {
      throw new Error("missing timeline");
    });
    const executor = new ToolExecutor(
      new ToolRegistry(),
      authority,
      new PostgresToolAuditRepository(pool, 10000),
    );
    const row = await executor.record(process.argv[2], process.argv[3]);
    process.stdout.write(JSON.stringify(row));
  } finally {
    await pool.end();
  }
}
void main().catch(() => process.exit(1));
