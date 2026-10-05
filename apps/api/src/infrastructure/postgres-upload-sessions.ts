import {
  type UploadSessionRepository,
  type UploadSession,
  type UploadPart,
  type LockedUpload,
  type ProjectId,
  type UserId,
  projectId,
  userId,
  mediaAssetId,
} from "@editagent/domain";
import type { Pool } from "pg";
import { UploadObjectMismatch } from "../application/upload-errors.js";

type SessionRow = {
  id: string;
  project_id: string;
  user_id: string;
  storage_key: string;
  multipart_upload_id: string;
  filename: string;
  mime_type: string;
  byte_size: string;
  sha256: string;
  part_size: number;
  status: UploadSession["status"];
  media_asset_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};
type PartRow = {
  upload_session_id: string;
  part_number: number;
  etag: string;
  byte_size: string;
  checksum: string | null;
  completed_at: string;
};
// Actions hold an advisory-lock connection and may call other repositories.
// Reserve pool capacity for those calls; share the gate across repository instances.
const gates = new WeakMap<Pool, { active: number; limit: number; waiters: (() => void)[] }>();
async function reserve(pool: Pool): Promise<() => void> {
  const gate = gates.get(pool)!;
  if (gate.active < gate.limit) gate.active++;
  else await new Promise<void>((resolve) => gate.waiters.push(resolve));
  return () => {
    const next = gate.waiters.shift();
    if (next) next();
    else gate.active--;
  };
}
export class PostgresUploadSessionRepository implements UploadSessionRepository {
  constructor(private readonly pool: Pool) {
    const max = pool.options.max ?? 10;
    if (max < 2) throw new Error("Multipart requires at least two PostgreSQL pool connections.");
    if (!gates.has(pool)) gates.set(pool, { active: 0, limit: Math.min(4, max - 1), waiters: [] });
  }
  async create(s: UploadSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO upload_sessions(id,project_id,user_id,storage_key,multipart_upload_id,filename,mime_type,byte_size,sha256,part_size,status,media_asset_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        s.id,
        s.projectId,
        s.userId,
        s.storageKey,
        s.multipartUploadId,
        s.filename,
        s.mimeType,
        s.byteSize,
        s.sha256,
        s.partSize,
        s.status,
        s.mediaAssetId,
        s.expiresAt.toString(),
        s.createdAt.toString(),
        s.updatedAt.toString(),
      ],
    );
  }
  async findReusable(project: ProjectId, actor: UserId, sha256: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM upload_sessions WHERE project_id=$1 AND user_id=$2 AND sha256=$3 AND status IN ('active','completing','completed') ORDER BY created_at DESC LIMIT 1`,
      [project, actor, sha256],
    );
    return result.rows[0]?.id ?? null;
  }
  async withSession<T>(
    id: string,
    action: (upload: LockedUpload | null) => Promise<T>,
  ): Promise<T> {
    const release = await reserve(this.pool);
    try {
      return await this.locked(id, action);
    } finally {
      release();
    }
  }
  private async locked<T>(
    id: string,
    action: (upload: LockedUpload | null) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      // Session advisory lock survives the short writes below, including a crash
      // between provider completion and MediaAsset publication. No long transaction.
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,123))", [id]);
      const loaded = await client.query<SessionRow>("SELECT * FROM upload_sessions WHERE id=$1", [
        id,
      ]);
      const row = loaded.rows[0];
      if (!row) return await action(null);
      const session: UploadSession = {
        id: row.id,
        projectId: projectId(row.project_id),
        userId: userId(row.user_id),
        storageKey: row.storage_key,
        multipartUploadId: row.multipart_upload_id,
        filename: row.filename,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        partSize: row.part_size,
        status: row.status,
        mediaAssetId: row.media_asset_id === null ? null : mediaAssetId(row.media_asset_id),
        expiresAt: BigInt(row.expires_at),
        createdAt: BigInt(row.created_at),
        updatedAt: BigInt(row.updated_at),
      };
      const rows = await client.query<PartRow>(
        "SELECT * FROM upload_parts WHERE upload_session_id=$1 ORDER BY part_number",
        [id],
      );
      const parts: UploadPart[] = rows.rows.map((p) => ({
        uploadSessionId: id,
        partNumber: p.part_number,
        etag: p.etag,
        byteSize: Number(p.byte_size),
        checksum: p.checksum,
        completedAt: BigInt(p.completed_at),
      }));
      const save = async () => {
        await client.query(
          "UPDATE upload_sessions SET status=$2,media_asset_id=$3,updated_at=$4,completed_part_count=(SELECT count(*) FROM upload_parts WHERE upload_session_id=$1) WHERE id=$1",
          [id, session.status, session.mediaAssetId, session.updatedAt.toString()],
        );
      };
      return await action({
        session,
        parts,
        save,
        record: async (part) => {
          if (session.status !== "active") throw new UploadObjectMismatch();
          const previous = parts.find((p) => p.partNumber === part.partNumber);
          if (previous) {
            if (
              previous.etag !== part.etag ||
              previous.byteSize !== part.byteSize ||
              previous.checksum !== part.checksum
            )
              throw new UploadObjectMismatch();
            return;
          }
          await client.query(
            "INSERT INTO upload_parts(upload_session_id,part_number,etag,byte_size,checksum,completed_at) VALUES($1,$2,$3,$4,$5,$6)",
            [
              id,
              part.partNumber,
              part.etag,
              part.byteSize,
              part.checksum,
              part.completedAt.toString(),
            ],
          );
          parts.push(part);
          await save();
        },
      });
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1,123))", [id]);
      } finally {
        client.release();
      }
    }
  }
  async expired(now: bigint, limit: number): Promise<readonly string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM upload_sessions WHERE status IN ('active','completing') AND expires_at<=$1 ORDER BY expires_at LIMIT $2`,
      [now.toString(), limit],
    );
    return result.rows.map((s) => s.id);
  }
}
