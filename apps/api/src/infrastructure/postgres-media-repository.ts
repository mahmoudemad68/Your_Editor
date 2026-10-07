import {
  MediaAsset,
  MediaAssetConflict,
  type MediaAssetId,
  type MediaAssetRepository,
  mediaAssetId,
  MediaInspectionConflict,
  type LoadedMediaInspection,
  type MediaAssetSnapshot,
  type MediaStreamMetadata,
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
  inspection_status: string;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  display_width: number | null;
  display_height: number | null;
  rotation: number | null;
  frame_rate_numerator: string | null;
  frame_rate_denominator: string | null;
  frame_rate_mode: string | null;
  color_space: string | null;
  audio_channels: number | null;
  sample_rate: number | null;
  streams: unknown;
  inspection_error: string | null;
  inspection_revision: string;
  validation_status: string;
  validation_policy_signature: string | null;
  validation_source_sha256: string | null;
  validation_checked_at: string | null;
  validation_rejection_code: string | null;
}

const SELECT_COLUMNS = `id::text AS id, project_id::text AS project_id, kind, storage_key,
  display_filename, mime_type, byte_size::text AS byte_size, content_sha256, upload_state,
  duration::text AS duration, created_at::text AS created_at, updated_at::text AS updated_at,
  inspection_status, container, video_codec, audio_codec, width, height, display_width,
  display_height, rotation, frame_rate_numerator::text AS frame_rate_numerator,
  frame_rate_denominator::text AS frame_rate_denominator, frame_rate_mode, color_space,
  audio_channels, sample_rate, streams, inspection_error,
  inspection_revision::text AS inspection_revision, validation_status, validation_policy_signature, validation_source_sha256, validation_checked_at::text AS validation_checked_at, validation_rejection_code`;

export class PostgresMediaAssetRepository implements MediaAssetRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: MediaAssetId): Promise<MediaAsset | null> {
    const row = await this.findRow(id);
    return row === null ? null : MediaAsset.restore(toSnapshot(row));
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

  async loadForInspection(id: MediaAssetId): Promise<LoadedMediaInspection | null> {
    const row = await this.findRow(id);
    if (row === null) {
      return null;
    }
    return {
      asset: MediaAsset.restore(toSnapshot(row)),
      revision: BigInt(row.inspection_revision),
    };
  }

  async saveInspection(asset: MediaAsset, expectedRevision: bigint): Promise<void> {
    const snapshot = asset.toSnapshot();
    const result = await this.pool.query(
      `UPDATE media_assets SET
         inspection_revision = inspection_revision + 1,
         duration = $2,
         updated_at = $3,
         inspection_status = $4,
         container = $5,
         video_codec = $6,
         audio_codec = $7,
         width = $8,
         height = $9,
         display_width = $10,
         display_height = $11,
         rotation = $12,
         frame_rate_numerator = $13,
         frame_rate_denominator = $14,
         frame_rate_mode = $15,
         color_space = $16,
         audio_channels = $17,
         sample_rate = $18,
         streams = $19::jsonb,
         inspection_error = $20, validation_status = 'pending', validation_policy_signature = NULL, validation_source_sha256 = NULL, validation_checked_at = NULL, validation_rejection_code = NULL
       WHERE id = $1 AND inspection_revision = $21`,
      inspectionParameters(snapshot, expectedRevision),
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new MediaInspectionConflict();
    }
  }

  private async findRow(id: MediaAssetId): Promise<MediaAssetRow | null> {
    const result = await this.pool.query<MediaAssetRow>(
      `SELECT ${SELECT_COLUMNS} FROM media_assets WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if ((result.rowCount ?? 0) === 0 || row === undefined) {
      return null;
    }
    return row;
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
    inspectionStatus: row.inspection_status,
    container: row.container,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: row.width,
    height: row.height,
    displayWidth: row.display_width,
    displayHeight: row.display_height,
    rotation: row.rotation,
    frameRateNumerator: row.frame_rate_numerator,
    frameRateDenominator: row.frame_rate_denominator,
    frameRateMode: row.frame_rate_mode,
    colorSpace: row.color_space,
    audioChannels: row.audio_channels,
    sampleRate: row.sample_rate,
    streams: streamsFromRow(row.streams),
    inspectionError: row.inspection_error,
    validation: {
      status: row.validation_status,
      policySignature: row.validation_policy_signature,
      sourceSha256: row.validation_source_sha256,
      checkedAt: row.validation_checked_at,
      rejectionCode: row.validation_rejection_code,
    },
  };
}

function inspectionParameters(snapshot: MediaAssetSnapshot, expectedRevision: bigint): unknown[] {
  return [
    snapshot.id,
    snapshot.duration === null ? null : instantText(snapshot.duration),
    instantText(snapshot.updatedAt),
    snapshot.inspectionStatus ?? "pending",
    snapshot.container ?? null,
    snapshot.videoCodec ?? null,
    snapshot.audioCodec ?? null,
    snapshot.width ?? null,
    snapshot.height ?? null,
    snapshot.displayWidth ?? null,
    snapshot.displayHeight ?? null,
    snapshot.rotation ?? null,
    snapshot.frameRateNumerator == null ? null : instantText(snapshot.frameRateNumerator),
    snapshot.frameRateDenominator == null ? null : instantText(snapshot.frameRateDenominator),
    snapshot.frameRateMode ?? null,
    snapshot.colorSpace ?? null,
    snapshot.audioChannels ?? null,
    snapshot.sampleRate ?? null,
    snapshot.streams == null ? null : JSON.stringify(snapshot.streams),
    snapshot.inspectionError ?? null,
    expectedRevision.toString(),
  ];
}

function streamsFromRow(value: unknown): readonly MediaStreamMetadata[] | null {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("MediaAsset stream metadata is not an array.");
  }
  return value as readonly MediaStreamMetadata[];
}

function instantText(value: bigint | string): string {
  return typeof value === "bigint" ? value.toString() : value;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
