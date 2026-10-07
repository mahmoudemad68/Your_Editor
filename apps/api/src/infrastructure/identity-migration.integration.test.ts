/**
 * An existing project database has memberships before any account exists.
 * 0007 and 0008 must keep those rows and must not invent a password.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { applyMigrations } from "./migrate.js";

const TEST_DATABASE = "editagent_us118_upgrade";
const PRIOR = [
  "0001_projects.sql",
  "0002_media_assets.sql",
  "0003_media_probe_metadata.sql",
  "0004_media_inspection_revision.sql",
  "0005_jobs.sql",
  "0006_inspect_publication_outbox.sql",
];
const PROJECT = "018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f";
const HISTORICAL_USER = "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f";

function adminUrl(): string {
  return (
    process.env["DATABASE_URL"] ??
    "postgresql://editagent:editagent-dev-password@127.0.0.1:5432/editagent"
  );
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

test("0007 preserves historical memberships without creating accounts", async () => {
  const admin = new Pool({ connectionString: adminUrl() });
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();
  const pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
  try {
    const directory = path.resolve(__dirname, "../../migrations");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const file of PRIOR) {
      const sql = await readFile(path.join(directory, file), "utf8");
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await pool.query(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ($1, 'Historical footage', 10, 10)`,
      [PROJECT],
    );
    await pool.query(
      `INSERT INTO project_memberships (project_id, user_id, role, created_at)
       VALUES ($1, $2, 'owner', 10)`,
      [PROJECT, HISTORICAL_USER],
    );

    const applied = await applyMigrations(pool);
    assert.deepEqual(applied, [
      "0007_identity.sql",
      "0008_refresh_revocation_audit.sql",
      "0009_upload_sessions.sql",
      "0010_derived_assets.sql",
      "0011_media_validation.sql",
      "0012_job_event_sequence.sql",
    ]);

    const project = await pool.query<{ name: string }>("SELECT name FROM projects WHERE id = $1", [
      PROJECT,
    ]);
    assert.equal(project.rows[0]?.name, "Historical footage");
    const membership = await pool.query<{ user_id: string; role: string }>(
      "SELECT user_id::text AS user_id, role FROM project_memberships WHERE project_id = $1",
      [PROJECT],
    );
    assert.equal(membership.rows[0]?.user_id, HISTORICAL_USER);
    assert.equal(membership.rows[0]?.role, "owner");
    const accounts = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users",
    );
    assert.equal(accounts.rows[0]?.count, "0");
    const constraint = await pool.query<{ validated: boolean }>(
      `SELECT convalidated AS validated
       FROM pg_constraint
       WHERE conname = 'project_memberships_user_id_fkey'`,
    );
    assert.equal(constraint.rows[0]?.validated, false);
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO project_memberships (project_id, user_id, role, created_at)
           VALUES ($1, '018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f', 'editor', 11)`,
          [PROJECT],
        ),
      /project_memberships_user_id_fkey/,
    );
  } finally {
    await pool.end();
  }
});
