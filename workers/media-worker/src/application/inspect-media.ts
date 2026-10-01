/**
 * Inspect one stored MediaAsset.
 * US-129 will call this after a job is dequeued. It is not invoked by the API.
 */

import {
  DomainError,
  type IMediaProbe,
  type InspectionFailureCode,
  type Instant,
  type LoadedMediaInspection,
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
  loadForInspection(id: MediaAssetId): Promise<LoadedMediaInspection | null>;
  saveInspection(asset: MediaAsset, expectedRevision: bigint): Promise<void>;
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
  const loaded = await dependencies.media.loadForInspection(mediaAssetId);
  if (loaded === null || loaded.asset.storageKey === null) {
    throw new DomainError("MediaAsset was not found.");
  }
  const asset = loaded.asset;
  const storageKey = asset.storageKey;
  if (storageKey === null) {
    throw new DomainError("MediaAsset was not found.");
  }
  const expectedRevision = loaded.revision;
  let staged: StagedMediaFile | undefined;
  let inspected: MediaAsset | undefined;
  try {
    staged = await dependencies.staging.stage(storageKey);
    const result = await dependencies.probe.inspect({ filePath: staged.filePath });
    inspected = asset.recordInspection(result, dependencies.clock.now());
  } catch (error) {
    if (error instanceof MediaInspectionConflict) {
      throw error;
    }
    const failed = asset.recordInspectionFailure(failureCode(error), dependencies.clock.now());
    if (failed === asset) {
      return asset;
    }
    await dependencies.media.saveInspection(failed, expectedRevision);
    return failed;
  } finally {
    await staged?.release();
  }
  await dependencies.media.saveInspection(inspected, expectedRevision);
  return inspected;
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
