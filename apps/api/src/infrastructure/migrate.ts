import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type Pool } from "pg";

/** Applies SQL files in apps/api/migrations once, in filename order. */
export async function applyMigrations(
  pool: Pool,
  directory = path.resolve(__dirname, "../../migrations"),
): Promise<readonly string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const applied: string[] = [];
  for (const file of files) {
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM schema_migrations WHERE id = $1",
      [file],
    );
    if ((existing.rowCount ?? 0) > 0) {
      continue;
    }
    const sql = await readFile(path.join(directory, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return applied;
}
