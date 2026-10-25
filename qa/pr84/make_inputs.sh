#!/usr/bin/env bash
# QA-generated input: synthetic video + repository hash-verified licensed speech fixture.
set -euo pipefail
out="$1"; app="$2"
mkdir -p "$out"
expected="$(python3 -c "import json;m=json.load(open('$app/tests/fixtures/asr/manifest.json'));print(next(x['sha256'] for x in m['fixtures'] if x['file']=='en.wav'))")"
test "$expected" = "$(sha256sum "$app/tests/fixtures/asr/en.wav" | cut -d' ' -f1)"
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x240:rate=25:duration=8" -i "$app/tests/fixtures/asr/en.wav" \
  -map 0:v:0 -map 1:a:0 -t 8 -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p -g 25 \
  -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$out/qa-source.mp4"
sha256sum "$out"/*.mp4
