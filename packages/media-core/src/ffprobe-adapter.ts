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

/** Infrastructure timing in exact stream ticks; no persisted domain/schema change. */
export interface EncodedStreamTiming {
  readonly kind: "video" | "audio";
  readonly codec: string;
  readonly timeBase: { numerator: bigint; denominator: bigint };
  readonly startTicks: bigint;
  readonly durationTicks: bigint | null;
  readonly frames: bigint | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
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

  async inspectStreamTiming(input: ProbeInput): Promise<readonly EncodedStreamTiming[]> {
    assertControlledLocalFile(input.filePath);
    const stdout = await runFfprobe(
      this.executable,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-show_streams",
        "-show_entries",
        "stream=codec_type,codec_name,time_base,start_pts,duration_ts,nb_frames,sample_rate,channels",
        "-of",
        "json",
        "-i",
        input.filePath,
      ],
      this.timeoutMs,
      this.maxOutputBytes,
      input.signal,
    );
    try {
      const document = JSON.parse(stdout.toString("utf8"));
      if (!Array.isArray(document.streams) || document.streams.length > 64) throw new Error();
      const integer = (v: unknown): bigint => {
        if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
        if (typeof v === "string" && /^-?(0|[1-9][0-9]{0,18})$/.test(v)) {
          const n = BigInt(v);
          if (n >= -9223372036854775808n && n <= 9223372036854775807n) return n;
        }
        throw new Error();
      };
      return document.streams
        .filter(
          (s: { codec_type?: unknown }) => s.codec_type === "video" || s.codec_type === "audio",
        )
        .map((s: Record<string, unknown>) => {
          const rate =
            typeof s.time_base === "string" &&
            /^([1-9][0-9]{0,9})\/([1-9][0-9]{0,9})$/.exec(s.time_base);
          if (!rate || typeof s.codec_name !== "string") throw new Error();
          const durationTicks = s.duration_ts === undefined ? null : integer(s.duration_ts);
          const frames =
            s.nb_frames === undefined || s.nb_frames === "N/A" ? null : integer(s.nb_frames);
          if ((durationTicks !== null && durationTicks <= 0n) || (frames !== null && frames < 1n))
            throw new Error();
          const audio = s.codec_type === "audio";
          const sampleRate = audio ? Number(integer(s.sample_rate)) : null;
          const channels = audio ? Number(integer(s.channels)) : null;
          if (
            audio &&
            (!sampleRate ||
              sampleRate < 8000 ||
              sampleRate > 192000 ||
              !channels ||
              channels < 1 ||
              channels > 64)
          )
            throw new Error();
          return {
            kind: s.codec_type as "video" | "audio",
            codec: s.codec_name,
            timeBase: { numerator: BigInt(rate[1]!), denominator: BigInt(rate[2]!) },
            startTicks: s.start_pts === undefined ? 0n : integer(s.start_pts),
            durationTicks,
            frames,
            sampleRate,
            channels,
          };
        });
    } catch {
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
    // Packet order is decode order, not presentation order. Select video before
    // counting packets (audio interleaving otherwise shrinks the evidence), and
    // retain a bounded complete prefix rather than decoder-flush tail frames.
    args[args.indexOf("-read_intervals") + 1] = "%+#128";
    args.splice(args.indexOf("-show_streams") + 1, 0, "-select_streams", "v:0");
    args[args.indexOf("-show_entries") + 1] = FFPROBE_SHOW_ENTRIES.replace(
      "color_space,",
      "color_space,pix_fmt,color_transfer,sample_aspect_ratio,field_order,",
    ).replace("frame=media_type,", "frame=media_type,best_effort_timestamp,pkt_dts,");
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
        (f: { media_type?: unknown; pkt_dts?: unknown }) =>
          f.media_type === "video" &&
          typeof f.pkt_dts === "number" &&
          Number.isSafeInteger(f.pkt_dts),
      );
      const pts = frames?.map((f: { best_effort_timestamp?: unknown }) => f.best_effort_timestamp);
      if (
        Array.isArray(pts) &&
        pts.every((p: unknown) => typeof p === "number" && Number.isSafeInteger(p))
      )
        pts.sort((a: number, b: number) => a - b);
      const constant =
        Array.isArray(pts) &&
        pts.length >= 3 &&
        pts.every((p: unknown) => typeof p === "number" && Number.isSafeInteger(p)) &&
        pts[1] > pts[0] &&
        pts.slice(2).every((p: number, i: number) => p - pts[i + 1] === pts[1] - pts[0]);
      const timeBase =
        typeof video?.time_base === "string" &&
        /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(video.time_base);
      const cadence = Boolean(
        constant &&
        timeBase &&
        probe.frameRate &&
        BigInt(pts[1] - pts[0]) * BigInt(timeBase[1]!) * probe.frameRate.numerator ===
          BigInt(timeBase[2]!) * probe.frameRate.denominator,
      );
      return (
        probe.videoCodec === "h264" &&
        (!rate ||
          (probe.frameRate !== null &&
            probe.frameRate.numerator * BigInt(rate.denominator) ===
              probe.frameRate.denominator * BigInt(rate.numerator))) &&
        cadence &&
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
