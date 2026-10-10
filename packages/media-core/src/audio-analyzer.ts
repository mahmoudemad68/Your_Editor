import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  IAudioAnalyzer,
  AudioAnalysisInput,
  AudioAnalysisConfiguration,
} from "@editagent/domain";
import {
  AudioAnalysisSchema,
  AnalyzerProvenanceSchema,
  type MediaAnalysis,
} from "@editagent/schemas";
import { buildFfmpegArgs, boundedNumber, localMediaPath } from "./ffmpeg-builder.js";
import { FfmpegExecutor } from "./ffmpeg-executor.js";
import { parseLoudness, parseSilence, PcmBuckets } from "./audio-analysis-parsers.js";

export type CompletedAudioSection = Extract<
  MediaAnalysis["sections"]["audio"],
  { status: "completed" }
>;
export const DEFAULT_AUDIO_ANALYSIS_CONFIG: AudioAnalysisConfiguration = Object.freeze({
  silenceNoiseDb: -60,
  minimumSilenceUs: 200000n,
  bucketUs: 100000n,
  sampleRate: 48000,
  timeoutMs: 120000,
});
export function validateAudioAnalysisConfig(
  config: AudioAnalysisConfiguration,
): AudioAnalysisConfiguration {
  boundedNumber(config.silenceNoiseDb, -100, 0);
  boundedNumber(config.sampleRate, 8000, 192000, true);
  boundedNumber(config.timeoutMs, 1, 1800000, true);
  for (const [value, min, max] of [
    [config.minimumSilenceUs, 1n, 10000000n],
    [config.bucketUs, 100000n, 10000000n],
  ] as const)
    if (typeof value !== "bigint" || value < min || value > max)
      throw new Error("Invalid audio analysis configuration.");
  if ((config.bucketUs * BigInt(config.sampleRate)) % 1000000n !== 0n)
    throw new Error("Bucket duration must span an exact sample count.");
  return Object.freeze({ ...config });
}
/** No storage/queue implementation: accepts an already authorized, staged derivative. */
export class FFmpegAudioAnalyzer implements IAudioAnalyzer<CompletedAudioSection> {
  readonly configuration: AudioAnalysisConfiguration;
  private readonly executor = new FfmpegExecutor();
  constructor(
    config: AudioAnalysisConfiguration = DEFAULT_AUDIO_ANALYSIS_CONFIG,
    private readonly executable = "ffmpeg",
  ) {
    this.configuration = validateAudioAnalysisConfig(config);
  }
  async analyze(input: AudioAnalysisInput): Promise<CompletedAudioSection> {
    localMediaPath(input.filePath);
    if (
      typeof input.durationUs !== "bigint" ||
      input.durationUs <= 0n ||
      input.durationUs > 1800000000n
    )
      throw new Error("Invalid analysis duration.");
    if (!/^[0-9a-f]{64}$/.test(input.sourceSha256) || !/^[0-9a-f]{64}$/.test(input.inputSha256))
      throw new Error("Invalid audio identity.");
    const offset = input.scopeStartUs === undefined ? 0n : input.scopeStartUs;
    const sourceDuration =
      input.sourceDurationUs === undefined ? input.durationUs : input.sourceDurationUs;
    if (
      typeof offset !== "bigint" ||
      typeof sourceDuration !== "bigint" ||
      offset < 0n ||
      sourceDuration > 1800000000n ||
      offset + input.durationUs > sourceDuration
    )
      throw new Error("Invalid audio evaluation scope.");
    const deadline = AbortSignal.timeout(this.configuration.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const info = await stat(input.filePath);
    if (!info.isFile() || info.size < 1 || info.size > 2147483648)
      throw new Error("Invalid staged audio size.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(input.filePath, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== input.inputSha256)
      throw new Error("Audio checksum differs from persisted identity.");
    const version = (
      await this.executor.execute(["-version"], {
        executable: this.executable,
        timeoutMs: 5000,
        signal,
      })
    ).stdout
      .toString("utf8")
      .split("\n")[0]
      ?.match(/^ffmpeg version ([a-zA-Z0-9._+-]+)/)?.[1];
    if (!version) throw new Error("Missing FFmpeg version identity.");
    const config = this.configuration;
    const buckets = new PcmBuckets(config.sampleRate, config.bucketUs, input.durationUs);
    const args = buildFfmpegArgs({
      input: { path: input.filePath, format: "wav" },
      output: {
        format: "f32le",
        maps: ["0:a:0"],
        audioEncoder: "pcm_f32le",
        sampleRate: config.sampleRate,
        channels: 1,
        audioFilters: [
          {
            kind: "silencedetect",
            noiseDb: config.silenceNoiseDb,
            durationUs: config.minimumSilenceUs,
          },
          { kind: "ebur128" },
        ],
      },
    });
    const result = await this.executor.execute(args, {
      executable: this.executable,
      timeoutMs: config.timeoutMs,
      signal,
      maxCaptureBytes: 16777216,
      maxStdoutBytes:
        Number((input.durationUs * BigInt(config.sampleRate) + 999999n) / 1000000n) * 4,
      onStdout: (chunk) => buckets.push(chunk),
    });
    signal.throwIfAborted();
    buckets.finish();
    const data = AudioAnalysisSchema.parse({
      silence: parseSilence(result.stderr, input.durationUs),
      ...parseLoudness(result.stderr, input.durationUs),
      energyCurve: buckets.energyCurve,
      waveformPeaks: buckets.waveformPeaks,
    });
    // Scoped derivative time is rebased exactly once into canonical source coordinates.
    for (const range of data.silence ?? []) {
      range.startUs = String(BigInt(range.startUs) + offset);
      range.endUs = String(BigInt(range.endUs) + offset);
    }
    for (const point of [
      ...(data.energyCurve ?? []),
      ...(data.waveformPeaks ?? []),
      ...(data.shortTermLoudness ?? []),
    ])
      point.atUs = String(BigInt(point.atUs) + offset);
    const configuration = {
      silenceNoiseDb: config.silenceNoiseDb,
      minimumSilenceUs: config.minimumSilenceUs.toString(),
      bucketUs: config.bucketUs.toString(),
      sampleRate: config.sampleRate,
      timeoutMs: config.timeoutMs,
      waveformChannels: "ffmpeg-mono-downmix",
      waveformFloorDbfs: -200,
    };
    const provenance = AnalyzerProvenanceSchema.parse({
      analyzer: "ffmpeg-audio",
      analyzerVersion: "us204-v1",
      sourceSha256: input.sourceSha256,
      configurationSha256: createHash("sha256").update(JSON.stringify(configuration)).digest("hex"),
      inputArtifactId: input.inputArtifactId,
      inputSha256: input.inputSha256,
      runtime: "ffmpeg",
      runtimeVersion: version,
    });
    return { status: "completed", data, provenance };
  }
}
