/**
 * Inspect one stored MediaAsset.
 * US-129 will call this after a job is dequeued. It is not invoked by the API.
 */

import {
  DomainError,
  type IMediaProbe,
  type InspectionFailureCode,
  type Instant,
  type MediaAsset,
  type MediaAssetId,
  MediaInspectionConflict,
  MediaProbeError,
} from "@editagent/domain";

export interface InspectionClock {
  now(): Instant;
}

export interface StagedMediaFile {
  readonly filePath: string;
  release(): Promise<void>;
}

/** Streams an object to a controlled temporary file. It does not return the bytes. */
export interface MediaObjectStaging {
  stage(storageKey: string): Promise<StagedMediaFile>;
}

export interface MediaInspectionRepository {
  findById(id: MediaAssetId): Promise<MediaAsset | null>;
  saveInspection(asset: MediaAsset, expectedUpdatedAt: Instant): Promise<void>;
}

export async function inspectMediaAsset(
  mediaAssetId: MediaAssetId,
  dependencies: {
    readonly media: MediaInspectionRepository;
    readonly staging: MediaObjectStaging;
    readonly probe: IMediaProbe;
    readonly clock: InspectionClock;
  },
): Promise<MediaAsset> {
  const asset = await dependencies.media.findById(mediaAssetId);
  if (asset === null || asset.storageKey === null) {
    throw new DomainError("MediaAsset was not found.");
  }
  const observed = asset.updatedAt;
  let staged: StagedMediaFile | undefined;
  try {
    staged = await dependencies.staging.stage(asset.storageKey);
    const result = await dependencies.probe.inspect({ filePath: staged.filePath });
    const next = asset.recordInspection(result, dependencies.clock.now());
    await dependencies.media.saveInspection(next, observed);
    return next;
  } catch (error) {
    if (error instanceof MediaInspectionConflict) {
      throw error;
    }
    const failed = asset.recordInspectionFailure(failureCode(error), dependencies.clock.now());
    if (failed === asset) {
      return asset;
    }
    await dependencies.media.saveInspection(failed, observed);
    return failed;
  } finally {
    await staged?.release();
  }
}

function failureCode(error: unknown): InspectionFailureCode {
  if (error instanceof MediaProbeError) {
    return error.code;
  }
  if (error instanceof DomainError) {
    return "invalid_result";
  }
  return "exit";
}
