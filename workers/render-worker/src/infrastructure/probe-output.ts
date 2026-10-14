import { compositionTiming } from "../application/timeline-mapping.js";
import { stat } from "node:fs/promises";
import { FFprobeMediaProbe, buildFfmpegArgs, FfmpegExecutor } from "@editagent/media-core";
import type { RenderInput } from "../application/ports.js";
export async function validateOutput(
  filePath: string,
  input: RenderInput,
  signal?: AbortSignal,
  expectedAudio?: boolean,
  expectedAudioSamples?: bigint,
) {
  if (expectedAudio === undefined && input.compositionId === "TimelineV1")
    throw new Error("An authoritative audio contract is required.");
  expectedAudio ??= false;
  if (
    expectedAudioSamples !== undefined &&
    (typeof expectedAudioSamples !== "bigint" ||
      expectedAudioSamples < (expectedAudio ? 1n : 0n) ||
      expectedAudioSamples > 86400000n ||
      (!expectedAudio && expectedAudioSamples !== 0n))
  )
    throw new Error("Invalid authoritative audio sample contract.");
  const timing = compositionTiming(input);
  const size = (await stat(filePath)).size;
  if (size < 1 || size > 1073741824) throw new Error("Invalid render output size.");
  const probe = new FFprobeMediaProbe({ timeoutMs: 10000 });
  const p = await probe.inspect({
    filePath,
    ...(signal ? { signal } : {}),
  });
  const fps = timing.frameRate.numerator / timing.frameRate.denominator;
  const duration =
    (BigInt(timing.durationInFrames) * 1000000n * BigInt(timing.frameRate.denominator) +
      BigInt(Math.floor(timing.frameRate.numerator / 2))) /
    BigInt(timing.frameRate.numerator);
  const delta = p.duration === null ? duration : p.duration - duration;
  if (
    p.container !== "MP4" ||
    p.videoCodec !== "h264" ||
    !p.streams.some((s) => s.codecType === "video") ||
    p.width !== timing.width ||
    p.height !== timing.height ||
    !p.frameRate ||
    p.frameRate.numerator * BigInt(timing.frameRate.denominator) !==
      p.frameRate.denominator * BigInt(timing.frameRate.numerator) ||
    p.duration === null ||
    (!expectedAudio &&
      (delta > BigInt(Math.ceil(500000 / fps)) || delta < -BigInt(Math.ceil(500000 / fps))))
  )
    throw new Error(
      "Rendered MP4 does not match its contract: " +
        JSON.stringify({
          container: p.container,
          codec: p.videoCodec,
          width: p.width,
          height: p.height,
          frameRate: p.frameRate ? `${p.frameRate.numerator}:${p.frameRate.denominator}` : null,
          durationUs: String(p.duration),
          expectedDurationUs: String(duration),
        }),
    );
  const streams = await probe.inspectStreamTiming({ filePath, ...(signal ? { signal } : {}) });
  const videos = streams.filter((s) => s.kind === "video"),
    audios = streams.filter((s) => s.kind === "audio"),
    video = videos[0];
  if (
    videos.length !== 1 ||
    !video ||
    video.durationTicks === null ||
    video.startTicks !== 0n ||
    video.durationTicks * video.timeBase.numerator * BigInt(timing.frameRate.numerator) !==
      BigInt(timing.durationInFrames) *
        BigInt(timing.frameRate.denominator) *
        video.timeBase.denominator
  )
    throw new Error("Rendered video stream timing differs from its contract.");
  if (audios.length !== (expectedAudio ? 1 : 0))
    throw new Error("Rendered audio presence differs from its contract.");
  let decodedAudioSamples = 0n;
  let audioSamples = 0n;
  if (expectedAudio) {
    const audio = audios[0]!;
    const expectedSamples =
      expectedAudioSamples ??
      (BigInt(timing.durationInFrames) * 48000n * BigInt(timing.frameRate.denominator) +
        BigInt(Math.floor(timing.frameRate.numerator / 2))) /
        BigInt(timing.frameRate.numerator);
    if (
      audio.codec !== "aac" ||
      audio.sampleRate !== 48000 ||
      audio.channels !== 2 ||
      audio.durationTicks === null ||
      audio.startTicks !== 0n ||
      audio.timeBase.numerator * 48000n !== audio.timeBase.denominator
    )
      throw new Error("Rendered audio stream clock differs from its contract.");
    // AAC-LC carries 1024 samples per packet. No shortfall beyond integer sample
    // rounding is allowed. A muxed final AAC packet can extend the logical end;
    // decoded padding is checked separately. Remotion's muxed edit duration may
    // extend beyond the last decoded packet by a fraction of an AAC packet;
    // this may never excuse missing composition samples.
    const logicalSamples = audio.durationTicks;
    audioSamples = expectedSamples;
    if (logicalSamples < expectedSamples - 1n || logicalSamples > expectedSamples + 1023n)
      throw new Error("Rendered audio duration differs from its contract.");
    let bytes = 0;
    await new FfmpegExecutor(1).execute(
      buildFfmpegArgs({
        input: { path: filePath },
        output: {
          format: "f32le",
          maps: ["0:a:0"],
          audioEncoder: "pcm_f32le",
          sampleRate: 48000,
          channels: 1,
        },
      }),
      {
        timeoutMs: 300000,
        ...(signal ? { signal } : {}),
        maxCaptureBytes: 1048576,
        maxStdoutBytes: Number((logicalSamples + 1024n) * 4n),
        onStdout: (chunk) => {
          bytes += chunk.length;
        },
      },
    );
    if (bytes % 4 !== 0) throw new Error("Malformed decoded audio samples.");
    decodedAudioSamples = BigInt(bytes / 4);
    if (
      decodedAudioSamples < logicalSamples - 1023n ||
      decodedAudioSamples > logicalSamples + 1023n ||
      decodedAudioSamples < expectedSamples - 1n
    )
      throw new Error("Decoded audio is incomplete or has excess padding.");
    const audioUs = (logicalSamples * 1000000n + 24000n) / 48000n;
    const longestStream = audioUs > duration ? audioUs : duration;
    // MP4's movie header rounds up to its millisecond clock. This is only a
    // container/stream consistency allowance, never a video or audio shortfall.
    if (p.duration! < longestStream - 1n || p.duration! > longestStream + 1000n)
      throw new Error("MP4 duration does not agree with validated stream clocks.");
  }
  let decodedFrames = 0;
  await new FfmpegExecutor(1).execute(
    buildFfmpegArgs({
      input: { path: filePath },
      // The hardened media-core builder requires an explicit admitted video encoder.
      // Decode every frame and discard the verification encode; never alter the uploaded MP4.
      output: { format: "null", maps: ["0:v:0"], videoEncoder: "libx264" },
      progress: true,
    }),
    {
      timeoutMs: 300000,
      ...(signal ? { signal } : {}),
      maxCaptureBytes: 1048576,
      onProgress: (p) => {
        decodedFrames = p.frame;
      },
    },
  );
  if (decodedFrames !== timing.durationInFrames)
    throw new Error("Rendered MP4 frame count does not match its contract.");
  const audioDurationUs = (audioSamples * 1000000n + 24000n) / 48000n;
  return {
    decodedFrames,
    byteSize: size,
    // Spatial derivatives can be audio-led. Keep both authoritative clocks;
    // AAC packet padding/container rounding is not semantic media duration.
    durationUs: String(
      expectedAudioSamples !== undefined && audioDurationUs > duration ? audioDurationUs : duration,
    ),
    videoDurationUs: String(duration),
    audioSamples: String(audioSamples),
    decodedAudioSamples: String(decodedAudioSamples),
    width: p.width,
    height: p.height,
    frameRate: {
      numerator: String(p.frameRate.numerator),
      denominator: String(p.frameRate.denominator),
    },
    codec: p.videoCodec,
  };
}
