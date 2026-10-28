import type { UserId, ProjectId, TimelineSnapshot } from "@editagent/domain";
export interface CaptionEditRequest {
  requestId: string;
  stateSha256: string;
  operation: "add-caption" | "update-caption-style";
  input: unknown;
}
export interface CaptionEditPort {
  source(
    actor: UserId,
    project: ProjectId,
    timeline: string,
    asset: string,
  ): Promise<{ assetId: string; sourceSha256: string; analysisSha256: string }>;
  execute(
    actor: UserId,
    project: ProjectId,
    timeline: string,
    request: CaptionEditRequest,
  ): Promise<{ timeline: TimelineSnapshot; stateSha256: string }>;
  undo(
    actor: UserId,
    project: ProjectId,
    timeline: string,
    command: string,
    stateSha256: string,
  ): Promise<{ timeline: TimelineSnapshot; stateSha256: string }>;
  history(
    actor: UserId,
    project: ProjectId,
    timeline: string,
  ): Promise<readonly { id: string; operation: string; status: string; createdAt: string }[]>;
}
/** Authenticated composition delegates to the fenced, audited command store. No LLM. */
export class TimelineCaptions {
  constructor(private readonly edits: CaptionEditPort) {}
  execute(...args: Parameters<CaptionEditPort["execute"]>) {
    return this.edits.execute(...args);
  }
  undo(...args: Parameters<CaptionEditPort["undo"]>) {
    return this.edits.undo(...args);
  }
  history(...args: Parameters<CaptionEditPort["history"]>) {
    return this.edits.history(...args);
  }
  source(...args: Parameters<CaptionEditPort["source"]>) {
    return this.edits.source(...args);
  }
}
