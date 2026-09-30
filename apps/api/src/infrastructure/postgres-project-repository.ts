import {
  type Instant,
  Project,
  ProjectConflict,
  projectId,
  type ProjectId,
  type ProjectRepository,
  type ProjectSnapshot,
  type UserId,
} from "@editagent/domain";
import { type Pool, type PoolClient, type QueryResult } from "pg";

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface MembershipRow {
  user_id: string;
  role: string;
  created_at: string;
}

/**
 * Postgres adapter for ProjectRepository.
 * Rows are restored through Project.restore. SQL does not decide membership rules.
 */
export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: ProjectId): Promise<Project | null> {
    const project = await this.pool.query<ProjectRow>(
      `SELECT id::text AS id, name, created_at::text AS created_at,
              updated_at::text AS updated_at, deleted_at::text AS deleted_at
       FROM projects WHERE id = $1`,
      [id],
    );
    const row = project.rows[0];
    if ((project.rowCount ?? 0) === 0 || row === undefined) {
      return null;
    }
    const memberships = await this.pool.query<MembershipRow>(
      `SELECT user_id::text AS user_id, role, created_at::text AS created_at
       FROM project_memberships
       WHERE project_id = $1
       ORDER BY created_at, user_id`,
      [id],
    );
    return Project.restore(toSnapshot(row, memberships.rows));
  }

  async listForMember(userId: UserId): Promise<readonly Project[]> {
    const listed = await this.pool.query<{ id: string }>(
      `SELECT p.id::text AS id
       FROM projects p
       JOIN project_memberships m ON m.project_id = p.id
       WHERE m.user_id = $1 AND p.deleted_at IS NULL
       ORDER BY p.created_at, p.id`,
      [userId],
    );
    const projects: Project[] = [];
    for (const row of listed.rows) {
      const project = await this.findById(projectId(row.id));
      if (project !== null && project.isListed() && project.roleOf(userId) !== null) {
        projects.push(project);
      }
    }
    return projects;
  }

  async save(project: Project, expectedUpdatedAt: Instant | null): Promise<void> {
    const snapshot = project.toSnapshot();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (expectedUpdatedAt === null) {
        await insertProject(client, snapshot);
      } else {
        await updateProject(client, snapshot, expectedUpdatedAt);
        await client.query("DELETE FROM project_memberships WHERE project_id = $1", [snapshot.id]);
      }
      await insertMemberships(client, snapshot);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw asConflict(error);
    } finally {
      client.release();
    }
  }
}

function toSnapshot(row: ProjectRow, memberships: readonly MembershipRow[]): ProjectSnapshot {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    memberships: memberships.map((membership) => ({
      userId: membership.user_id,
      role: membership.role,
      createdAt: membership.created_at,
    })),
  };
}

async function insertProject(client: PoolClient, snapshot: ProjectSnapshot): Promise<void> {
  await client.query(
    `INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      snapshot.id,
      snapshot.name,
      instantText(snapshot.createdAt),
      instantText(snapshot.updatedAt),
      snapshot.deletedAt === null ? null : instantText(snapshot.deletedAt),
    ],
  );
}

async function updateProject(
  client: PoolClient,
  snapshot: ProjectSnapshot,
  expectedUpdatedAt: Instant,
): Promise<void> {
  const updated: QueryResult = await client.query(
    `UPDATE projects
     SET name = $2, updated_at = $3, deleted_at = $4
     WHERE id = $1 AND updated_at = $5`,
    [
      snapshot.id,
      snapshot.name,
      instantText(snapshot.updatedAt),
      snapshot.deletedAt === null ? null : instantText(snapshot.deletedAt),
      expectedUpdatedAt.toString(),
    ],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new ProjectConflict();
  }
}

async function insertMemberships(client: PoolClient, snapshot: ProjectSnapshot): Promise<void> {
  for (const membership of snapshot.memberships) {
    await client.query(
      `INSERT INTO project_memberships (project_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4)`,
      [snapshot.id, membership.userId, membership.role, instantText(membership.createdAt)],
    );
  }
}

function instantText(value: bigint | string): string {
  return typeof value === "bigint" ? value.toString() : value;
}

function asConflict(error: unknown): unknown {
  if (isUniqueViolation(error)) {
    return new ProjectConflict();
  }
  return error;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
