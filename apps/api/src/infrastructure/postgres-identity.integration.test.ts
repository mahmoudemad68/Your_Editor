import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createUuidV7, instant, RefreshSession, User, userId } from "@editagent/domain";
import { Pool } from "pg";
import { Argon2idHasher } from "./argon2id-hasher.js";
import { applyMigrations } from "./migrate.js";
import {
  PostgresRefreshSessionRepository,
  PostgresUserRepository,
} from "./postgres-identity-repository.js";

const TEST_DATABASE = "editagent_us118";

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

function newId(): string {
  return createUuidV7(1_700_000_000_000, randomBytes(10));
}

describe("Postgres identity", { concurrency: 1 }, () => {
  let pool: Pool;
  let users: PostgresUserRepository;
  let sessions: PostgresRefreshSessionRepository;

  before(async () => {
    const admin = new Pool({ connectionString: adminUrl() });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    await admin.end();
    pool = new Pool({ connectionString: withDatabase(adminUrl(), TEST_DATABASE) });
    await applyMigrations(pool);
    users = new PostgresUserRepository(pool);
    sessions = new PostgresRefreshSessionRepository(pool);
  });

  after(async () => {
    await pool.end();
  });

  test("registration persists an argon2id hash and rejects plaintext", async () => {
    const hasher = new Argon2idHasher();
    const password = "correct-horse-battery";
    const id = userId(newId());
    const created = User.create(
      id,
      "Owner@Example.test",
      await hasher.hash(password),
      instant(10n),
    );
    await users.save(created.recordFailedLogin(instant(11n), 5, 100n));
    const stored = await users.findByEmail("owner@example.test");
    assert.ok(stored);
    assert.equal(stored.id, id);
    assert.equal(stored.passwordHash.startsWith("$argon2id$"), true);
    assert.equal(stored.passwordHash.includes(password), false);
    assert.equal(stored.failedLoginCount, 1);
    assert.equal(await hasher.verify(stored.passwordHash, password), true);
    const raw = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [id],
    );
    assert.equal(raw.rows[0]?.password_hash, stored.passwordHash);
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO users (id, email, password_hash, failed_login_count, created_at, updated_at)
           VALUES ($1, 'plain@example.test', 'plaintext-password', 0, 10, 10)`,
          [newId()],
        ),
      /users_password_argon2id/,
    );
  });

  test("a refresh session stores the secret hash and revocation covers the account", async () => {
    const owner = await users.findByEmail("owner@example.test");
    assert.ok(owner);
    const session = RefreshSession.issue(
      newId(),
      owner.id,
      "a".repeat(64),
      instant(10n),
      instant(40n),
      null,
    );
    await sessions.save(session);
    const restored = await sessions.findById(session.id);
    assert.equal(restored?.secretHash, session.secretHash);
    assert.equal(restored?.isActive(instant(20n)), true);
    await sessions.revokeAllForUser(owner.id, instant(30n));
    const revoked = await sessions.findById(session.id);
    assert.equal(revoked?.revokedAt, 30n);
    assert.equal(revoked?.isActive(instant(30n)), false);
  });

  test("a membership cannot name an account that was never registered", async () => {
    const projectId = newId();
    await pool.query(
      `INSERT INTO projects (id, name, created_at, updated_at) VALUES ($1, 'Launch', 10, 10)`,
      [projectId],
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO project_memberships (project_id, user_id, role, created_at)
           VALUES ($1, $2, 'owner', 10)`,
          [projectId, newId()],
        ),
      /project_memberships_user_id_fkey/,
    );
  });
});
