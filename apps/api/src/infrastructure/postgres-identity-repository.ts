import {
  type ClearAttemptsResult,
  type FailedAttemptResult,
  RefreshSession,
  type RefreshRotation,
  type RefreshSessionRepository,
  type RotationDecision,
  User,
  type UserId,
  type UserRepository,
} from "@editagent/domain";
import { type Pool, type PoolClient } from "pg";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  operator_role: string | null;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  secret_hash: string;
  rotated_from_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: UserId): Promise<User | null> {
    const result = await this.pool.query<UserRow>(USER_SELECT + " WHERE id = $1", [id]);
    return result.rows[0] === undefined ? null : toUser(result.rows[0]);
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(USER_SELECT + " WHERE email = $1", [email]);
    return result.rows[0] === undefined ? null : toUser(result.rows[0]);
  }

  async save(user: User): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (
         id, email, password_hash, operator_role, failed_login_count, locked_until, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         operator_role = EXCLUDED.operator_role,
         updated_at = EXCLUDED.updated_at`,
      [
        user.id,
        user.email,
        user.passwordHash,
        user.operatorRole,
        user.failedLoginCount,
        instantText(user.lockedUntil),
        instantText(user.createdAt),
        instantText(user.updatedAt),
      ],
    );
  }

  async recordFailedAttempt(
    id: UserId,
    now: bigint,
    limit: number,
    lockForMs: bigint,
  ): Promise<FailedAttemptResult> {
    const updated = await this.pool.query(
      `UPDATE users
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= $2::integer THEN $3::bigint
             ELSE locked_until
           END,
           updated_at = $4::bigint
       WHERE id = $1
         AND (locked_until IS NULL OR locked_until <= $4::bigint)`,
      [id, limit, (now + lockForMs).toString(), now.toString()],
    );
    if ((updated.rowCount ?? 0) === 1) {
      return "recorded";
    }
    const existing = await this.pool.query("SELECT id FROM users WHERE id = $1", [id]);
    return (existing.rowCount ?? 0) === 1 ? "locked" : "missing";
  }

  async clearFailedAttempts(id: UserId, now: bigint): Promise<ClearAttemptsResult> {
    const updated = await this.pool.query(
      `UPDATE users
       SET failed_login_count = 0,
           locked_until = NULL,
           updated_at = $2::bigint
       WHERE id = $1
         AND (locked_until IS NULL OR locked_until <= $2::bigint)`,
      [id, now.toString()],
    );
    if ((updated.rowCount ?? 0) === 1) {
      return "cleared";
    }
    const existing = await this.pool.query("SELECT id FROM users WHERE id = $1", [id]);
    return (existing.rowCount ?? 0) === 1 ? "locked" : "missing";
  }
}

const USER_SELECT = `SELECT id::text AS id, email, password_hash, operator_role,
  failed_login_count, locked_until::text AS locked_until,
  created_at::text AS created_at, updated_at::text AS updated_at FROM users`;

function toUser(row: UserRow): User {
  return User.restore({
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    operatorRole: row.operator_role,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PostgresRefreshSessionRepository implements RefreshSessionRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<RefreshSession | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT id::text AS id, user_id::text AS user_id, secret_hash,
              rotated_from_id::text AS rotated_from_id, expires_at::text AS expires_at,
              revoked_at::text AS revoked_at, created_at::text AS created_at
       FROM refresh_sessions WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSession(row);
  }

  async save(session: RefreshSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_sessions (
         id, user_id, secret_hash, rotated_from_id, expires_at, revoked_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`,
      [
        session.id,
        session.userId,
        session.secretHash,
        session.rotatedFromId,
        instantText(session.expiresAt),
        instantText(session.revokedAt),
        instantText(session.createdAt),
      ],
    );
  }

  async revokeAllForUser(userId: UserId, revokedAt: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, instantText(revokedAt)],
    );
  }

  async rotate(
    sessionId: string,
    now: bigint,
    decide: (current: RefreshSession | null) => RotationDecision | Promise<RotationDecision>,
    beforeCommit?: (replacement: RefreshSession) => Promise<void>,
  ): Promise<RefreshRotation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const preview = await client.query<SessionRow>(SESSION_SELECT + " WHERE id = $1", [
        sessionId,
      ]);
      const owner = preview.rows[0]?.user_id;
      if (owner !== undefined) {
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [owner]);
      }
      const locked = await client.query<SessionRow>(SESSION_SELECT + " WHERE id = $1", [sessionId]);
      const current = locked.rows[0] === undefined ? null : toSession(locked.rows[0]);
      const decision = await decide(current);
      if (decision.action === "reject" || current === null) {
        await client.query("COMMIT");
        return { outcome: "rejected" };
      }
      if (decision.action === "reuse" || !current.isActive(now)) {
        await revokeActive(client, current.userId, now);
        await client.query("COMMIT");
        return { outcome: "reused", userId: current.userId };
      }
      if (
        decision.replacement.userId !== current.userId ||
        decision.replacement.rotatedFromId !== current.id
      ) {
        throw new Error("Replacement session does not continue the presented session.");
      }
      const consumed = await client.query(
        `UPDATE refresh_sessions
         SET revoked_at = $2::bigint
         WHERE id = $1 AND revoked_at IS NULL AND expires_at > $2::bigint`,
        [current.id, now.toString()],
      );
      if ((consumed.rowCount ?? 0) !== 1) {
        await revokeActive(client, current.userId, now);
        await client.query("COMMIT");
        return { outcome: "reused", userId: current.userId };
      }
      await insertSession(client, decision.replacement);
      await beforeCommit?.(decision.replacement);
      await client.query("COMMIT");
      return { outcome: "consumed", userId: current.userId, replacement: decision.replacement };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const SESSION_SELECT = `SELECT id::text AS id, user_id::text AS user_id, secret_hash,
  rotated_from_id::text AS rotated_from_id, expires_at::text AS expires_at,
  revoked_at::text AS revoked_at, created_at::text AS created_at
  FROM refresh_sessions`;

async function revokeActive(client: PoolClient, userId: UserId, revokedAt: bigint): Promise<void> {
  await client.query(
    `UPDATE refresh_sessions SET revoked_at = $2::bigint WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, revokedAt.toString()],
  );
}

async function insertSession(client: PoolClient, session: RefreshSession): Promise<void> {
  await client.query(
    `INSERT INTO refresh_sessions (
       id, user_id, secret_hash, rotated_from_id, expires_at, revoked_at, created_at
     ) VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7::bigint)`,
    [
      session.id,
      session.userId,
      session.secretHash,
      session.rotatedFromId,
      session.expiresAt.toString(),
      instantText(session.revokedAt),
      session.createdAt.toString(),
    ],
  );
}

function instantText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function toSession(row: SessionRow): RefreshSession {
  return RefreshSession.restore({
    id: row.id,
    userId: row.user_id,
    secretHash: row.secret_hash,
    rotatedFromId: row.rotated_from_id,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  });
}
