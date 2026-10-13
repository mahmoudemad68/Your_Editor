import type { Pool } from "pg";
import { uuidV7, type SourceSnapshot } from "@editagent/domain";
import { PermanentJobError } from "@editagent/job-queue";
import type { IRenderAssetResolver, ResolvedAsset } from "../application/ports.js";
interface SourceRow {
  id: string;
  kind: string;
  duration: string;
  storage_key: string;
  mime_type: string;
  content_sha256: string;
  byte_size: string;
  validation_source_sha256: string;
  source_type?: string;
  root_media_id?: string;
  parameter_signature?: string;
  producer?: string;
}
/** Authorization is the durable Job project subject, never a URL or payload routing hint. */
export class PostgresRenderAssetResolver implements IRenderAssetResolver {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  private async rows(project: string, ids: readonly string[]) {
    uuidV7(project);
    for (const id of ids) uuidV7(id);
    return (
      await this.pool.query<SourceRow>(
        `SELECT a.id::text,a.kind,a.duration::text,a.storage_key,a.mime_type,a.content_sha256,a.byte_size::text,a.validation_source_sha256,
      'original' AS source_type,a.id::text AS root_media_id,NULL::text AS parameter_signature,NULL::text AS producer
      FROM media_assets a JOIN projects p ON p.id=a.project_id
      WHERE a.project_id=$1 AND p.deleted_at IS NULL AND a.id=ANY($2::uuid[])
        AND a.upload_state='uploaded' AND a.inspection_status='completed' AND a.validation_status='validated'
      UNION ALL SELECT d.id::text,'video',d.metadata->>'durationUs',d.storage_key,d.mime_type,d.content_sha256,d.byte_size::text,d.content_sha256,
        'edited-video',d.media_asset_id::text,d.parameter_signature,d.metadata->>'producer'
      FROM derived_assets d JOIN projects p ON p.id=d.project_id
      WHERE d.project_id=$1 AND p.deleted_at IS NULL AND d.id=ANY($2::uuid[]) AND d.kind='edited-video'`,
        [project, ids],
      )
    ).rows;
  }
  async sourceReferences(
    project: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<(SourceSnapshot & { rootMediaId: string })[]> {
    signal.throwIfAborted();
    if (ids.length < 1 || ids.length > 8)
      throw new PermanentJobError("Invalid editing source set.");
    const rows = await this.rows(project, ids),
      byId = new Map(rows.map((r) => [r.id, r]));
    if (rows.length !== byId.size) throw new PermanentJobError("Ambiguous source identity.");
    const sources = ids.map((id) => {
      const r = byId.get(id);
      if (
        !r ||
        r.kind !== "video" ||
        !r.duration ||
        !/^(0|[1-9][0-9]{0,9})$/.test(r.duration) ||
        BigInt(r.duration) <= 0n ||
        BigInt(r.duration) > 1800000000n ||
        !r.root_media_id
      )
        throw new PermanentJobError("Editing source is unavailable.");
      return { id, kind: "video" as const, durationUs: r.duration, rootMediaId: r.root_media_id };
    });
    await this.resolve(project, sources, signal);
    return sources;
  }
  async resolve(
    project: string,
    sources: readonly SourceSnapshot[],
    signal: AbortSignal,
  ): Promise<ResolvedAsset[]> {
    uuidV7(project);
    if (sources.length > 128) throw new PermanentJobError("Too many render assets.");
    signal.throwIfAborted();
    const result = {
      rows: await this.rows(
        project,
        sources.map((s) => s.id),
      ),
    };
    signal.throwIfAborted();
    const rows = new Map(result.rows.map((r) => [r.id, r]));
    if (rows.size !== result.rows.length) throw new PermanentJobError("Ambiguous render source.");
    let total = 0;
    return sources.map((source) => {
      const row = rows.get(source.id);
      const sha = row?.content_sha256 ?? "";
      const byteSize = Number(row?.byte_size);
      const edited = row?.source_type === "edited-video";
      const expectedKey = edited
        ? `projects/${project}/derived/${row?.root_media_id}/edited-video/${row?.parameter_signature}/${sha}.mp4`
        : `projects/${project}/media/sha256/${sha}`;
      const extensions: Record<string, string> = {
        "video/mp4": "mp4",
        "video/quicktime": "mp4",
        "video/x-matroska": "mp4",
        "video/webm": "mp4",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "image/png": "png",
        "image/jpeg": "jpg",
      };
      const extension = row && extensions[row.mime_type];
      total += byteSize;
      if (
        !row ||
        !extension ||
        row.kind !== source.kind ||
        row.duration !== source.durationUs ||
        !/^[a-f0-9]{64}$/.test(sha) ||
        row.validation_source_sha256 !== sha ||
        (edited &&
          (!row.root_media_id ||
            !/^[a-f0-9]{64}$/.test(row.parameter_signature ?? "") ||
            row.producer !== "ffmpeg-edit-v1")) ||
        row.storage_key !== expectedKey ||
        !Number.isSafeInteger(byteSize) ||
        byteSize < 1 ||
        total > 536870912
      )
        throw new PermanentJobError("Render asset is unavailable or untrusted.");
      return {
        sourceId: source.id,
        kind: source.kind,
        durationUs: source.durationUs,
        sha256: sha,
        byteSize,
        name: `${sha}.${extension}`,
        objectKey: expectedKey,
      };
    });
  }
}
