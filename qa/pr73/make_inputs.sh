#!/usr/bin/env bash
# QA-generated inputs: synthetic video + repository hash-verified licensed speech fixtures.
# Each asset differs in bytes so uploads create distinct MediaAssets.
set -euo pipefail
out="$1"; app="$2"
mkdir -p "$out"
check() {
  local f="$1" expected actual
  expected="$(python3 -c "import json;m=json.load(open('$app/tests/fixtures/asr/manifest.json'));print(next(x['sha256'] for x in m['fixtures'] if x['file']=='$f'))")"
  actual="$(sha256sum "$app/tests/fixtures/asr/$f" | cut -d' ' -f1)"
  test "$expected" = "$actual"
}
check en.wav; check ar-long.wav; check ar.wav
mk() { # name crf seconds audio
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x240:rate=25:duration=$3" -i "$app/tests/fixtures/asr/$4" \
    -map 0:v:0 -map 1:a:0 -t "$3" -c:v libx264 -preset veryfast -crf "$2" -pix_fmt yuv420p -g 25 \
    -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$out/$1.mp4"
}
mk qa-source 16 8 en.wav
mk qa-timeout 18 8 en.wav
mk qa-deadline 19 8 en.wav
mk qa-delete-locked 21 8 en.wav
mk qa-delete-running 22 8 en.wav
mk qa-ar-long 17 60 ar-long.wav
# Code-switched composites (QA-constructed from the hash-verified licensed fixtures) and a silent-audio asset.
mkcat() { # name crf first second
  ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x240:rate=25:duration=16" -i "$app/tests/fixtures/asr/$3" -i "$app/tests/fixtures/asr/$4" \
    -filter_complex "[1:a][2:a]concat=n=2:v=0:a=1[a]" -map 0:v:0 -map "[a]" -t 16 -c:v libx264 -preset veryfast -crf "$2" -pix_fmt yuv420p -g 25 \
    -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$out/$1.mp4"
}
mkcat qa-en-ar 16 en.wav ar.wav
mkcat qa-ar-en 17 ar.wav en.wav
mkcat qa-upgrade-en-ar 23 en.wav ar.wav
ffmpeg -v error -y -f lavfi -i "testsrc2=size=320x240:rate=25:duration=8" -f lavfi -i "anullsrc=r=48000:cl=stereo" \
  -map 0:v:0 -map 1:a:0 -t 8 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -g 25 -c:a aac -b:a 160k -movflags +faststart "$out/qa-silence.mp4"
sha256sum "$out"/*.mp4
