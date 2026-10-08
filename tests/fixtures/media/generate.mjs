/** Synthetic public-domain fixtures; no footage, identities or downloaded audio. */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const dir = import.meta.dirname;
const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const encode = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "30",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "48k",
  "-map_metadata",
  "-1",
  "-movflags",
  "+faststart",
];
const head =
  "color=c=0x263449:s=320x180:r=25,drawbox=x=125:y=25:w=70:h=110:color=0xf8d99a:t=fill,drawbox=x=140:y=55:w=8:h=8:color=black:t=fill,drawbox=x=173:y=55:w=8:h=8:color=black:t=fill,drawbox=x=145:y=95:w=30:h=8:color=black:t=fill:enable='lt(mod(t,0.4),0.2)'";
ffmpeg([
  "-f",
  "lavfi",
  "-i",
  head,
  "-f",
  "lavfi",
  "-i",
  "flite=text='Hello this is a synthetic test speaker':voice=kal",
  "-t",
  "2",
  ...encode,
  path.join(dir, "talking-head.mp4"),
]);
ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=25",
  "-f",
  "lavfi",
  "-i",
  "aevalsrc=if(lt(mod(t\\,2)\\,1)\\,0.15*sin(2*PI*440*t)\\,0):s=48000",
  "-t",
  "4",
  ...encode,
  path.join(dir, "silence-gaps.mp4"),
]);
ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=c=0x263449:s=320x180:r=25,drawbox=x=40:y=25:w=70:h=110:color=blue:t=fill,drawbox=x=210:y=25:w=70:h=110:color=yellow:t=fill",
  "-f",
  "lavfi",
  "-i",
  "flite=text='Hello from the first speaker':voice=kal",
  "-f",
  "lavfi",
  "-i",
  "flite=text='Hello from the second speaker':voice=slt",
  "-filter_complex",
  "[1:a][2:a]concat=n=2:v=0:a=1,apad[a]",
  "-map",
  "0:v",
  "-map",
  "[a]",
  "-t",
  "4",
  ...encode,
  path.join(dir, "two-speakers.mp4"),
]);
ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=30",
  "-t",
  "2",
  "-vf",
  "select='if(lt(t,1),1,not(mod(n,3)))'",
  "-fps_mode",
  "vfr",
  ...encode,
  path.join(dir, "variable-frame-rate.mp4"),
]);
const temp = path.join(dir, ".phone-unrotated.mp4");
ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "2", ...encode, temp]);
ffmpeg(["-display_rotation", "90", "-i", temp, "-c", "copy", path.join(dir, "rotated-phone.mp4")]);
unlinkSync(temp);
writeFileSync(
  path.join(dir, "corrupt.mp4"),
  Buffer.from([
    0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 98, 114, 111, 107, 101, 110,
  ]),
);
const purposes = {
  "talking-head":
    "Animated geometric avatar and synthesized speech (flite kal); walking-skeleton metadata input",
  "silence-gaps": "Four seconds with alternating one-second tone/silence",
  "two-speakers": "Two sequential synthesized voices (flite kal and slt), padded to four seconds",
  "variable-frame-rate": "First second 30 fps, second second 10 fps; nonuniform packet spacing",
  "rotated-phone": "Stored landscape with 90-degree display matrix",
  corrupt: "Truncated MP4 header; intentional negative input",
};
const fixtures = Object.entries(purposes).map(([name, purpose]) => {
  const file = name + ".mp4",
    source = readFileSync(path.join(dir, file));
  let expected = null;
  if (name !== "corrupt") {
    const data = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", path.join(dir, file)],
        { encoding: "utf8" },
      ),
    );
    const v = data.streams.find((s) => s.codec_type === "video"),
      a = data.streams.find((s) => s.codec_type === "audio");
    expected = {
      codec: v.codec_name,
      width: v.width,
      height: v.height,
      frameRate: v.avg_frame_rate,
      nominalFrameRate: v.r_frame_rate,
      durationUs: Math.round(Number(data.format.duration) * 1000000),
      audioCodec: a?.codec_name ?? null,
      rotation: v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0,
    };
  }
  if (statSync(path.join(dir, file)).size >= 5000000) throw new Error("Fixture exceeds 5 MB");
  return {
    name,
    file,
    purpose,
    bytes: source.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    expected,
  };
});
writeFileSync(
  path.join(dir, "manifest.json"),
  JSON.stringify(
    {
      generation: "FFmpeg with libx264, AAC and libflite; see generate.mjs",
      license: "CC0-1.0 synthetic test inputs",
      fixtures,
    },
    null,
    2,
  ) + "\n",
);
