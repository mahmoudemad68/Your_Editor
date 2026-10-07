import { executablePath } from "./config.js";
import { spawn, spawnSync } from "node:child_process";
import { open, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaProbeError, type ProbeResult, type JobProgressStage } from "@editagent/domain";
import { mapFfprobeDocument, FFPROBE_SHOW_ENTRIES } from "@editagent/media-core";
import { MediaRejected, type MediaValidator } from "../application/validate-media.js";
import {
  AUDIO_CODECS,
  VIDEO_CODECS,
  validationPolicySignature,
  type ValidationPolicy,
} from "../application/validation-policy.js";

export const SANDBOX_PATH = path.resolve(__dirname, "../native/media-sandbox");
export function assertValidationSandbox(): void {
  const checked = spawnSync(SANDBOX_PATH, ["--check"], {
    shell: false,
    timeout: 5000,
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C" },
  });
  if (checked.status !== 0 || checked.error !== undefined)
    throw new Error("Required media validation sandbox is unavailable.");
}
/** No raw command diagnostics escape this adapter. Kernel sandbox denies network
 * sockets and all opens except staged input/output and trusted ELF libraries. */
export class SandboxedMediaValidator implements MediaValidator {
  readonly policySignature: string;
  readonly maxBytes: number;
  constructor(
    readonly policy: ValidationPolicy,
    private readonly ffmpeg: string,
    private readonly ffprobe: string,
  ) {
    this.policySignature = validationPolicySignature(policy);
    this.maxBytes = policy.maxBytes;
  }
  async validate(
    filePath: string,
    signal: AbortSignal,
    onStage?: (stage: JobProgressStage, percentage: number) => Promise<void>,
  ): Promise<ProbeResult> {
    signal.throwIfAborted();
    const size = (await stat(filePath)).size;
    if (size === 0) throw new MediaRejected("empty_media");
    if (size > this.policy.maxBytes) throw new MediaRejected("file_size_limit_exceeded");
    const demuxer = await sniffMedia(filePath);
    const common = [
      "-cpucount",
      "2",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      demuxer,
      "-threads",
      "2",
      "-max_alloc",
      "67108864",
      "-probesize",
      "5242880",
      "-analyzeduration",
      "5000000",
      "-f",
      demuxer,
    ];
    if (demuxer === "mov") common.push("-enable_drefs", "0", "-use_absolute_path", "0");
    const probeArgs = [
      "-v",
      "error",
      ...common,
      "-show_format",
      "-show_streams",
      "-show_entries",
      `${FFPROBE_SHOW_ENTRIES}:format=bit_rate:stream=bit_rate,sample_aspect_ratio`,
      "-of",
      "json",
      "-read_intervals",
      "%+#12",
      "-i",
      filePath,
    ];
    await onStage?.("probing", 25);
    const raw = await this.run(
      await executablePath(this.ffprobe),
      filePath,
      "-",
      probeArgs,
      this.policy.probeTimeoutMs,
      signal,
      "corrupt_media",
    );
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new MediaRejected("invalid_metadata");
    }
    validateMetadata(document, size, this.policy, demuxer);
    let result: ProbeResult;
    try {
      result = mapFfprobeDocument(document);
    } catch (error) {
      if (error instanceof MediaProbeError) throw new MediaRejected("invalid_metadata");
      throw error;
    }
    await onStage?.("decoding", 55);
    const directory = await mkdtemp(path.join(tmpdir(), "editagent-validation-"));
    const output = path.join(directory, "decode.mp4");
    try {
      await writeFile(output, "", { mode: 0o600, flag: "wx" });
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-xerror",
        "-err_detect",
        "explode",
        ...common,
        "-i",
        filePath,
        "-map",
        "0:v",
        "-map",
        "0:a?",
        "-sn",
        "-dn",
        "-t",
        "1",
        "-frames:v",
        "30",
        "-vf",
        "scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=320:180:(ow-iw)/2:(oh-ih)/2",
        "-filter_threads",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-ar",
        "16000",
        "-b:a",
        "32k",
        "-f",
        "mp4",
        output,
      ];
      await this.run(
        await executablePath(this.ffmpeg),
        filePath,
        output,
        args,
        this.policy.decodeTimeoutMs,
        signal,
        "decode_validation_failed",
      );
      if ((await stat(output)).size < 32) throw new MediaRejected("decode_validation_failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return result;
  }
  private run(
    exe: string,
    input: string,
    output: string,
    args: string[],
    timeoutMs: number,
    signal: AbortSignal,
    failed: "corrupt_media" | "decode_validation_failed",
  ): Promise<string> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        SANDBOX_PATH,
        [
          String(this.policy.cpuSeconds),
          String(this.policy.memoryBytes),
          String(this.policy.decodeOutputBytes),
          input,
          output,
          exe,
          "--",
          exe,
          ...args,
        ],
        {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: { LANG: "C", LC_ALL: "C", OMP_NUM_THREADS: "2", MALLOC_ARENA_MAX: "2" },
        },
      );
      let text = "",
        bytes = 0,
        limited = false,
        spawnError = false;
      const kill = () => child.kill("SIGTERM");
      const timer = setTimeout(() => {
        limited = true;
        kill();
      }, timeoutMs);
      // The broker forwards termination and reaps its child. Parent-death SIGKILL
      // also bounds cleanup if the enclosing US-129 process is hard-killed.
      signal.addEventListener("abort", kill, { once: true });
      child.on("error", () => {
        spawnError = true;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1048576) {
          limited = true;
          kill();
        } else text += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1048576) {
          limited = true;
          kill();
        }
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (spawnError || code === 125) {
          reject(new Error("Media validation infrastructure unavailable."));
          return;
        }
        if (
          limited ||
          exitSignal !== null ||
          code === 128 + 24 ||
          code === 128 + 25 ||
          code === 128 + 9
        ) {
          reject(new MediaRejected("resource_limit_exceeded"));
          return;
        }
        if (code !== 0) {
          reject(new MediaRejected(failed));
          return;
        }
        resolve(text);
      });
    });
  }
}

/** Filename/MIME never select a parser. Read a bounded header and traverse MOV
 * box metadata (bounded depth/count) to reject external data references. */
export async function sniffMedia(filePath: string): Promise<"mov" | "matroska"> {
  const file = await open(filePath, "r");
  try {
    const header = Buffer.alloc(65536);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const b = header.subarray(0, bytesRead);
    const text = b
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (/^(#EXTM3U|ffconcat|<\?xml|<MPD|\[playlist\])/i.test(text))
      throw new MediaRejected("unsafe_external_reference");
    if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
      if (!b.includes(Buffer.from("matroska")) && !b.includes(Buffer.from("webm")))
        throw new MediaRejected("unsupported_container");
      return "matroska";
    }
    if (b.length >= 12 && ["ftyp", "wide", "mdat", "moov"].includes(b.toString("ascii", 4, 8))) {
      let boxes = 0;
      const length = (await file.stat()).size;
      const containers = new Set(["moov", "trak", "mdia", "minf", "dinf"]);
      async function walk(start: number, end: number, depth: number): Promise<void> {
        if (depth > 8) throw new MediaRejected("corrupt_media");
        for (let at = start; at < end;) {
          if (++boxes > 100000) throw new MediaRejected("resource_limit_exceeded");
          const h = Buffer.alloc(16);
          const n = await file.read(h, 0, Math.min(16, end - at), at);
          if (n.bytesRead < 8) throw new MediaRejected("corrupt_media");
          let size = h.readUInt32BE(0),
            offset = 8;
          const type = h.toString("ascii", 4, 8);
          if (size === 1) {
            if (n.bytesRead < 16) throw new MediaRejected("corrupt_media");
            const v = h.readBigUInt64BE(8);
            if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaRejected("corrupt_media");
            size = Number(v);
            offset = 16;
          }
          if (size === 0) size = end - at;
          if (size < offset || at + size > end) throw new MediaRejected("corrupt_media");
          if (containers.has(type)) await walk(at + offset, at + size, depth + 1);
          if (type === "dref") {
            const d = Buffer.alloc(Math.min(size - offset, 65536));
            await file.read(d, 0, d.length, at + offset);
            if (d.length < 8) throw new MediaRejected("corrupt_media");
            let pos = 8;
            const count = d.readUInt32BE(4);
            if (count > 32) throw new MediaRejected("unsafe_external_reference");
            for (let i = 0; i < count; i++) {
              if (pos + 12 > d.length) throw new MediaRejected("corrupt_media");
              const s = d.readUInt32BE(pos),
                flags = d.readUInt32BE(pos + 8) & 0xffffff;
              if (s < 12 || pos + s > d.length) throw new MediaRejected("corrupt_media");
              if (flags !== 1) throw new MediaRejected("unsafe_external_reference");
              pos += s;
            }
          }
          at += size;
        }
      }
      await walk(0, length, 0);
      return "mov";
    }
    if (
      b.subarray(0, 4).toString() === "RIFF" ||
      b.subarray(0, 4).toString() === "OggS" ||
      b.subarray(1, 4).toString() === "PNG"
    )
      throw new MediaRejected("unsupported_container");
    throw new MediaRejected("invalid_signature");
  } finally {
    await file.close();
  }
}
export function validateMetadata(
  value: unknown,
  bytes: number,
  policy: ValidationPolicy,
  demuxer: "mov" | "matroska",
): void {
  if (typeof value !== "object" || value === null) throw new MediaRejected("invalid_metadata");
  const raw = value as { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
  const format = raw.format,
    streams = raw.streams;
  if (!format || !Array.isArray(streams) || streams.length === 0)
    throw new MediaRejected("invalid_metadata");
  const container = String(format["format_name"]);
  if (
    demuxer === "mov"
      ? !container.split(",").includes("mov")
      : !container.split(",").includes("matroska")
  )
    throw new MediaRejected("unsupported_container");
  if (streams.length > policy.maxStreams) throw new MediaRejected("stream_count_limit_exceeded");
  const duration = Number(format["duration"]);
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaRejected("invalid_metadata");
  if (duration > policy.maxDurationSeconds) throw new MediaRejected("duration_limit_exceeded");
  let video = false,
    bitrate = (bytes * 8) / duration;
  for (const s of streams) {
    if (typeof s !== "object" || s === null) throw new MediaRejected("invalid_metadata");
    const codec = s["codec_name"],
      type = s["codec_type"];
    if (type === "video") {
      video = true;
      if (!(VIDEO_CODECS as readonly unknown[]).includes(codec))
        throw new MediaRejected("unsupported_codec");
      const width = Number(s["width"]),
        height = Number(s["height"]);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new MediaRejected("invalid_metadata");
      if (
        width > policy.maxDimension ||
        height > policy.maxDimension ||
        width * height > policy.maxPixels
      )
        throw new MediaRejected("resolution_limit_exceeded");

      const aspect = s["sample_aspect_ratio"];
      if (aspect !== undefined && aspect !== "N/A" && aspect !== "0:1") {
        if (typeof aspect !== "string" || !/^[1-9]\d*:[1-9]\d*$/.test(aspect))
          throw new MediaRejected("invalid_metadata");
        const [n, d] = aspect.split(":").map(Number);
        if (
          n === undefined ||
          d === undefined ||
          !Number.isSafeInteger(n) ||
          !Number.isSafeInteger(d)
        )
          throw new MediaRejected("invalid_metadata");
        const displayWidth = (width * n) / d;
        if (
          !Number.isFinite(displayWidth) ||
          displayWidth > policy.maxDimension ||
          displayWidth * height > policy.maxPixels
        )
          throw new MediaRejected("resolution_limit_exceeded");
      }
    } else if (type === "audio") {
      if (!(AUDIO_CODECS as readonly unknown[]).includes(codec))
        throw new MediaRejected("unsupported_codec");
      const channels = Number(s["channels"]),
        rate = Number(s["sample_rate"]);
      if (
        !Number.isInteger(channels) ||
        channels < 1 ||
        channels > 8 ||
        !Number.isInteger(rate) ||
        rate < 8000 ||
        rate > 192000
      )
        throw new MediaRejected("invalid_metadata");
    } else throw new MediaRejected("unsupported_codec");
    if (s["bit_rate"] !== undefined) {
      const v = Number(s["bit_rate"]);
      if (!Number.isFinite(v) || v < 0) throw new MediaRejected("invalid_metadata");
      bitrate = Math.max(bitrate, v);
    }
  }
  if (!video) throw new MediaRejected("unsupported_codec");
  if (format["bit_rate"] !== undefined) {
    const v = Number(format["bit_rate"]);
    if (!Number.isFinite(v) || v < 0) throw new MediaRejected("invalid_metadata");
    bitrate = Math.max(bitrate, v);
  }
  if (bitrate > policy.maxBitrate) throw new MediaRejected("bitrate_limit_exceeded");
}
