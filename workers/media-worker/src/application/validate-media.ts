import {
  type Instant,
  type MediaAsset,
  type MediaAssetId,
  type MediaRejectionCode,
  type ProbeResult,
} from "@editagent/domain";
import { type MediaInspectionRepository, type MediaObjectStaging } from "./inspect-media.js";
import { PermanentJobError } from "./job-errors.js";

export class MediaRejected extends Error {
  constructor(readonly code: MediaRejectionCode) {
    super(`Media validation rejected: ${code}.`);
  }
}
export interface MediaValidator {
  readonly policySignature: string;
  readonly maxBytes: number;
  validate(filePath: string, signal: AbortSignal): Promise<ProbeResult>;
}
/** Transient staging/process setup/DB failures propagate for US-129 retry. Only
 * typed media rejection is durable; cancellation never records a false verdict. */
export async function validateMediaAsset(
  id: MediaAssetId,
  signal: AbortSignal,
  deps: {
    readonly media: MediaInspectionRepository;
    readonly staging: MediaObjectStaging;
    readonly validator: MediaValidator;
    readonly now: () => Instant;
  },
): Promise<MediaAsset> {
  signal.throwIfAborted();
  const loaded = await deps.media.loadForInspection(id);
  if (loaded === null || loaded.asset.storageKey === null)
    throw new PermanentJobError("Media source was not found.");
  const asset = loaded.asset;
  let result: MediaAsset;
  try {
    if (asset.byteSize !== null && asset.byteSize > BigInt(deps.validator.maxBytes))
      throw new MediaRejected("file_size_limit_exceeded");
    const staged = await deps.staging.stage(loaded.asset.storageKey, signal);
    try {
      if (staged.contentSha256 === undefined || staged.contentSha256 !== asset.contentSha256)
        throw new MediaRejected("source_identity_mismatch");
      const probe = await deps.validator.validate(staged.filePath, signal);
      const at = deps.now();
      result = asset
        .recordInspection(probe, at)
        .recordValidation(deps.validator.policySignature, null, at);
    } finally {
      await staged.release();
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof MediaRejected)) throw error;
    const at = deps.now();
    result = asset
      .recordInspectionFailure("invalid_result", at)
      .recordValidation(deps.validator.policySignature, error.code, at);
  }
  signal.throwIfAborted();
  await deps.media.saveInspection(result, loaded.revision);
  return result;
}
export function assertValidatedMedia(
  asset: MediaAsset,
  policySignature: string,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (
    asset.validation.status !== "validated" ||
    asset.validation.policySignature !== policySignature ||
    asset.validation.sourceSha256 !== asset.contentSha256 ||
    asset.inspectionStatus !== "completed"
  )
    throw new PermanentJobError(
      "Media requires current hostile-file validation before derivation.",
    );
}
