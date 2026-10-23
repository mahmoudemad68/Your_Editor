#!/usr/bin/env bash
# QA-generated inputs: unique-per-frame synthetic video (testsrc2) + the repository's
# hash-verified licensed English speech fixture; plus a video-only clip (no audio track).
set -euo pipefail
out="$1"; app="$2"
mkdir -p "$out"
wav="$app/tests/fixtures/asr/en.wav"
expected="$(python3 -c "import json,sys;m=json.load(open('$app/tests/fixtures/asr/manifest.json'));print(next(f['sha256'] for f in m['fixtures'] if f['file']=='en.wav'))")"
actual="$(sha256sum "$wav" | cut -d' ' -f1)"
test "$expected" = "$actual"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x240:rate=25:duration=8" -i "$wav" \
  -map 0:v:0 -map 1:a:0 -t 8 -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -g 25 \
  -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$out/qa-source.mp4"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x240:rate=25:duration=8" \
  -t 8 -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -g 25 -movflags +faststart "$out/qa-noaudio.mp4"
sha256sum "$out"/*.mp4
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels \
  -show_entries format=duration -of compact "$out/qa-source.mp4"
