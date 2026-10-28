import type { Pool } from "pg";
import { parseMediaAnalysis } from "@editagent/schemas";
import { captionWords } from "@editagent/domain";
import { ToolError, contentHash, checkedId } from "../validation.js";
import type { CaptionEvidenceReader } from "../caption-tools.js";

/** Read persisted, current source-bound evidence. No inference, network or caller words. */
export class PostgresCaptionEvidence implements CaptionEvidenceReader {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async read(
    project: string,
    asset: string,
    sha: string,
    documentSha: string,
    signal: AbortSignal,
  ) {
    checkedId(project);
    checkedId(asset);
    signal.throwIfAborted();
    const row = (
      await this.pool.query<{ document: unknown; duration: string }>(
        `SELECT a.document,m.duration FROM media_analyses a JOIN media_assets m ON m.id=a.media_asset_id AND m.project_id=a.project_id
       WHERE a.project_id=$1 AND a.media_asset_id=$2 AND a.source_sha256=$3 AND m.content_sha256=$3
       AND m.validation_status='validated'`,
        [project, asset, sha],
      )
    ).rows[0];
    if (!row || contentHash(row.document) !== documentSha) throw new ToolError("invalid_subject");
    let document;
    try {
      document = parseMediaAnalysis(row.document);
    } catch {
      throw new ToolError("invalid_subject");
    }
    const transcript = document.sections.transcript;
    if (
      document.mediaAssetId !== asset ||
      document.source.sha256 !== sha ||
      document.source.durationUs !== row.duration ||
      transcript.status !== "completed" ||
      transcript.provenance.model?.name !== "faster-whisper-small"
    )
      throw new ToolError("invalid_subject");
    // The initial caption qualification accepts the existing pinned Small path only.
    // Tiny Arabic and unavailable/untrustworthy alignment never become fabricated captions.
    signal.throwIfAborted();
    return {
      version: document.schemaVersion,
      durationUs: row.duration,
      words: captionWords(
        transcript.data.segments.flatMap((s) =>
          s.words.map((w) => ({
            text: w.text,
            startUs: w.startUs,
            endUs: w.endUs,
            confidence: w.confidence ?? null,
          })),
        ),
        row.duration,
      ),
    };
  }
}
