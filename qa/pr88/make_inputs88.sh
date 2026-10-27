#!/usr/bin/env bash
# QA-generated inputs: synthetic 320x180/25fps video + the repository's hash-verified licensed speech fixture.
# qa88-source.mp4: 8 s with speech (transcript measurable); qa88-silent.mp4: 8 s video without audio.
set -euo pipefail
out="$1"; app="$2"
mkdir -p "$out"
expected="$(python3 -c "import json;m=json.load(open('$app/tests/fixtures/asr/manifest.json'));print(next(x['sha256'] for x in m['fixtures'] if x['file']=='en.wav'))")"
test "$expected" = "$(sha256sum "$app/tests/fixtures/asr/en.wav" | cut -d' ' -f1)"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x180:rate=25:duration=8" -i "$app/tests/fixtures/asr/en.wav" \
  -filter_complex "[1:a]apad,atrim=0:8[a]" -map 0:v:0 -map "[a]" -t 8 -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -g 25 \
  -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$out/qa88-source.mp4"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x180:rate=25:duration=8" -t 8 -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -g 25 \
  -an -movflags +faststart "$out/qa88-silent.mp4"
ffprobe -v error -show_entries stream=codec_name,width,height,avg_frame_rate,sample_rate,channels -show_entries format=duration -of compact "$out/qa88-source.mp4"
sha256sum "$out"/*.mp4
