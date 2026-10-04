import {
  RefreshSession,
  type RefreshSessionRepository,
  User,
  type UserId,
  type UserRepository,
} from "@editagent/domain";
import { type Pool } from "pg";

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
         failed_login_count = EXCLUDED.failed_login_count,
         locked_until = EXCLUDED.locked_until,
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
