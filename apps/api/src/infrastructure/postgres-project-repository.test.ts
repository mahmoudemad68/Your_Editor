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
const STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OTHER = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");
const STABLE = projectId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
const SAME_TIME = projectId("018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f");
const SNAPSHOT = projectId("018f6b6e-7c3a-7b2e-8d3e-9c0b1a2d3e4f");

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

async function installFailingMembershipTrigger(pool: Pool): Promise<void> {
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
}

async function dropFailingMembershipTrigger(pool: Pool): Promise<void> {
  await pool.query("DROP TRIGGER IF EXISTS editagent_fail_membership ON project_memberships");
  await pool.query("DROP FUNCTION IF EXISTS editagent_fail_membership()");
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
    assert.deepEqual(applied, [
      "0001_projects.sql",
      "0002_media_assets.sql",
      "0003_media_probe_metadata.sql",
      "0004_media_inspection_revision.sql",
      "0005_jobs.sql",
    ]);
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
    const revision = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'projects' AND column_name = 'revision'`,
    );
    assert.equal(revision.rowCount, 1);
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
    assert.equal(restored?.revision, 0n);
    assert.equal(restored?.project.id, PROJECT);
    assert.equal(restored?.project.name, "Launch");
    assert.equal(restored?.project.createdAt, 10n);
    assert.equal(restored?.project.updatedAt, 10n);
    assert.equal(restored?.project.deletedAt, null);
    assert.equal(restored?.project.roleOf(OWNER), "owner");
    assert.equal(restored?.project.memberships[0]?.createdAt, 10n);
    assert.equal(restored?.project.memberships.length, 1);
  });

  test("a failed membership insert rolls back the Project row", async () => {
    await installFailingMembershipTrigger(pool);
    try {
      const project = Project.create(OTHER, "Partial", OWNER, instant(10n));
      await assert.rejects(() => projects.save(project, null), /membership insert failed/);
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM projects WHERE id = $1",
        [OTHER],
      );
      assert.equal(count.rows[0]?.count, "0");
    } finally {
      await dropFailingMembershipTrigger(pool);
    }
  });

  test("rename, roles, listing, and soft delete round-trip without physical removal", async () => {
    const created = await projects.findById(PROJECT);
    assert.ok(created);
    const withEditor = created.project.grantMembership(OWNER, EDITOR, "editor", instant(20n));
    await projects.save(withEditor, created.revision);
    const edited = await projects.findById(PROJECT);
    const withViewer = edited!.project.grantMembership(OWNER, VIEWER, "viewer", instant(30n));
    await projects.save(withViewer, edited!.revision);
    const named = await projects.findById(PROJECT);
    const renamed = named!.project.rename(EDITOR, "Cut", instant(40n));
    await projects.save(renamed, named!.revision);

    const restored = await projects.findById(PROJECT);
    assert.equal(restored?.revision, 3n);
    assert.equal(restored?.project.name, "Cut");
    assert.equal(restored?.project.updatedAt, 40n);
    assert.equal(restored?.project.roleOf(OWNER), "owner");
    assert.equal(restored?.project.roleOf(EDITOR), "editor");
    assert.equal(restored?.project.roleOf(VIEWER), "viewer");
    assert.equal(restored?.project.memberships[1]?.createdAt, 20n);
    assert.equal(restored?.project.memberships[2]?.createdAt, 30n);

    const ownerList = await projects.listForMember(OWNER);
    const editorList = await projects.listForMember(EDITOR);
    assert.deepEqual(
      ownerList.map((project) => project.id),
      [PROJECT],
    );
    assert.deepEqual(
      editorList.map((project) => project.id),
      [PROJECT],
    );
    assert.equal(new Set(ownerList.map((project) => project.id)).size, ownerList.length);
    assert.deepEqual(await projects.listForMember(STRANGER), []);

    const deleted = restored!.project.deleteProject(OWNER, instant(50n));
    await projects.save(deleted, restored!.revision);
    assert.deepEqual(await projects.listForMember(OWNER), []);
    const hidden = await projects.findById(PROJECT);
    assert.equal(hidden?.project.deletedAt, 50n);
    assert.equal(hidden?.project.updatedAt, 50n);
    assert.equal(hidden?.project.memberships.length, 3);
    assert.equal(hidden?.revision, 4n);
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

  test("an update with a stale revision does not overwrite a later timestamp", async () => {
    const fresh = Project.create(OTHER, "Race", OWNER, instant(10n));
    await projects.save(fresh, null);
    const loaded = await projects.findById(OTHER);
    const first = loaded!.project.rename(OWNER, "One", instant(20n));
    const second = loaded!.project.rename(OWNER, "Two", instant(30n));
    await projects.save(first, loaded!.revision);
    await assert.rejects(() => projects.save(second, loaded!.revision), ProjectConflict);
    const stored = await projects.findById(OTHER);
    assert.equal(stored?.project.name, "One");
    assert.equal(stored?.project.updatedAt, 20n);
    assert.equal(stored?.revision, 1n);
  });

  test("two writes at the same updatedAt conflict on revision", async () => {
    const created = Project.create(SAME_TIME, "Original", OWNER, instant(10n));
    await projects.save(created, null);
    const left = await projects.findById(SAME_TIME);
    const right = await projects.findById(SAME_TIME);
    assert.equal(left?.revision, 0n);
    assert.equal(right?.revision, 0n);
    const one = left!.project.rename(OWNER, "One", instant(10n));
    const two = right!.project.rename(OWNER, "Two", instant(10n));
    assert.equal(one.updatedAt, 10n);
    assert.equal(two.updatedAt, 10n);
    await projects.save(one, left!.revision);
    await assert.rejects(() => projects.save(two, right!.revision), ProjectConflict);
    const stored = await projects.findById(SAME_TIME);
    assert.equal(stored?.project.name, "One");
    assert.equal(stored?.project.updatedAt, 10n);
    assert.equal(stored?.revision, 1n);
  });

  test("a failed membership rewrite rolls back the revision", async () => {
    const created = Project.create(STABLE, "Stable", OWNER, instant(10n));
    await projects.save(created, null);
    const before = await projects.findById(STABLE);
    assert.equal(before?.revision, 0n);
    await installFailingMembershipTrigger(pool);
    try {
      const renamed = before!.project.rename(OWNER, "Changed", instant(10n));
      await assert.rejects(
        () => projects.save(renamed, before!.revision),
        /membership insert failed/,
      );
    } finally {
      await dropFailingMembershipTrigger(pool);
    }
    const after = await projects.findById(STABLE);
    assert.equal(after?.revision, 0n);
    assert.equal(after?.project.name, "Stable");
    assert.equal(after?.project.updatedAt, 10n);
    assert.equal(after?.project.memberships.length, 1);
    assert.equal(after?.project.roleOf(OWNER), "owner");
    assert.equal(after?.project.memberships[0]?.createdAt, 10n);
  });

  test("a read paused across a commit does not mix Project and membership revisions", async () => {
    const created = Project.create(SNAPSHOT, "Original", OWNER, instant(20n));
    await projects.save(created, null);
    let releaseReader = (): void => undefined;
    const readerMayContinue = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let projectRowVisible = (): void => undefined;
    const projectRowSeen = new Promise<void>((resolve) => {
      projectRowVisible = resolve;
    });
    const reader = new PostgresProjectRepository(pool, async () => {
      projectRowVisible();
      await readerMayContinue;
    });
    const readPromise = reader.findById(SNAPSHOT);
    await projectRowSeen;
    const writerView = await projects.findById(SNAPSHOT);
    const next = writerView!.project.grantMembership(OWNER, EDITOR, "editor", instant(30n));
    await projects.save(next, writerView!.revision);
    releaseReader();
    const loaded = await readPromise;
    assert.ok(loaded);
    assert.equal(loaded.project.name, "Original");
    const oldSnapshot =
      loaded.revision === 0n &&
      loaded.project.updatedAt === 20n &&
      loaded.project.memberships.length === 1 &&
      loaded.project.roleOf(EDITOR) === null;
    const newSnapshot =
      loaded.revision === 1n &&
      loaded.project.updatedAt === 30n &&
      loaded.project.memberships.length === 2 &&
      loaded.project.roleOf(EDITOR) === "editor";
    assert.equal(oldSnapshot || newSnapshot, true);
    assert.equal(oldSnapshot, true);
  });

  test("admin is not a membership role", async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO project_memberships (project_id, user_id, role, created_at)
           VALUES ($1, $2, 'admin', 10)`,
          [OTHER, STRANGER],
        ),
      /project_memberships_role/,
    );
  });
});
