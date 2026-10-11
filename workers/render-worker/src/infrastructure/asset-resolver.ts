import type { Pool } from "pg";
import { uuidV7, type SourceSnapshot } from "@editagent/domain";
import { PermanentJobError } from "@editagent/job-queue";
import type { IRenderAssetResolver, ResolvedAsset } from "../application/ports.js";
/** Authorization is the durable Job project subject, never a URL or payload routing hint. */
export class PostgresRenderAssetResolver implements IRenderAssetResolver {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async resolve(
    project: string,
    sources: readonly SourceSnapshot[],
    signal: AbortSignal,
  ): Promise<ResolvedAsset[]> {
    uuidV7(project);
    if (sources.length > 128) throw new PermanentJobError("Too many render assets.");
    signal.throwIfAborted();
    const result = await this.pool.query<{
      id: string;
      kind: string;
      duration: string;
      storage_key: string;
      mime_type: string;
      content_sha256: string;
      byte_size: string;
      validation_source_sha256: string;
    }>(
      `SELECT a.id::text,a.kind,a.duration::text,a.storage_key,a.mime_type,a.content_sha256,a.byte_size::text,a.validation_source_sha256
       FROM media_assets a JOIN projects p ON p.id=a.project_id
       WHERE a.project_id=$1 AND p.deleted_at IS NULL AND a.id=ANY($2::uuid[])
         AND a.upload_state='uploaded' AND a.inspection_status='completed' AND a.validation_status='validated'`,
      [project, sources.map((s) => uuidV7(s.id))],
    );
    signal.throwIfAborted();
    const rows = new Map(result.rows.map((r) => [r.id, r]));
    let total = 0;
    return sources.map((source) => {
      const row = rows.get(source.id);
      const sha = row?.content_sha256 ?? "";
      const byteSize = Number(row?.byte_size);
      const expectedKey = `projects/${project}/media/sha256/${sha}`;
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
