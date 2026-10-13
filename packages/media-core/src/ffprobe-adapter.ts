/**
 * FFprobe subprocess adapter. Argument arrays only. shell is false.
 * Protocol whitelist `file` blocks outbound URLs. It is not the hostile-media
 * validation required by US-127.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  MediaProbeError,
  type IMediaProbe,
  type ProbeInput,
  type ProbeResult,
} from "@editagent/domain";
import { mapFfprobeDocument } from "./ffprobe-json.js";

export const FFPROBE_SHOW_ENTRIES =
  "format=format_name,duration:format_tags=major_brand:stream=codec_name,codec_type,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,color_space,time_base,tags:stream_side_data=side_data_type,rotation:frame=media_type,best_effort_timestamp_time,pkt_duration";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 600_000;

export interface FFprobeAdapterOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export function buildFfprobeArgs(filePath: string): readonly string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-show_entries",
    FFPROBE_SHOW_ENTRIES,
    "-read_intervals",
    "%+#12",
    "-i",
    filePath,
  ];
}

export class FFprobeMediaProbe implements IMediaProbe {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: FFprobeAdapterOptions = {}) {
    this.executable = options.executable ?? "ffprobe";
    this.timeoutMs = finiteTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new MediaProbeError("invalid_result");
    }
  }

  async inspect(input: ProbeInput): Promise<ProbeResult> {
    assertControlledLocalFile(input.filePath);
    const args = buildFfprobeArgs(input.filePath);
    const stdout = await runFfprobe(
      this.executable,
      args,
      this.timeoutMs,
      this.maxOutputBytes,
      input.signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.toString("utf8"));
    } catch {
      throw new MediaProbeError("invalid_json");
    }
    try {
      return mapFfprobeDocument(parsed);
    } catch (error) {
      if (error instanceof MediaProbeError) {
        throw error;
      }
      throw new MediaProbeError("invalid_result");
    }
  }

  /** Transient renderer capability, not a change to persisted media metadata. */
  async supportsCutRendering(
    input: ProbeInput,
    rate?: { numerator: number; denominator: number },
  ): Promise<boolean> {
    assertControlledLocalFile(input.filePath);
    const args = [...buildFfprobeArgs(input.filePath)];
    args[args.indexOf("-show_entries") + 1] = FFPROBE_SHOW_ENTRIES.replace(
      "color_space,",
      "color_space,pix_fmt,color_transfer,sample_aspect_ratio,field_order,",
    ).replace("frame=media_type,", "frame=media_type,best_effort_timestamp,");
    args.splice(args.indexOf("-show_streams") + 1, 0, "-show_frames");
    const stdout = await runFfprobe(
      this.executable,
      args,
      this.timeoutMs,
      this.maxOutputBytes,
      input.signal,
    );
    try {
      const document = JSON.parse(stdout.toString("utf8"));
      const probe = mapFfprobeDocument(document);
      const video = document.streams?.find(
        (s: { codec_type?: unknown }) => s.codec_type === "video",
      );
      // Integer stream ticks avoid rounding artifacts in decimal 30/29.97 fps timestamps.
      const frames = document.frames?.filter(
        (f: { media_type?: unknown }) => f.media_type === "video",
      );
      const pts = frames?.map((f: { best_effort_timestamp?: unknown }) => f.best_effort_timestamp);
      const constant =
        Array.isArray(pts) &&
        pts.length >= 3 &&
        pts.every((p: unknown) => typeof p === "number" && Number.isSafeInteger(p)) &&
        pts[1] > pts[0] &&
        pts.slice(2).every((p: number, i: number) => p - pts[i + 1] === pts[1] - pts[0]);
      return (
        probe.videoCodec === "h264" &&
        (!rate ||
          (probe.frameRate !== null &&
            probe.frameRate.numerator * BigInt(rate.denominator) ===
              probe.frameRate.denominator * BigInt(rate.numerator))) &&
        constant &&
        video?.avg_frame_rate === video?.r_frame_rate &&
        (probe.rotation === null || probe.rotation === 0) &&
        ["yuv420p", "yuvj420p", "yuv444p", "yuvj444p"].includes(video?.pix_fmt) &&
        [undefined, "unknown", "bt709", "smpte170m", "iec61966-2-1"].includes(
          video?.color_transfer,
        ) &&
        [undefined, "0:1", "1:1"].includes(video?.sample_aspect_ratio) &&
        [undefined, "unknown", "progressive"].includes(video?.field_order)
      );
    } catch {
      return false;
    }
  }
}

function finiteTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new MediaProbeError("invalid_result");
  }
  return value;
}

function assertControlledLocalFile(filePath: string): void {
  if (
    filePath.length === 0 ||
    filePath.includes("\0") ||
    filePath.includes("\n") ||
    filePath.includes("\r") ||
    filePath.includes("://") ||
    !path.isAbsolute(filePath)
  ) {
    throw new MediaProbeError("invalid_result");
  }
}

function runFfprobe(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new MediaProbeError("exit"));
      return;
    }
    if (child.stdout === null || child.stderr === null) {
      reject(new MediaProbeError("exit"));
      return;
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    const finish = (error?: MediaProbeError, body?: Buffer): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      stdoutStream.destroy();
      stderrStream.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(body ?? Buffer.alloc(0));
    };
    const stop = (): void => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    stdoutStream.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflow = true;
        stop();
        return;
      }
      stdout.push(chunk);
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        overflow = true;
        stop();
      }
    });
    stdoutStream.on("error", () => undefined);
    stderrStream.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(new MediaProbeError(error.code === "ENOENT" ? "not_found" : "exit"));
    });
    child.on("close", (code) => {
      if (signal?.aborted) {
        finish(new MediaProbeError("interrupted"));
        return;
      }
      if (timedOut) {
        finish(new MediaProbeError("timeout"));
        return;
      }
      if (overflow) {
        finish(new MediaProbeError("invalid_json"));
        return;
      }
      if (code !== 0) {
        finish(new MediaProbeError("exit"));
        return;
      }
      finish(undefined, Buffer.concat(stdout));
    });
  });
}
