/**
 * Media inspection port. The FFprobe process lives in packages/media-core.
 * Application code depends on this module, not on the subprocess adapter.
 * The roadmap text that places IMediaProbe inside media-core is reconciled
 * in docs/architecture/ports-and-adapters.md: a port in media-core would force
 * application code to import an infrastructure package.
 */

import { DomainError } from "../../kernel/error.js";
import { type FrameRate, frameRate, type Microseconds, microseconds } from "../../kernel/time.js";

export const INSPECTION_FAILURE_CODES = [
  "timeout",
  "not_found",
  "exit",
  "invalid_json",
  "invalid_result",
  "object_missing",
  "interrupted",
  "insufficient_storage",
] as const;

export type InspectionFailureCode = (typeof INSPECTION_FAILURE_CODES)[number];
export type InspectionStatus = "pending" | "completed" | "failed";
export type FrameRateMode = "constant" | "variable" | "unknown";

export interface MediaStreamMetadata {
  readonly codecType: "video" | "audio";
  readonly codecName: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
}

/** Technical metadata. This is not FFprobe's JSON document. */
export interface ProbeResult {
  readonly container: string | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  readonly rotation: number | null;
  readonly frameRate: FrameRate | null;
  readonly frameRateMode: FrameRateMode;
  readonly duration: Microseconds | null;
  readonly colorSpace: string | null;
  readonly audioChannels: number | null;
  readonly sampleRate: number | null;
  readonly streams: readonly MediaStreamMetadata[];
}

export interface ProbeInput {
  readonly filePath: string;
}

export interface IMediaProbe {
  inspect(input: ProbeInput): Promise<ProbeResult>;
}

/** A controlled probe or staging failure. The message never includes process output. */
export class MediaProbeError extends DomainError {
  readonly code: InspectionFailureCode;

  constructor(code: InspectionFailureCode) {
    super("Media inspection failed.");
    this.name = "MediaProbeError";
    this.code = inspectionFailureCode(code);
  }
}

export interface InspectionState {
  readonly status: InspectionStatus;
  readonly container: string | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  readonly rotation: number | null;
  readonly frameRateNumerator: bigint | null;
  readonly frameRateDenominator: bigint | null;
  readonly frameRateMode: FrameRateMode | null;
  readonly colorSpace: string | null;
  readonly audioChannels: number | null;
  readonly sampleRate: number | null;
  readonly streams: readonly MediaStreamMetadata[] | null;
  readonly error: InspectionFailureCode | null;
}

export interface InspectionSnapshotFields {
  readonly inspectionStatus?: string | null;
  readonly container?: string | null;
  readonly videoCodec?: string | null;
  readonly audioCodec?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly displayWidth?: number | null;
  readonly displayHeight?: number | null;
  readonly rotation?: number | null;
  readonly frameRateNumerator?: bigint | string | null;
  readonly frameRateDenominator?: bigint | string | null;
  readonly frameRateMode?: string | null;
  readonly colorSpace?: string | null;
  readonly audioChannels?: number | null;
  readonly sampleRate?: number | null;
  readonly streams?: readonly MediaStreamMetadata[] | null;
  readonly inspectionError?: string | null;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;
const POSTGRES_INTEGER_MAX = 2147483647;

export function inspectionFailureCode(value: string): InspectionFailureCode {
  if ((INSPECTION_FAILURE_CODES as readonly string[]).includes(value)) {
    return value as InspectionFailureCode;
  }
  throw new DomainError("Inspection failure code is not recognized.");
}

export function pendingInspection(): InspectionState {
  return emptyInspection("pending", null);
}

export function completedInspection(result: ProbeResult): InspectionState {
  const container = optionalToken(result.container, "Container");
  const videoCodec = optionalToken(result.videoCodec, "Video codec");
  const audioCodec = optionalToken(result.audioCodec, "Audio codec");
  const width = optionalDimension(result.width, "Width");
  const height = optionalDimension(result.height, "Height");
  const displayWidth = optionalDimension(result.displayWidth, "Display width");
  const displayHeight = optionalDimension(result.displayHeight, "Display height");
  const rotation = optionalRotation(result.rotation);
  assertDimensionSet(width, height, displayWidth, displayHeight, rotation);
  const rate = optionalFrameRate(result.frameRate);
  const mode = frameRateMode(result.frameRateMode);
  probeDuration(result.duration);
  const colorSpace = optionalToken(result.colorSpace, "Color space");
  const audioChannels = optionalCount(result.audioChannels, "Audio channels", 64);
  const sampleRate = optionalCount(result.sampleRate, "Sample rate", 1_000_000);
  const streams = normalizeStreams(result.streams);
  if (streams.length === 0) {
    throw new DomainError("Completed inspection requires stream metadata.");
  }
  return {
    status: "completed",
    container,
    videoCodec,
    audioCodec,
    width,
    height,
    displayWidth,
    displayHeight,
    rotation,
    frameRateNumerator: rate?.numerator ?? null,
    frameRateDenominator: rate?.denominator ?? null,
    frameRateMode: mode,
    colorSpace,
    audioChannels,
    sampleRate,
    streams: Object.freeze(streams),
    error: null,
  };
}

export function failedInspection(code: InspectionFailureCode): InspectionState {
  return emptyInspection("failed", inspectionFailureCode(code));
}

export function inspectionFromSnapshot(snapshot: InspectionSnapshotFields): InspectionState {
  const status = snapshot.inspectionStatus ?? null;
  const technical = technicalPresence(snapshot);
  if (status === null || status === "pending") {
    if (technical || isPresent(snapshot.inspectionError) || isPresent(snapshot.frameRateMode)) {
      throw new DomainError("Pending inspection cannot store technical metadata.");
    }
    return pendingInspection();
  }
  if (status === "failed") {
    if (technical || isPresent(snapshot.frameRateMode)) {
      throw new DomainError("Failed inspection cannot store technical metadata.");
    }
    if (!isPresent(snapshot.inspectionError) || snapshot.inspectionError == null) {
      throw new DomainError("Failed inspection requires a failure code.");
    }
    return failedInspection(inspectionFailureCode(snapshot.inspectionError));
  }
  if (status !== "completed") {
    throw new DomainError("Inspection status must be pending, completed, or failed.");
  }
  if (isPresent(snapshot.inspectionError)) {
    throw new DomainError("Completed inspection cannot store a failure code.");
  }
  return completedInspection({
    container: snapshot.container ?? null,
    videoCodec: snapshot.videoCodec ?? null,
    audioCodec: snapshot.audioCodec ?? null,
    width: snapshot.width ?? null,
    height: snapshot.height ?? null,
    displayWidth: snapshot.displayWidth ?? null,
    displayHeight: snapshot.displayHeight ?? null,
    rotation: snapshot.rotation ?? null,
    frameRate: frameRateFromSnapshot(snapshot.frameRateNumerator, snapshot.frameRateDenominator),
    frameRateMode: frameRateMode(snapshot.frameRateMode ?? ""),
    duration: null,
    colorSpace: snapshot.colorSpace ?? null,
    audioChannels: snapshot.audioChannels ?? null,
    sampleRate: snapshot.sampleRate ?? null,
    streams: snapshot.streams ?? [],
  });
}

function emptyInspection(
  status: "pending" | "failed",
  error: InspectionFailureCode | null,
): InspectionState {
  return {
    status,
    container: null,
    videoCodec: null,
    audioCodec: null,
    width: null,
    height: null,
    displayWidth: null,
    displayHeight: null,
    rotation: null,
    frameRateNumerator: null,
    frameRateDenominator: null,
    frameRateMode: null,
    colorSpace: null,
    audioChannels: null,
    sampleRate: null,
    streams: null,
    error,
  };
}

function technicalPresence(snapshot: InspectionSnapshotFields): boolean {
  return (
    isPresent(snapshot.container) ||
    isPresent(snapshot.videoCodec) ||
    isPresent(snapshot.audioCodec) ||
    isPresent(snapshot.width) ||
    isPresent(snapshot.height) ||
    isPresent(snapshot.displayWidth) ||
    isPresent(snapshot.displayHeight) ||
    isPresent(snapshot.rotation) ||
    isPresent(snapshot.frameRateNumerator) ||
    isPresent(snapshot.frameRateDenominator) ||
    isPresent(snapshot.colorSpace) ||
    isPresent(snapshot.audioChannels) ||
    isPresent(snapshot.sampleRate) ||
    (snapshot.streams != null && snapshot.streams.length > 0)
  );
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function optionalToken(value: string | null, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (!TOKEN.test(value)) {
    throw new DomainError(`${label} is not valid technical metadata.`);
  }
  return value;
}

function optionalDimension(value: number | null, label: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > POSTGRES_INTEGER_MAX) {
    throw new DomainError(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalRotation(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (value !== 0 && value !== 90 && value !== 180 && value !== 270) {
    throw new DomainError("Rotation must be 0, 90, 180, or 270 degrees.");
  }
  return value;
}

function assertDimensionSet(
  width: number | null,
  height: number | null,
  displayWidth: number | null,
  displayHeight: number | null,
  rotation: number | null,
): void {
  const values = [width, height, displayWidth, displayHeight];
  const present = values.filter((value) => value !== null).length;
  if (present === 0) {
    if (rotation !== null) {
      throw new DomainError("Rotation requires stored dimensions.");
    }
    return;
  }
  if (width === null || height === null || displayWidth === null || displayHeight === null) {
    throw new DomainError("Stored and display dimensions must be recorded together.");
  }
  const swaps = rotation === 90 || rotation === 270;
  const expectedWidth = swaps ? height : width;
  const expectedHeight = swaps ? width : height;
  if (displayWidth !== expectedWidth || displayHeight !== expectedHeight) {
    throw new DomainError("Display dimensions do not match rotation.");
  }
}

function optionalFrameRate(value: FrameRate | null): FrameRate | null {
  if (value === null) {
    return null;
  }
  let rate: FrameRate;
  try {
    rate = frameRate(value.numerator, value.denominator);
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError("Frame rate numerator and denominator must be positive integers.");
  }
  if (rate.numerator > POSTGRES_BIGINT_MAX || rate.denominator > POSTGRES_BIGINT_MAX) {
    throw new DomainError("Frame rate does not fit the metadata record.");
  }
  return rate;
}

function frameRateFromSnapshot(
  numerator: bigint | string | null | undefined,
  denominator: bigint | string | null | undefined,
): FrameRate | null {
  if (!isPresent(numerator) && !isPresent(denominator)) {
    return null;
  }
  if (
    !isPresent(numerator) ||
    !isPresent(denominator) ||
    numerator == null ||
    denominator == null
  ) {
    throw new DomainError("Frame rate numerator and denominator must be stored together.");
  }
  return frameRate(
    asBigint(numerator, "Frame rate numerator"),
    asBigint(denominator, "Frame rate denominator"),
  );
}

function asBigint(value: bigint | string, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  try {
    return BigInt(value);
  } catch {
    throw new DomainError(`${label} must be an integer.`);
  }
}

function frameRateMode(value: string): FrameRateMode {
  if (value === "constant" || value === "variable" || value === "unknown") {
    return value;
  }
  throw new DomainError("Frame rate mode must be constant, variable, or unknown.");
}

export function probeDuration(value: Microseconds | bigint | string | null): Microseconds | null {
  if (value === null) {
    return null;
  }
  const duration =
    typeof value === "bigint" || typeof value === "string" ? microseconds(value) : value;
  if (duration > 1_800_000_000n) {
    throw new DomainError("MediaAsset duration must be at most 1,800,000,000 microseconds.");
  }
  return duration;
}

function optionalCount(value: number | null, label: string, max: number): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new DomainError(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeStreams(streams: readonly MediaStreamMetadata[]): MediaStreamMetadata[] {
  if (streams.length > 64) {
    throw new DomainError("Inspection stream list is too long.");
  }
  return streams.map((stream) => {
    if (stream.codecType !== "video" && stream.codecType !== "audio") {
      throw new DomainError("Inspection streams must be video or audio.");
    }
    return {
      codecType: stream.codecType,
      codecName: optionalToken(stream.codecName, "Stream codec"),
      width: stream.codecType === "video" ? optionalDimension(stream.width, "Stream width") : null,
      height:
        stream.codecType === "video" ? optionalDimension(stream.height, "Stream height") : null,
      sampleRate:
        stream.codecType === "audio"
          ? optionalCount(stream.sampleRate, "Stream sample rate", 1_000_000)
          : null,
      channels:
        stream.codecType === "audio" ? optionalCount(stream.channels, "Stream channels", 64) : null,
    };
  });
}
