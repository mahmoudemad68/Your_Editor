import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
/** Per-frame colors and timestamps are fixed before either renderer runs. */
export const frameColor = (f) => [(f % 8) * 30, Math.floor(f / 8) * 30, (f % 2) * 180];
export async function prepareCutFixtures({ pool, s3, project, newId, directory }) {
  const raw = Buffer.alloc(160 * 90 * 3 * 60);
  for (let f = 0; f < 60; f++) {
    const rgb = frameColor(f);
    for (let pixel = 0; pixel < 160 * 90; pixel++)
      for (let c = 0; c < 3; c++) raw[(f * 160 * 90 + pixel) * 3 + c] = rgb[c];
  }
  const rawFile = directory + "/cut-source.rgb";
  await writeFile(rawFile, raw);
  const sources = [];
  try {
    for (const [n, d] of [
      [25, 1],
      [30, 1],
      [30000, 1001],
    ]) {
      for (const mode of n === 30 ? ["tone", "mute", "silence"] : ["tone", "mute"]) {
        const hasAudio = mode !== "mute";
        const width = hasAudio ? 160 : 320,
          height = hasAudio ? 90 : 180;
        const file = directory + `/cut-source-${n}-${mode}.mp4`,
          durationUs = (
            (60n * 1000000n * BigInt(d) + BigInt(Math.floor(n / 2))) /
            BigInt(n)
          ).toString();
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-s",
          "160x90",
          "-r",
          `${n}/${d}`,
          "-i",
          rawFile,
          ...(hasAudio
            ? [
                "-f",
                "lavfi",
                "-i",
                `sine=frequency=${mode === "silence" ? 0 : 440}:sample_rate=48000:duration=${Number(durationUs) / 1000000}`,
              ]
            : []),
          "-vf",
          `scale=${width}:${height}`,
          "-frames:v",
          "60",
          "-c:v",
          "libx264",
          "-crf",
          "0",
          "-pix_fmt",
          "yuv444p",
          "-threads",
          "1",
          ...(hasAudio ? ["-c:a", "aac"] : ["-an"]),
          "-video_track_timescale",
          String(n),
          file,
        ]);
        const bytes = await readFile(file),
          sha = createHash("sha256").update(bytes).digest("hex"),
          id = newId(),
          key = `projects/${project}/media/sha256/${sha}`;
        await pool.query(
          `INSERT INTO media_assets(id,project_id,kind,storage_key,display_filename,mime_type,byte_size,content_sha256,upload_state,duration,created_at,updated_at,inspection_status,container,video_codec,audio_codec,audio_channels,sample_rate,width,height,frame_rate_numerator,frame_rate_denominator,frame_rate_mode,validation_status,validation_policy_signature,validation_source_sha256,validation_checked_at)
    VALUES($1,$2,'video',$3,'cut-fixture.mp4','video/mp4',$4,$5,'uploaded',$6,0,0,'completed','mp4','h264',$10,$11,$12,$13,$14,$7,$8,'constant','validated',$9,$5,0)`,
          [
            id,
            project,
            key,
            bytes.length,
            sha,
            durationUs,
            n,
            d,
            "a".repeat(64),
            hasAudio ? "aac" : null,
            hasAudio ? 1 : null,
            hasAudio ? 48000 : null,
            width,
            height,
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
        sources.push({
          id,
          durationUs,
          numerator: n,
          denominator: d,
          sha256: sha,
          key,
          hasAudio,
          silence: mode === "silence",
          width,
          height,
        });
      }
    }
  } finally {
    await rm(rawFile, { force: true });
  }
  return sources;
}
