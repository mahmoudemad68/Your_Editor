import {
  type LoadedProject,
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
  revision: string;
}

interface MembershipRow {
  user_id: string;
  role: string;
  created_at: string;
}

/**
 * Optional pause after the Project row is read and before memberships are read.
 * Tests use it to prove both reads share one snapshot. Production does not set it.
 */
export type ProjectRowReadPause = () => Promise<void>;

/**
 * Postgres adapter for ProjectRepository.
 * Rows are restored through Project.restore. SQL does not decide membership rules.
 * revision is the compare-and-swap token. updatedAt stays an audit instant.
 */
export class PostgresProjectRepository implements ProjectRepository {
  constructor(
    private readonly pool: Pool,
    private readonly afterProjectRowRead?: ProjectRowReadPause,
  ) {}

  async findById(id: ProjectId): Promise<LoadedProject | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const project = await client.query<ProjectRow>(
        `SELECT id::text AS id, name, created_at::text AS created_at,
                updated_at::text AS updated_at, deleted_at::text AS deleted_at,
                revision::text AS revision
         FROM projects WHERE id = $1`,
        [id],
      );
      const row = project.rows[0];
      if ((project.rowCount ?? 0) === 0 || row === undefined) {
        await client.query("COMMIT");
        return null;
      }
      if (this.afterProjectRowRead !== undefined) {
        await this.afterProjectRowRead();
      }
      const memberships = await client.query<MembershipRow>(
        `SELECT user_id::text AS user_id, role, created_at::text AS created_at
         FROM project_memberships
         WHERE project_id = $1
         ORDER BY created_at, user_id`,
        [id],
      );
      const loaded = {
        project: Project.restore(toSnapshot(row, memberships.rows)),
        revision: BigInt(row.revision),
      };
      await client.query("COMMIT");
      return loaded;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    const seen = new Set<string>();
    for (const row of listed.rows) {
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      const loaded = await this.findById(projectId(row.id));
      if (loaded !== null && loaded.project.isListed() && loaded.project.roleOf(userId) !== null) {
        projects.push(loaded.project);
      }
    }
    return projects;
  }

  async save(project: Project, expectedRevision: bigint | null): Promise<void> {
    const snapshot = project.toSnapshot();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (expectedRevision === null) {
        await insertProject(client, snapshot);
      } else {
        await updateProject(client, snapshot, expectedRevision);
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
    `INSERT INTO projects (id, name, created_at, updated_at, deleted_at, revision)
     VALUES ($1, $2, $3, $4, $5, 0)`,
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
  expectedRevision: bigint,
): Promise<void> {
  const updated: QueryResult = await client.query(
    `UPDATE projects
     SET name = $2, updated_at = $3, deleted_at = $4, revision = revision + 1
     WHERE id = $1 AND revision = $5`,
    [
      snapshot.id,
      snapshot.name,
      instantText(snapshot.updatedAt),
      snapshot.deletedAt === null ? null : instantText(snapshot.deletedAt),
      expectedRevision.toString(),
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
