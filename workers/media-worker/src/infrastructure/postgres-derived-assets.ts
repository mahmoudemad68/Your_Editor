import { DerivedAsset, type MediaAssetId, type DerivedArtifact } from "@editagent/domain";
import { type Pool, type PoolClient } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "../application/derivative-plan.js";
import { type DerivationRepository, type DerivedAssetStore } from "../application/derive-media.js";
import { PostgresMediaInspectionRepository } from "./postgres-media-inspection-repository.js";

interface Row {
  id: string;
  media_asset_id: string;
  kind: string;
  project_id: string;
  storage_key: string;
  parameter_signature: string;
  mime_type: string;
  byte_size: string;
  content_sha256: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
type QueryConnection = Pick<Pool, "query"> | PoolClient;
/** Session advisory lock, autocommitted outputs, and one connection for every query.
 * Avoids nested pool acquisition while holding the generation lock (including max=1).
 */
export class PostgresDerivedAssets implements DerivationRepository {
  constructor(
    private readonly pool: Pool,
    private readonly connection: QueryConnection = pool,
  ) {}
  async loadSource(id: MediaAssetId, projectId: string) {
    const source = await new PostgresMediaInspectionRepository(this.connection).findById(id);
    return source?.projectId === projectId ? source : null;
  }
  async withSourceLock<T>(
    id: MediaAssetId,
    signal: AbortSignal,
    work: (store: DerivedAssetStore) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      while (!locked) {
        signal.throwIfAborted();
        const result = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 128)) AS locked",
          [id],
        );
        locked = result.rows[0]?.locked === true;
        if (!locked) await delay(50, undefined, { signal });
      }
      return await work(new PostgresDerivedAssets(this.pool, client));
    } finally {
      try {
        if (locked)
          await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 128))", [id]);
      } finally {
        client.release();
      }
    }
  }
  async findBySignature(
    id: MediaAssetId,
    kind: string,
    signature: string,
  ): Promise<DerivedAsset | null> {
    const rows = await this.connection.query<Row>(
      "SELECT * FROM derived_assets WHERE media_asset_id=$1 AND kind=$2 AND parameter_signature=$3",
      [id, kind, signature],
    );
    return rows.rows[0] === undefined ? null : restore(rows.rows[0]);
  }
  async listByMediaAsset(id: MediaAssetId, projectId: string): Promise<readonly DerivedAsset[]> {
    const rows = await this.connection.query<Row>(
      "SELECT * FROM derived_assets WHERE media_asset_id=$1 AND project_id=$2 ORDER BY kind, parameter_signature",
      [id, projectId],
    );
    return rows.rows.map(restore);
  }
  async save(asset: DerivedAsset): Promise<DerivedAsset> {
    const a = asset.artifact;
    if (a === null) throw new Error("A durable derived asset requires a stored artifact.");
    await this.connection.query(
      `INSERT INTO derived_assets (id,media_asset_id,project_id,kind,storage_key,parameter_signature,mime_type,byte_size,content_sha256,metadata,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
      ON CONFLICT (media_asset_id,kind,parameter_signature) DO NOTHING`,
      [
        asset.id,
        asset.mediaAssetId,
        a.projectId,
        asset.kind,
        a.storageKey,
        a.parameterSignature,
        a.mimeType,
        a.byteSize,
        a.sha256,
        JSON.stringify(a.metadata),
        asset.createdAt.toString(),
        asset.updatedAt.toString(),
      ],
    );
    const saved = await this.findBySignature(asset.mediaAssetId, asset.kind, a.parameterSignature);
    if (saved === null || canonicalJson(saved.artifact) !== canonicalJson(a))
      throw new Error("Derived artifact insertion conflict.");
    return saved;
  }
}
function restore(row: Row): DerivedAsset {
  const artifact: DerivedArtifact = {
    projectId: row.project_id,
    storageKey: row.storage_key,
    parameterSignature: row.parameter_signature,
    mimeType: row.mime_type,
    byteSize: row.byte_size.toString(),
    sha256: row.content_sha256,
    metadata: row.metadata,
  };
  return DerivedAsset.restore({
    id: row.id,
    mediaAssetId: row.media_asset_id,
    kind: row.kind,
    createdAt: row.created_at.toString(),
    updatedAt: row.updated_at.toString(),
    artifact,
  });
}
