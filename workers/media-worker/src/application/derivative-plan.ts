import { createHash } from "node:crypto";
import { type DerivedAssetKind, type MediaAsset } from "@editagent/domain";
import { PermanentJobError } from "./job-errors.js";

export const DERIVATION_VERSION = "us128-v1";
export const PROXY_FPS = 30;
export const PROXY_GOP = 30;
export const SPRITE_SAMPLING_FPS = 30;
export const DERIVE_TIMEOUT_MS = 1_800_000;
export type DerivativeVariant = "proxy" | "asr" | "mix" | "poster" | "sprite";
export interface DerivativePlan {
  readonly variant: DerivativeVariant;
  readonly kind: DerivedAssetKind;
  readonly signature: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** Sorted JSON, including source identity and every output-affecting v1 policy. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function parameterSignature(parameters: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(parameters)).digest("hex");
}
export function derivativePlans(source: MediaAsset): readonly DerivativePlan[] {
  if (
    source.inspectionStatus !== "completed" ||
    source.kind !== "video" ||
    source.duration === null ||
    source.duration <= 0n ||
    source.storageKey === null ||
    source.contentSha256 === null ||
    source.videoCodec === null
  ) {
    throw new PermanentJobError(
      "Derivation requires inspected video metadata; inspection is not security validation.",
    );
  }
  const seconds = Number(source.duration) / 1_000_000;
  // Midpoints cover the entire source, at most 20 cells, never beyond its end.
  const samples = Math.max(1, Math.min(20, Math.ceil(seconds / 5)));
  const timestampsUs = Array.from({ length: samples }, (_, i) =>
    Math.floor((Number(source.duration) * (i + 0.5)) / samples),
  );
  const common = {
    version: DERIVATION_VERSION,
    sourceSha256: source.contentSha256,
    sourceDurationUs: source.duration.toString(),
    orientation: "ffmpeg-autorotate",
    streamSelection: "first-video-first-audio",
  };
  const definitions: {
    variant: DerivativeVariant;
    kind: DerivedAssetKind;
    mimeType: string;
    extension: string;
    settings: Record<string, unknown>;
  }[] = [
    {
      variant: "proxy",
      kind: "proxy",
      mimeType: "video/mp4",
      extension: "mp4",
      settings: {
        targetHeight: 540,
        upscale: false,
        aspect: "display-sar-square-pixels-even",
        fps: PROXY_FPS,
        fpsRounding: "near",
        // Legacy signature field names the -frames:v CAP, not an exact count.
        // Keep its value/signature: F-2 corrects the claim, not proxy encoding.
        frameCount: "ceil-duration-times-fps",
        codec: "libx264",
        pixelFormat: "yuv420p",
        gop: PROXY_GOP,
        sceneCut: false,
        preset: "veryfast",
        crf: 23,
        maxrate: "4M",
        bufsize: "8M",
        threads: 2,
        audio: false,
        faststart: true,
        endPadding: "clone-then-trim",
      },
    },
    ...(source.audioCodec === null
      ? []
      : [
          {
            variant: "asr" as const,
            kind: "extracted-audio" as const,
            mimeType: "audio/wav",
            extension: "wav",
            settings: {
              codec: "pcm_s16le",
              sampleRate: 16000,
              channels: 1,
              container: "wav-rf64-auto",
              timeline: "reset-pad-trim-to-source",
              normalization: false,
            },
          },
          {
            variant: "mix" as const,
            kind: "extracted-audio" as const,
            mimeType: "audio/wav",
            extension: "wav",
            settings: {
              codec: "pcm_f32le",
              sampleRate: source.sampleRate,
              channels: source.audioChannels,
              container: "wav-rf64-auto",
              timeline: "reset-pad-trim-to-source",
              normalization: false,
            },
          },
        ]),
    {
      variant: "poster",
      kind: "thumbnail",
      mimeType: "image/jpeg",
      extension: "jpg",
      settings: {
        maxWidth: 320,
        maxHeight: 180,
        fit: "display-sar-aspect-pad-black",
        timestampUs: Math.min(3_000_000, Math.floor(Number(source.duration) / 3)),
        codec: "mjpeg",
        quality: 3,
      },
    },
    {
      variant: "sprite",
      kind: "thumbnail",
      mimeType: "image/jpeg",
      extension: "jpg",
      settings: {
        tileWidth: 160,
        tileHeight: 90,
        columns: Math.min(5, samples),
        rows: Math.ceil(samples / Math.min(5, samples)),
        timestampsUs,
        sampling: "even-midpoints-cfr-nearest-index-v3",
        samplingFps: SPRITE_SAMPLING_FPS,
        frameSelection: "round-midpoint-us-times-fps",
        finalFramePadding: "source-duration-before-pts-reset",
        codec: "mjpeg",
        quality: 3,
      },
    },
  ];
  return definitions.map(({ variant, kind, mimeType, extension, settings }) => {
    const parameters = { ...common, variant, ...settings };
    const signature = parameterSignature(parameters);
    return {
      variant,
      kind,
      mimeType,
      parameters,
      signature,
      storageKey: `projects/${source.projectId}/derived/${source.id}/${kind}/${signature}/${variant}.${extension}`,
    };
  });
}
