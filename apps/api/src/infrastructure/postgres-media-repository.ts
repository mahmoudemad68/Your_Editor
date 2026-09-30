import {
  MediaAsset,
  MediaAssetConflict,
  type MediaAssetId,
  type MediaAssetRepository,
  mediaAssetId,
  type MediaAssetSnapshot,
  type ProjectId,
} from "@editagent/domain";
import { type Pool } from "pg";

interface MediaAssetRow {
  id: string;
  project_id: string;
  kind: string;
  storage_key: string;
  display_filename: string;
  mime_type: string;
  byte_size: string;
  content_sha256: string;
  upload_state: string;
  duration: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `id::text AS id, project_id::text AS project_id, kind, storage_key,
  display_filename, mime_type, byte_size::text AS byte_size, content_sha256, upload_state,
  duration::text AS duration, created_at::text AS created_at, updated_at::text AS updated_at`;

export class PostgresMediaAssetRepository implements MediaAssetRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: MediaAssetId): Promise<MediaAsset | null> {
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT ${SELECT_COLUMNS} FROM media_assets WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if ((result.rowCount ?? 0) === 0 || row === undefined) {
      return null;
    }
    return MediaAsset.restore(toSnapshot(row));
  }

  async listByProject(projectId: ProjectId): Promise<readonly MediaAsset[]> {
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT ${SELECT_COLUMNS} FROM media_assets WHERE project_id = $1 ORDER BY created_at, id`,
      [projectId],
    );
    return result.rows.map((row) => MediaAsset.restore(toSnapshot(row)));
  }

  async save(asset: MediaAsset): Promise<void> {
    const snapshot = asset.toSnapshot();
    if (
      snapshot.storageKey == null ||
      snapshot.displayFilename == null ||
      snapshot.mimeType == null ||
      snapshot.byteSize == null ||
      snapshot.contentSha256 == null ||
      snapshot.uploadState == null
    ) {
      throw new Error("MediaAsset upload metadata is required.");
    }
    try {
      await this.pool.query(
        `INSERT INTO media_assets (
           id, project_id, kind, storage_key, display_filename, mime_type, byte_size,
           content_sha256, upload_state, duration, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          snapshot.id,
          snapshot.projectId,
          snapshot.kind,
          snapshot.storageKey,
          snapshot.displayFilename,
          snapshot.mimeType,
          instantText(snapshot.byteSize),
          snapshot.contentSha256,
          snapshot.uploadState,
          snapshot.duration === null ? null : instantText(snapshot.duration),
          instantText(snapshot.createdAt),
          instantText(snapshot.updatedAt),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MediaAssetConflict();
      }
      throw error;
    }
  }
}

function toSnapshot(row: MediaAssetRow): MediaAssetSnapshot {
  return {
    id: mediaAssetId(row.id),
    projectId: row.project_id,
    kind: row.kind,
    duration: row.duration,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    storageKey: row.storage_key,
    displayFilename: row.display_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    uploadState: row.upload_state,
  };
}

function instantText(value: bigint | string): string {
  return typeof value === "bigint" ? value.toString() : value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
