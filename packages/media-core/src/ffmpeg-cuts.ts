import {
  boundedNumber,
  localMediaPath,
  secondsFromUs,
  validateFilterGraph,
} from "./ffmpeg-builder.js";

export interface CutSegment {
  readonly path?: string;
  readonly fromFrame: number;
  readonly frames: number;
  readonly sourceStartUs?: bigint;
  readonly sourceEndUs?: bigint;
  readonly hasAudio: boolean;
}
export interface CutRenderRecipe {
  readonly segments: readonly CutSegment[];
  readonly width: number;
  readonly height: number;
  readonly frameRate: { readonly numerator: number; readonly denominator: number };
  readonly totalFrames: number;
  readonly background: string;
  readonly output: string;
}
/** Fixed trusted recipe, not a public filter-string or filesystem capability. */
export function buildCutRenderArgs(r: CutRenderRecipe): readonly string[] {
  const width = boundedNumber(r.width, 2, 4096, true),
    height = boundedNumber(r.height, 2, 4096, true);
  const n = boundedNumber(r.frameRate.numerator, 1, 60000, true),
    d = boundedNumber(r.frameRate.denominator, 1, 1001, true);
  if (
    width % 2 ||
    height % 2 ||
    width * height > 8294400 ||
    n / d < 1 ||
    n / d > 60 ||
    !/^#[0-9a-fA-F]{6}$/.test(r.background)
  )
    throw new Error("Invalid cut rendering configuration.");
  boundedNumber(r.totalFrames, 1, 108000, true);
  if (BigInt(r.totalFrames) * 1000000n * BigInt(d) > 1800000000n * BigInt(n))
    throw new Error("Cut duration budget exceeded.");
  if (r.segments.length < 1 || r.segments.length > 17)
    throw new Error("Cut segment budget exceeded.");
  const inputs = [...new Set(r.segments.flatMap((s) => (s.path ? [localMediaPath(s.path)] : [])))];
  if (inputs.length > 8) throw new Error("Cut input budget exceeded.");
  const audio = r.segments.some((s) => s.hasAudio),
    color = `0x${r.background.slice(1)}`,
    fps = `${n}/${d}`;
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-progress",
    "pipe:3",
    "-nostats",
  ];
  for (const file of inputs)
    args.push(
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,matroska",
      "-max_alloc",
      "67108864",
      "-probesize",
      "5242880",
      "-analyzeduration",
      "5000000",
      "-i",
      file,
    );
  const graph: string[] = [];
  const sampleAt = (frame: number) =>
    (BigInt(frame) * 48000n * BigInt(d) + BigInt(Math.floor(n / 2))) / BigInt(n);
  let cursor = 0;
  r.segments.forEach((s, index) => {
    boundedNumber(s.frames, 1, r.totalFrames, true);
    if (s.fromFrame !== cursor) throw new Error("Non-contiguous cut plan.");
    cursor += s.frames;
    const durationUs = (BigInt(s.frames) * 1000000n * BigInt(d) + BigInt(n - 1)) / BigInt(n);
    const duration = secondsFromUs(durationUs),
      samples = sampleAt(cursor) - sampleAt(s.fromFrame);
    const input = s.path ? inputs.indexOf(s.path) : -1;
    if (input >= 0) {
      if (
        s.sourceStartUs === undefined ||
        s.sourceEndUs === undefined ||
        s.sourceStartUs < 0n ||
        s.sourceEndUs <= s.sourceStartUs ||
        s.sourceEndUs > 1800000000n
      )
        throw new Error("Invalid cut source range.");
      const startFrame =
        (s.sourceStartUs * BigInt(n) + 500000n * BigInt(d)) / (1000000n * BigInt(d));
      const endFrame = (s.sourceEndUs * BigInt(n) + 500000n * BigInt(d)) / (1000000n * BigInt(d));
      if (endFrame - startFrame !== BigInt(s.frames))
        throw new Error("Cut source frame count mismatch.");
      graph.push(
        `[${input}:v:0]fps=fps=${fps}:start_time=0:round=near,trim=start_frame=${startFrame}:end_frame=${endFrame},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1,tpad=stop_mode=clone:stop_duration=${duration},trim=end_frame=${s.frames},settb=expr=${d}/${n},setpts=N[v${index}]`,
      );
    } else {
      if (s.hasAudio) throw new Error("A gap cannot reference audio.");
      graph.push(
        `color=c=${color}:s=${width}x${height}:r=${fps}:d=${duration},trim=end_frame=${s.frames},settb=expr=${d}/${n},setpts=N[v${index}]`,
      );
    }
    if (audio) {
      graph.push(
        input >= 0 && s.hasAudio
          ? `[${input}:a:0]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=start_sample=${(s.sourceStartUs! * 48000n + 500000n) / 1000000n}:end_sample=${(s.sourceEndUs! * 48000n + 500000n) / 1000000n},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`
          : `anullsrc=r=48000:cl=stereo:d=${duration},atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`,
      );
    }
  });
  if (cursor !== r.totalFrames) throw new Error("Cut plan duration mismatch.");
  graph.push(
    r.segments.map((_, i) => `[v${i}]`).join("") +
      `concat=n=${r.segments.length}:v=1:a=0,settb=expr=${d}/${n},setpts=N[vout]`,
  );
  if (audio) {
    if (r.segments.length === 1) graph.push("[a0]asetpts=N/SR/TB[aout]");
    else
      for (let i = 1; i < r.segments.length; i++)
        graph.push(
          `[${i === 1 ? "a0" : `mix${i - 1}`}][a${i}]acrossfade=d=0.005:o=0:c1=tri:c2=tri[${i === r.segments.length - 1 ? "aout" : `mix${i}`}]`,
        );
  }
  const filters = graph.join(";");
  validateFilterGraph(filters, true);
  args.push("-filter_complex", filters, "-map", "[vout]");
  if (audio) args.push("-map", "[aout]", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k");
  else args.push("-an");
  args.push(
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-sn",
    "-dn",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-threads",
    "2",
    "-r",
    fps,
    "-fps_mode",
    "cfr",
    "-frames:v",
    String(r.totalFrames),
    "-video_track_timescale",
    String(n),
    "-movflags",
    "+faststart",
    "-fs",
    "1073741824",
    "-f",
    "mp4",
    localMediaPath(r.output),
  );
  return Object.freeze(args);
}
