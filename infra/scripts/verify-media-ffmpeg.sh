#!/bin/sh
# Probe the accepted containers with the media-worker image and show that
# MPEG-DASH is not demuxed. Usage: verify-media-ffmpeg.sh IMAGE
set -eu

image="${1:?image is required}"
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
fixtures="$root/packages/media-core/fixtures/media"
work="$(mktemp -d)"
chmod 0777 "$work"
trap 'rm -rf "$work"' EXIT

docker run --rm --entrypoint id "$image" | grep -q 'uid=10001'
# US-127: production kernel capability must fail closed, including file and network isolation.
docker run --rm --entrypoint /app/dist/native/media-sandbox "$image" --check
# US-204/220: exercise the real adapter against the exact production FFmpeg build.
# Fixed trusted infrastructure code; no job-provided shell or media arguments.
docker run --rm --network none --read-only --entrypoint node \
  -v "$fixtures:/fixtures:ro" "$image" -e '
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { FFmpegAudioAnalyzer } = require("@editagent/media-core");
const inputSha256 = createHash("sha256").update(readFileSync("/fixtures/audio.wav")).digest("hex");
new FFmpegAudioAnalyzer().analyze({filePath: "/fixtures/audio.wav", durationUs: 1000000n,
  sourceSha256: inputSha256, inputSha256, inputArtifactId: "production-audio-fixture"})
  .then(result => {
    if (result.status !== "completed" || !result.data.loudness || result.data.energyCurve.length !== 10 ||
        result.data.waveformPeaks.length !== 10 || !result.provenance.runtimeVersion.startsWith("7.1.5-editagent1"))
      throw new Error("Production audio analysis validation failed");
    console.log(JSON.stringify({productionAudioAnalysis: "PASS", ...result.provenance}));
  }).catch(() => process.exit(1));
'

docker run --rm --user root --entrypoint sh "$image" -c 'if dpkg -s libxml2 >/dev/null 2>&1; then exit 1; fi'
docker run --rm --entrypoint sh "$image" -c 'if ldd /usr/local/bin/ffprobe /usr/local/bin/ffmpeg | grep -i xml; then exit 1; fi'
docker run --rm --entrypoint sh "$image" -c 'if ffmpeg -hide_banner -demuxers | grep -w dash; then exit 1; fi'
docker run --rm --entrypoint sh "$image" -c 'ffprobe -version | head -n 1 | grep -q 7.1.5-editagent1'

docker run --rm --entrypoint ffmpeg \
  -v "$fixtures:/fixtures:ro" \
  -v "$work:/out" \
  "$image" \
  -y -v error -i /fixtures/normal.mp4 -c copy /out/sample.mkv
docker run --rm --entrypoint ffmpeg \
  -v "$fixtures:/fixtures:ro" \
  -v "$work:/out" \
  "$image" \
  -y -v error -i /fixtures/normal.mp4 -c copy -brand qt -f mov /out/sample.mov
docker run --rm --entrypoint ffmpeg \
  -v "$fixtures:/fixtures:ro" \
  -v "$work:/out" \
  "$image" \
  -y -v error -i /fixtures/normal.mp4 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 200k -c:a libopus /out/sample.webm
docker run --rm --entrypoint ffmpeg \
  -v "$fixtures:/fixtures:ro" \
  -v "$work:/out" \
  "$image" \
  -y -v error -i /fixtures/normal.mp4 -ss 0.1 -t 0.3 -c:v libx264 -pix_fmt yuv420p -c:a aac /out/edited.mp4
cp "$fixtures/normal.mp4" "$work/sample.mp4"
printf '%s\n' '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>' > "$work/sample.mpd"

probe() {
  label="$1"
  file="$2"
  docker run --rm --entrypoint ffprobe \
    -v "$work:/out:ro" \
    -v "$fixtures:/fixtures:ro" \
    "$image" \
    -hide_banner -v error -protocol_whitelist file -print_format json -show_format -show_streams \
    -i "$file" > "$work/${label}.json"
  echo "probed $label"
}

probe mp4 /out/sample.mp4
probe mov /out/sample.mov
probe mkv /out/sample.mkv
probe webm /out/sample.webm
probe edited /out/edited.mp4
probe fixture_mov /fixtures/rotated.mov
probe fixture_vfr /fixtures/vfr.mp4
probe fixture_wav /fixtures/audio.wav
probe fixture_png /fixtures/image.png

if docker run --rm --entrypoint ffprobe \
  -v "$work:/out:ro" \
  "$image" \
  -hide_banner -v error -i /out/sample.mpd >"$work/dash.json" 2>"$work/dash.err"; then
  echo "MPEG-DASH input was accepted" >&2
  exit 1
fi
grep -q 'Invalid data found when processing input' "$work/dash.err"

python3 - "$work" <<'PY'
import json
import pathlib
import sys

work = pathlib.Path(sys.argv[1])

def load(name):
    return json.loads((work / name).read_text())

def codecs(document):
    streams = document["streams"]
    video = next(stream["codec_name"] for stream in streams if stream["codec_type"] == "video")
    audio = next(stream["codec_name"] for stream in streams if stream["codec_type"] == "audio")
    return document["format"]["format_name"], video, audio

mp4, mov, mkv, webm, edited = (codecs(load(name)) for name in (
    "mp4.json", "mov.json", "mkv.json", "webm.json", "edited.json",
))
assert mp4 == ("mov,mp4,m4a,3gp,3g2,mj2", "h264", "aac"), mp4
assert mov[0] == "mov,mp4,m4a,3gp,3g2,mj2" and mov[1:] == ("h264", "aac"), mov
assert "matroska" in mkv[0] and mkv[1:] == ("h264", "aac"), mkv
assert "webm" in webm[0] and webm[1:] == ("vp9", "opus"), webm
assert edited[1:] == ("h264", "aac"), edited
assert float(load("edited.json")["format"]["duration"]) < 1

rotated = load("fixture_mov.json")
rotation = rotated["streams"][0]["side_data_list"][0]["rotation"]
assert rotation == 90, rotation
assert rotated["format"]["tags"]["major_brand"].strip() == "qt"

vfr = load("fixture_vfr.json")
assert vfr["format"]["format_name"].startswith("mov,mp4")
wav = load("fixture_wav.json")
assert wav["format"]["format_name"] == "wav"
assert wav["streams"][0]["codec_name"] == "pcm_s16le"
png = load("fixture_png.json")
assert png["format"]["format_name"] == "png_pipe", png["format"]
assert "duration" not in png["format"]
assert png["streams"][0]["codec_name"] == "png"
assert png["streams"][0]["width"] == 64
assert png["streams"][0]["height"] == 48
assert png["streams"][0].get("color_space") == "gbr"
print("accepted containers probed; MPEG-DASH demuxing is absent")
PY
