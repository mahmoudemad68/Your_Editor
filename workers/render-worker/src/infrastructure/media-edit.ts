import path from "node:path";
import { uuidV7, snapToFrame, frameTime } from "@editagent/domain";
import { validateEditingParameters } from "@editagent/tool-sdk";
import {
  FFprobeMediaProbe,
  FfmpegExecutor,
  buildVideoEditArgs,
  buildCutRenderArgs,
  buildLoudnessMeasureArgs,
  parseLoudnessMeasurement,
  editOutputTiming,
  type EditSource,
  type VideoEdit,
  type CutSegment,
} from "@editagent/media-core";
import type {
  MediaEditInput,
  FixtureInput,
  VerifiedAsset,
  RenderProgress,
} from "../application/ports.js";
import { validateOutput } from "./probe-output.js";
import { MediaEditInputError } from "./media-edit-error.js";
function checked<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new MediaEditInputError();
  }
}

export function parseMediaEdit(raw: unknown): MediaEditInput {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !==
      "kind,operation,parameters,renderVersion,schemaVersion,sources"
  )
    throw new Error("Invalid media recipe.");
  const v = raw as MediaEditInput;
  if (
    v.schemaVersion !== 1 ||
    v.kind !== "media-edit-v1" ||
    !/^[a-f0-9]{64}$/.test(v.renderVersion) ||
    !["concat_clips", "crop_video", "resize_video", "change_speed", "normalize_audio"].includes(
      v.operation,
    )
  )
    throw new Error("Unsupported media recipe.");
  validateEditingParameters(v.operation, v.parameters);
  if (!Array.isArray(v.sources) || v.sources.length < 1 || v.sources.length > 8)
    throw new Error("Invalid source set.");
  for (const s of v.sources) {
    if (
      !s ||
      Object.keys(s).sort().join(",") !== "durationUs,id,kind" ||
      s.kind !== "video" ||
      typeof s.durationUs !== "string" ||
      !/^[1-9][0-9]{0,9}$/.test(s.durationUs) ||
      BigInt(s.durationUs) > 1800000000n
    )
      throw new Error("Invalid source reference.");
    uuidV7(s.id);
  }
  const ids =
    v.operation === "concat_clips"
      ? (v.parameters.clips as { assetId: string }[]).map((c) => c.assetId)
      : [v.parameters.assetId as string];
  if (
    new Set(v.sources.map((s) => s.id)).size !== v.sources.length ||
    new Set(ids).size !== v.sources.length ||
    ids.some((id) => !v.sources.some((s) => s.id === id))
  )
    throw new Error("Source references differ from recipe.");
  return v;
}
export async function executeMediaEdit(
  input: MediaEditInput,
  assets: readonly VerifiedAsset[],
  work: string,
  signal: AbortSignal,
  progress: (p: RenderProgress) => void,
) {
  const sources = new Map<string, EditSource>();
  for (const a of assets) {
    const file = path.join(work, a.name),
      p = await new FFprobeMediaProbe({ timeoutMs: 10000 }).inspect({ filePath: file, signal });
    if (!p.videoCodec || !p.width || !p.height || !p.frameRate || !p.duration)
      throw new MediaEditInputError();
    sources.set(a.sourceId, {
      path: file,
      width: p.displayWidth ?? p.width,
      height: p.displayHeight ?? p.height,
      durationUs: BigInt(a.durationUs),
      frameRate: {
        numerator: Number(p.frameRate.numerator),
        denominator: Number(p.frameRate.denominator),
      },
      hasAudio: p.audioCodec !== null,
    });
  }
  const first = sources.get(input.sources[0]!.id)!;
  let args: readonly string[],
    timing: ReturnType<typeof editOutputTiming>,
    audioPresent = first.hasAudio;
  const output = path.join(work, "output.mp4"),
    p = input.parameters;
  if (input.operation === "concat_clips") {
    const segments: CutSegment[] = [],
      rate = {
        numerator: BigInt(first.frameRate.numerator),
        denominator: BigInt(first.frameRate.denominator),
      };
    let cursor = 0;
    for (const c of p.clips as { assetId: string; startUs: string; endUs: string }[]) {
      const s = sources.get(c.assetId)!;
      const start = snapToFrame(BigInt(c.startUs), rate),
        end = snapToFrame(BigInt(c.endUs), rate);
      if (start < 0n || end <= start || end > s.durationUs) throw new MediaEditInputError();
      const frames = Number(
        ((end - start) * rate.numerator + 500000n * rate.denominator) /
          (1000000n * rate.denominator),
      );
      if (!frames) throw new MediaEditInputError();
      segments.push({
        path: s.path,
        fromFrame: cursor,
        frames,
        sourceStartUs: start,
        sourceEndUs: end,
        hasAudio: s.hasAudio,
      });
      cursor += frames;
    }
    const durationUs = frameTime(BigInt(cursor), rate);
    timing = {
      width: first.width,
      height: first.height,
      frameRate: first.frameRate,
      totalFrames: cursor,
      durationUs,
    };
    audioPresent = segments.some((s) => s.hasAudio);
    args = checked(() =>
      buildCutRenderArgs({ ...timing, segments, background: "#000000", output }),
    );
  } else {
    let edit: VideoEdit;
    if (input.operation === "crop_video")
      edit = {
        operation: input.operation,
        x: p.x as number,
        y: p.y as number,
        width: p.width as number,
        height: p.height as number,
      };
    else if (input.operation === "resize_video")
      edit = { operation: input.operation, width: p.width as number, height: p.height as number };
    else if (input.operation === "change_speed")
      edit = {
        operation: input.operation,
        numerator: p.numerator as number,
        denominator: p.denominator as number,
      };
    else {
      const settings = {
        targetLufs: p.targetLufs as number,
        truePeakDb: p.truePeakDb as number,
        loudnessRange: p.loudnessRange as number,
      };
      const measured = await new FfmpegExecutor(1).execute(
        checked(() => buildLoudnessMeasureArgs(first, settings)),
        { signal, timeoutMs: 300000, processGroup: "supervised", maxCaptureBytes: 1048576 },
      );
      edit = {
        operation: input.operation,
        ...settings,
        measured: checked(() => parseLoudnessMeasurement(measured.stderr)),
      };
    }
    timing = checked(() => editOutputTiming(first, edit));
    args = checked(() => buildVideoEditArgs(first, edit, output));
  }
  await new FfmpegExecutor(1).execute(args, {
    signal,
    timeoutMs: 600000,
    processGroup: "supervised",
    maxCaptureBytes: 1048576,
    onProgress: (p) => {
      const count = Math.min(timing.totalFrames, p.frame);
      progress({ renderedFrames: count, encodedFrames: count, totalFrames: timing.totalFrames });
    },
  });
  const expected: FixtureInput = {
    schemaVersion: 1,
    renderVersion: input.renderVersion,
    compositionId: "FixtureV1",
    width: timing.width,
    height: timing.height,
    frameRate: timing.frameRate,
    durationInFrames: timing.totalFrames,
    props: { title: "media-edit", background: "#000000" },
    correlationId: "media-edit",
  };
  const validated = await validateOutput(output, expected, signal);
  const probe = await new FFprobeMediaProbe({ timeoutMs: 10000 }).inspect({
    filePath: output,
    signal,
  });
  if ((probe.audioCodec !== null) !== audioPresent || (audioPresent && probe.audioCodec !== "aac"))
    throw new Error("Edited audio stream differs from contract.");
  return { ...validated, audioPresent };
}
