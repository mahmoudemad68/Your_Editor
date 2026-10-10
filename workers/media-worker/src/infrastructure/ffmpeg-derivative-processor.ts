import { mkdtemp, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { type MediaAsset } from "@editagent/domain";
import {
  FFprobeMediaProbe,
  FfmpegExecutor,
  FfmpegError,
  buildDerivativePreset,
} from "@editagent/media-core";
import {
  type GeneratedDerivative,
  type MediaDerivativeProcessor,
  type PreparedDerivatives,
} from "../application/derive-media.js";
import {
  DERIVE_TIMEOUT_MS,
  PROXY_FPS,
  type DerivativePlan,
} from "../application/derivative-plan.js";
import { PermanentJobError, JobTimeoutError } from "../application/job-errors.js";

const MAX_DERIVATIVE_BYTES = 68_719_476_736n;
export function buildDerivativeArgs(
  input: string,
  output: string,
  plan: DerivativePlan,
): readonly string[] {
  try {
    return buildDerivativePreset(input, output, plan);
  } catch {
    throw new PermanentJobError("Invalid derivative configuration.");
  }
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
/** Compatibility surface for existing derivative regression tools; execution is media-core-owned. */
const executor = new FfmpegExecutor();
export async function runControlledProcess(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  try {
    await executor.execute(args, { executable, signal, timeoutMs, processGroup: "supervised" });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof FfmpegError && error.code === "timeout") throw new JobTimeoutError();
    if (error instanceof FfmpegError && (error.code === "exit" || error.code === "output_limit"))
      throw new PermanentJobError("FFmpeg could not generate the derivative.");
    throw error;
  }
}
