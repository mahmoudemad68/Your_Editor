import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { type MediaAsset } from "@editagent/domain";
import { FFprobeMediaProbe } from "@editagent/media-core";
import {
  type GeneratedDerivative,
  type MediaDerivativeProcessor,
  type PreparedDerivatives,
} from "../application/derive-media.js";
import {
  DERIVE_TIMEOUT_MS,
  PROXY_FPS,
  PROXY_GOP,
  SPRITE_SAMPLING_FPS,
  type DerivativePlan,
} from "../application/derivative-plan.js";
import { PermanentJobError, JobTimeoutError } from "../application/job-errors.js";

const MAX_PROCESS_OUTPUT = 1_048_576;
const MAX_DERIVATIVE_BYTES = 68_719_476_736n;
const DIMENSIONS =
  "scale=w='max(2,trunc(iw*sar*min(1,540/ih)/2)*2)':h='max(2,trunc(ih*min(1,540/ih)/2)*2)',setsar=1";
const THUMB = (w: number, h: number) =>
  `scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;

export function buildDerivativeArgs(
  input: string,
  output: string,
  plan: DerivativePlan,
): readonly string[] {
  controlledPath(input);
  controlledPath(output);
  const p = plan.parameters;
  const duration = Number(p["sourceDurationUs"]) / 1_000_000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800)
    throw new PermanentJobError("Invalid derivation duration.");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-threads",
    "2",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-protocol_whitelist",
    "file",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
  ];
  switch (plan.variant) {
    case "proxy":
      args.push(
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `${DIMENSIONS},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS,fps=${PROXY_FPS}:start_time=0:round=near`,
        "-frames:v",
        String(Math.ceil(duration * PROXY_FPS)),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-maxrate",
        "4M",
        "-bufsize",
        "8M",
        "-g",
        String(PROXY_GOP),
        "-keyint_min",
        String(PROXY_GOP),
        "-sc_threshold",
        "0",
        "-threads",
        "2",
        "-fps_mode",
        "cfr",
        "-movflags",
        "+faststart",
        "-metadata:s:v:0",
        "rotate=0",
        "-f",
        "mp4",
      );
      break;
    case "asr":
    case "mix":
      args.push(
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        `aresample=async=1:first_pts=0,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`,
        "-c:a",
        plan.variant === "asr" ? "pcm_s16le" : "pcm_f32le",
      );
      if (plan.variant === "asr") args.push("-ar", "16000", "-ac", "1");
      args.push("-rf64", "auto", "-f", "wav");
      break;
    case "poster":
      args.push(
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `tpad=stop_mode=clone:stop_duration=${duration},trim=start=${Number(p["timestampUs"]) / 1_000_000},setpts=PTS-STARTPTS,${THUMB(320, 180)}`,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
      );
      break;
    case "sprite": {
      const timestamps = p["timestampsUs"] as readonly number[];
      const count = timestamps.length;
      // Pad before setpts: the pinned runtime cannot reliably infer tpad's
      // frame duration after PTS reset. Cover even an audio-led source timeline,
      // then explicitly retain each midpoint's
      // nearest CFR frame index. A low-rate fps filter instead emits the end of
      // an interval: start_time does not make it select midpoint pixel content.
      const selected = timestamps
        .map((at) => `eq(n,${Math.round((at * SPRITE_SAMPLING_FPS) / 1_000_000)})`)
        .join("+");
      args.push(
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `tpad=stop_mode=clone:stop_duration=${duration},setpts=PTS-STARTPTS,fps=${SPRITE_SAMPLING_FPS}:start_time=0:round=near,select='${selected}',${THUMB(160, 90)},tile=${p["columns"]}x${p["rows"]}:nb_frames=${count}`,
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-threads",
        "1",
        "-f",
        "image2",
        "-update",
        "1",
      );
      break;
    }
  }
  // Stops oversized output; stat below rejects truncation as well.
  return [...args, "-fs", MAX_DERIVATIVE_BYTES.toString(), output];
}

export class FFmpegDerivativeProcessor implements MediaDerivativeProcessor {
  constructor(
    private readonly executable = "ffmpeg",
    private readonly ffprobe = "ffprobe",
    private readonly timeoutMs = DERIVE_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DERIVE_TIMEOUT_MS)
      throw new Error("Invalid derivative timeout.");
  }
  async prepare(
    source: MediaAsset,
    stagedPath: string,
    signal: AbortSignal,
  ): Promise<PreparedDerivatives> {
    controlledPath(stagedPath);
    signal.throwIfAborted();
    const directory = await mkdtemp(path.join(path.dirname(stagedPath), "derivatives-"));
    try {
      const disk = await statfs(directory);
      const duration = Number(source.duration) / 1_000_000;
      // Outputs are retained only until the staging directory is released. Reserve
      // source-rate float PCM plus bounded proxy rate, ASR, images and headroom.
      const needed = BigInt(
        Math.ceil(
          duration *
            ((source.sampleRate ?? 0) * (source.audioChannels ?? 0) * 4 + 500_000 + 32_000) +
            64 * 1024 * 1024,
        ),
      );
      if (BigInt(disk.bavail) * BigInt(disk.bsize) < needed)
        throw new Error("Insufficient derivation scratch space.");
      return {
        generate: async (plan, abort) => {
          const filePath = path.join(
            directory,
            `${plan.variant}.${plan.mimeType === "video/mp4" ? "mp4" : plan.mimeType === "audio/wav" ? "wav" : "jpg"}`,
          );
          await runControlledProcess(
            this.executable,
            buildDerivativeArgs(stagedPath, filePath, plan),
            abort,
            this.timeoutMs,
          );
          const file = await stat(filePath);
          if (file.size < 1 || BigInt(file.size) >= MAX_DERIVATIVE_BYTES)
            throw new PermanentJobError("Derivative output size is invalid.");
          const metadata: Record<string, unknown> = {
            variant: plan.variant,
            parameters: plan.parameters,
          };
          if (plan.variant === "proxy" || plan.variant === "asr" || plan.variant === "mix") {
            abort.throwIfAborted();
            const result = await new FFprobeMediaProbe({ executable: this.ffprobe }).inspect({
              filePath,
              signal: abort,
            });
            abort.throwIfAborted();
            const delta =
              result.duration === null
                ? Infinity
                : Math.abs(Number(result.duration) - Number(source.duration));
            if (delta > 1_000_000 / PROXY_FPS)
              throw new PermanentJobError("Derived duration exceeds one proxy frame.");
            if (
              plan.variant === "proxy" &&
              (result.videoCodec !== "h264" ||
                result.frameRate === null ||
                Number(result.frameRate.numerator) / Number(result.frameRate.denominator) !==
                  PROXY_FPS ||
                result.height === null ||
                result.height > 540)
            )
              throw new PermanentJobError("Proxy format verification failed.");
            if (
              plan.variant === "asr" &&
              (result.audioCodec !== "pcm_s16le" ||
                result.sampleRate !== 16000 ||
                result.audioChannels !== 1)
            )
              throw new PermanentJobError("ASR format verification failed.");
            if (
              plan.variant === "mix" &&
              (result.audioCodec !== "pcm_f32le" ||
                result.sampleRate !== source.sampleRate ||
                result.audioChannels !== source.audioChannels)
            )
              throw new PermanentJobError("Mix format verification failed.");
            Object.assign(metadata, {
              durationUs: result.duration?.toString(),
              width: result.width,
              height: result.height,
              fps: plan.variant === "proxy" ? PROXY_FPS : null,
              sampleRate: result.sampleRate,
              channels: result.audioChannels,
              codec: result.videoCodec ?? result.audioCodec,
            });
          }
          return { filePath, metadata } satisfies GeneratedDerivative;
        },
        release: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
function controlledPath(value: string): void {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value) || value.includes("://"))
    throw new PermanentJobError("Only controlled local paths are accepted.");
}
/** Fixed arg arrays; bounded diagnostic output, deadline and cooperative abort.
 * FFmpeg inherits the supervised job's process group; it cannot survive hard reap.
 */
export async function runControlledProcess(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let error: Error | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let diagnosticBytes = 0;
    const stop = (reason: Error) => {
      if (error !== undefined) return;
      error = reason;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 150);
    };
    const abort = () =>
      stop(signal.reason instanceof Error ? signal.reason : new Error("Derivation cancelled."));
    const deadline = setTimeout(() => stop(new JobTimeoutError()), timeoutMs);
    const cleanup = () => {
      clearTimeout(deadline);
      if (hardKill !== undefined) clearTimeout(hardKill);
      signal.removeEventListener("abort", abort);
    };
    child.stderr?.on("data", (data: Buffer) => {
      diagnosticBytes += data.length;
      if (diagnosticBytes > MAX_PROCESS_OUTPUT)
        stop(new PermanentJobError("FFmpeg diagnostic limit exceeded."));
    });
    child.on("error", () => {
      cleanup();
      reject(new Error("FFmpeg runtime is unavailable."));
    });
    child.on("close", (code) => {
      cleanup();
      if (error !== undefined) reject(error);
      else if (code !== 0)
        reject(new PermanentJobError("FFmpeg could not generate the derivative."));
      else resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
