import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { instant, Project, ProjectConflict, projectId, userId } from "@editagent/domain";
import { Pool } from "pg";
import { applyMigrations } from "./migrate.js";
import { PostgresProjectRepository } from "./postgres-project-repository.js";

const TEST_DATABASE = "editagent_us120";
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");

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

describe("Postgres ProjectRepository", { concurrency: 1 }, () => {
  let pool: Pool;
  let projects: PostgresProjectRepository;

  before(async () => {
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
    projects = new PostgresProjectRepository(pool);
  });

  after(async () => {
    await pool.end();
  });

  test("migrations apply on a clean database and defer the User foreign key", async () => {
    const applied = await applyMigrations(pool);
    assert.deepEqual(applied, ["0001_projects.sql"]);
    const again = await applyMigrations(pool);
    assert.deepEqual(again, []);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('projects', 'project_memberships')
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      ["project_memberships", "projects"],
    );
    const foreignKeys = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'project_memberships'::regclass AND contype = 'f'`,
    );
    assert.equal(foreignKeys.rowCount, 1);
    assert.match(foreignKeys.rows[0]?.definition ?? "", /project_id/);
    assert.match(foreignKeys.rows[0]?.definition ?? "", /projects/);
    assert.doesNotMatch(foreignKeys.rows[0]?.definition ?? "", /users/i);
  });

  test("create persists the Project and its Owner membership together", async () => {
    const project = Project.create(PROJECT, "Launch", OWNER, instant(10n));
    await projects.save(project, null);
    const restored = await projects.findById(PROJECT);
    assert.equal(restored?.id, PROJECT);
    assert.equal(restored?.name, "Launch");
    assert.equal(restored?.createdAt, 10n);
    assert.equal(restored?.updatedAt, 10n);
    assert.equal(restored?.deletedAt, null);
    assert.equal(restored?.roleOf(OWNER), "owner");
    assert.equal(restored?.memberships[0]?.createdAt, 10n);
    assert.equal(restored?.memberships.length, 1);
  });

  test("a failed membership insert rolls back the Project row", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION editagent_fail_membership() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'membership insert failed';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER editagent_fail_membership
      BEFORE INSERT ON project_memberships
      FOR EACH ROW EXECUTE FUNCTION editagent_fail_membership()
    `);
    try {
      const project = Project.create(OTHER, "Partial", OWNER, instant(10n));
      await assert.rejects(() => projects.save(project, null), /membership insert failed/);
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM projects WHERE id = $1",
        [OTHER],
      );
      assert.equal(count.rows[0]?.count, "0");
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS editagent_fail_membership ON project_memberships");
      await pool.query("DROP FUNCTION IF EXISTS editagent_fail_membership()");
    }
  });

  test("rename, roles, listing, and soft delete round-trip without physical removal", async () => {
    const created = await projects.findById(PROJECT);
    assert.ok(created);
    const withEditor = created.grantMembership(OWNER, EDITOR, "editor", instant(20n));
    await projects.save(withEditor, created.updatedAt);
    const withViewer = (await projects.findById(PROJECT))!.grantMembership(
      OWNER,
      VIEWER,
      "viewer",
      instant(30n),
    );
    await projects.save(withViewer, withEditor.updatedAt);
    const renamed = (await projects.findById(PROJECT))!.rename(EDITOR, "Cut", instant(40n));
    await projects.save(renamed, withViewer.updatedAt);

    const restored = await projects.findById(PROJECT);
    assert.equal(restored?.name, "Cut");
    assert.equal(restored?.updatedAt, 40n);
    assert.equal(restored?.roleOf(OWNER), "owner");
    assert.equal(restored?.roleOf(EDITOR), "editor");
    assert.equal(restored?.roleOf(VIEWER), "viewer");
    assert.equal(restored?.memberships[1]?.createdAt, 20n);
    assert.equal(restored?.memberships[2]?.createdAt, 30n);

    assert.deepEqual(
      (await projects.listForMember(OWNER)).map((project) => project.id),
      [PROJECT],
    );
    assert.deepEqual(
      (await projects.listForMember(EDITOR)).map((project) => project.id),
      [PROJECT],
    );
    assert.deepEqual(
      await projects.listForMember(userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f")),
      [],
    );

    const deleted = restored!.deleteProject(OWNER, instant(50n));
    await projects.save(deleted, restored!.updatedAt);
    assert.deepEqual(await projects.listForMember(OWNER), []);
    const hidden = await projects.findById(PROJECT);
    assert.equal(hidden?.deletedAt, 50n);
    assert.equal(hidden?.updatedAt, 50n);
    assert.equal(hidden?.memberships.length, 3);
    const row = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM projects WHERE id = $1",
      [PROJECT],
    );
    const members = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM project_memberships WHERE project_id = $1",
      [PROJECT],
    );
    assert.equal(row.rows[0]?.count, "1");
    assert.equal(members.rows[0]?.count, "3");
  });

  test("an update with a stale updated_at does not overwrite the row", async () => {
    const fresh = Project.create(OTHER, "Race", OWNER, instant(10n));
    await projects.save(fresh, null);
    const first = fresh.rename(OWNER, "One", instant(20n));
    const second = fresh.rename(OWNER, "Two", instant(30n));
    await projects.save(first, fresh.updatedAt);
    await assert.rejects(() => projects.save(second, fresh.updatedAt), ProjectConflict);
    const stored = await projects.findById(OTHER);
    assert.equal(stored?.name, "One");
    assert.equal(stored?.updatedAt, 20n);
  });

  test("admin is not a membership role", async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO project_memberships (project_id, user_id, role, created_at)
           VALUES ($1, $2, 'admin', 10)`,
          [OTHER, "018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f"],
        ),
      /project_memberships_role/,
    );
  });
});
