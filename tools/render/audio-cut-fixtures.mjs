/** Independent sample/frame truth, authored before rendering. Test-only process use. */
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import path from "node:path";
import process from "node:process";

export const beepFrames = [12, 24, 35, 52, 58, 75, 100, 103, 111, 121];
export const sourceFrames = 128;
export const sampleAt = (frame, n, d, sampleRate = 48000) =>
  Number((BigInt(frame) * BigInt(sampleRate) * BigInt(d) + BigInt(Math.floor(n / 2))) / BigInt(n));
export function audioFrameColor(frame, markers = beepFrames) {
  // Distinct non-flash frame identities differ by at least 28 in one channel,
  // exceeding twice the declared lossy-codec verification allowance (8).
  // A one-frame error must not disappear inside a slowly changing palette.
  return markers.includes(frame)
    ? [240, 240, 240]
    : [
        20 + (frame % 8) * 28,
        20 + (Math.floor(frame / 8) % 8) * 28,
        (40 + Math.floor(frame / 64) * 140) % 256,
      ];
}
export function prepareAudioCutFixtures(directory) {
  mkdirSync(directory, { recursive: true });
  const rgb = Buffer.alloc(sourceFrames * 64 * 64 * 3);
  for (let f = 0; f < sourceFrames; f++) {
    const color = audioFrameColor(f);
    for (let i = 0; i < 64 * 64; i++)
      for (let c = 0; c < 3; c++) rgb[(f * 64 * 64 + i) * 3 + c] = color[c];
  }
  const raw = path.join(directory, "bframe-source.rgb");
  writeFileSync(raw, rgb);
  const fixtures = [];
  for (const [n, d] of [
    [25, 1],
    [30, 1],
    [30000, 1001],
    [24000, 1001],
    [60000, 1001],
  ]) {
    for (const layout of ["mono48", "stereo44", "none", ...(n === 25 ? ["h1exact"] : [])]) {
      const markers = layout === "h1exact" ? [10, 20, 50, 60] : beepFrames;
      let videoRaw = raw;
      if (layout === "h1exact") {
        const pixels = Buffer.alloc(sourceFrames * 64 * 64 * 3);
        for (let f = 0; f < sourceFrames; f++)
          for (let p = 0; p < 64 * 64; p++)
            for (let c = 0; c < 3; c++)
              pixels[(f * 64 * 64 + p) * 3 + c] = audioFrameColor(f, markers)[c];
        videoRaw = path.join(directory, "bframe-h1-exact.rgb");
        writeFileSync(videoRaw, pixels);
      }
      const sampleRate = layout === "stereo44" ? 44100 : 48000;
      const channels = layout === "stereo44" ? 2 : 1;
      const count = sampleAt(sourceFrames, n, d, sampleRate);
      const pcm = Buffer.alloc(count * channels * 2);
      for (const f of markers) {
        const start = sampleAt(f, n, d, sampleRate) + Math.round(sampleRate * 0.005);
        const length = Math.round(sampleRate * 0.015);
        for (let i = 0; i < length && start + i < count; i++) {
          const envelope = Math.min(
            1,
            i / (sampleRate * 0.001),
            (length - i) / (sampleRate * 0.001),
          );
          const value = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.6 * envelope;
          for (let c = 0; c < channels; c++)
            pcm.writeInt16LE(
              Math.round(value * (c ? 0.8 : 1) * 32767),
              ((start + i) * channels + c) * 2,
            );
        }
      }
      const audio = path.join(directory, `bframe-${n}-${layout}.pcm`);
      writeFileSync(audio, pcm);
      const file = path.join(directory, `bframe-${n}-${layout}.mp4`);
      const args = [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        "64x64",
        "-r",
        `${n}/${d}`,
        "-i",
        videoRaw,
      ];
      if (layout !== "none")
        args.push("-f", "s16le", "-ar", String(sampleRate), "-ac", String(channels), "-i", audio);
      args.push(
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-x264-params",
        "bframes=3:b-adapt=0:keyint=48:scenecut=0",
        "-threads",
        "2",
        "-video_track_timescale",
        String(n),
      );
      if (layout !== "none") args.push("-c:a", "aac", "-b:a", "128k");
      args.push("-movflags", "+faststart", file);
      execFileSync("ffmpeg", args, { timeout: 30000, maxBuffer: 1048576 });
      fixtures.push({
        file,
        n,
        d,
        layout,
        hasAudio: layout !== "none",
        frames: sourceFrames,
        sampleRate,
        channels,
        beepFrames: markers,
      });
    }
  }
  writeFileSync(path.join(directory, "bframe-fixtures.json"), JSON.stringify(fixtures) + "\n");
  return fixtures;
}
/** Real ingestion records and S3 bytes for the production queue/container path. */
export async function registerAudioCutFixtures({ pool, s3, project, newId, directory }) {
  const fixtures = prepareAudioCutFixtures(directory);
  const fractional = path.join(directory, "bframe-179.mp4");
  const raw179 = path.join(directory, "bframe-179.rgb"),
    pixels179 = Buffer.alloc(179 * 64 * 64 * 3);
  for (let f = 0; f < 179; f++)
    for (let p = 0; p < 64 * 64; p++)
      for (let c = 0; c < 3; c++) pixels179[(f * 64 * 64 + p) * 3 + c] = audioFrameColor(f)[c];
  writeFileSync(raw179, pixels179);
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      "64x64",
      "-r",
      "30000/1001",
      "-i",
      raw179,
      "-frames:v",
      "179",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-bf",
      "3",
      "-pix_fmt",
      "yuv420p",
      "-video_track_timescale",
      "30000",
      fractional,
    ],
    { timeout: 30000 },
  );
  fixtures.push({
    file: fractional,
    n: 30000,
    d: 1001,
    layout: "179",
    frames: 179,
    hasAudio: false,
    sampleRate: 48000,
    channels: 1,
  });
  // Exact authored video count with a genuinely longer AAC/container clock.
  const tail = path.join(directory, "bframe-179-aac-tail.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-i",
      fractional,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=6",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-movie_timescale",
      "48000",
      tail,
    ],
    { timeout: 30000 },
  );
  fixtures.push({
    file: tail,
    n: 30000,
    d: 1001,
    layout: "179-tail",
    frames: 179,
    hasAudio: true,
    sampleRate: 48000,
    channels: 1,
    assetDurationUs: "6000000",
  });
  const { prepareSpatialFixtures } = await import("./spatial-audio-fixtures.mjs");
  fixtures.push(...prepareSpatialFixtures(directory));
  for (const fixture of fixtures) {
    const bytes = readFileSync(fixture.file),
      sha256 = createHash("sha256").update(bytes).digest("hex"),
      id = newId();
    const key = `projects/${project}/media/sha256/${sha256}`;
    // The final fixture deliberately records the valid rounded-up microsecond
    // representation that previously caused a duplicated 180th video frame.
    const durationUs =
      fixture.assetDurationUs ??
      String(
        (BigInt(fixture.frames) * 1000000n * BigInt(fixture.d) + BigInt(fixture.n - 1)) /
          BigInt(fixture.n),
      );
    await pool.query(
      `INSERT INTO media_assets(id,project_id,kind,storage_key,display_filename,mime_type,byte_size,content_sha256,upload_state,duration,created_at,updated_at,inspection_status,container,video_codec,audio_codec,audio_channels,sample_rate,width,height,frame_rate_numerator,frame_rate_denominator,frame_rate_mode,validation_status,validation_policy_signature,validation_source_sha256,validation_checked_at)
      VALUES($1,$2,'video',$3,'bframe-fixture.mp4','video/mp4',$4,$5,'uploaded',$6,0,0,'completed','mp4','h264',$7,$8,$9,64,64,$10,$11,'constant','validated',$12,$5,0)`,
      [
        id,
        project,
        key,
        bytes.length,
        sha256,
        durationUs,
        fixture.hasAudio ? "aac" : null,
        fixture.hasAudio ? fixture.channels : null,
        fixture.hasAudio ? fixture.sampleRate : null,
        fixture.n,
        fixture.d,
        "a".repeat(64),
      ],
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: "editagent",
        Key: key,
        Body: bytes,
        ContentType: "video/mp4",
      }),
    );
    Object.assign(fixture, { id, key, sha256, byteSize: bytes.length, durationUs });
  }
  return fixtures;
}
if (process.argv[1] === new URL(import.meta.url).pathname) prepareAudioCutFixtures(process.argv[2]);
