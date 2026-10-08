import { DerivedAsset, type MediaAssetId } from "@editagent/domain";
import type { Pool } from "pg";
import type { DerivedAssetReader } from "../application/media-library.js";

interface Row {
  id: string;
  media_asset_id: string;
  project_id: string;
  kind: string;
  storage_key: string;
  parameter_signature: string;
  mime_type: string;
  byte_size: string;
  content_sha256: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Independent API read adapter over the US-128 persisted records. */
export class PostgresDerivedAssetReader implements DerivedAssetReader {
  constructor(private readonly pool: Pool) {}

  async listByMediaAsset(id: MediaAssetId): Promise<readonly DerivedAsset[]> {
    const result = await this.pool.query<Row>(
      `SELECT id::text, media_asset_id::text, project_id::text, kind, storage_key,
        parameter_signature, mime_type, byte_size::text, content_sha256, metadata,
        created_at::text, updated_at::text
       FROM derived_assets WHERE media_asset_id = $1 AND kind IN ('proxy', 'thumbnail')
       ORDER BY created_at DESC, id DESC`,
      [id],
    );
    return result.rows.map((row) =>
      DerivedAsset.restore({
        id: row.id,
        mediaAssetId: row.media_asset_id,
        kind: row.kind,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        artifact: {
          projectId: row.project_id,
          storageKey: row.storage_key,
          parameterSignature: row.parameter_signature,
          mimeType: row.mime_type,
          byteSize: row.byte_size,
          sha256: row.content_sha256,
          metadata: row.metadata,
        },
      }),
    );
  }
}
