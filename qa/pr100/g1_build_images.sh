#!/bin/sh
# Build production media and render images with ffmpeg.org forced unreachable.
# The production build-ffmpeg.sh must fall back to Debian and still verify the approved SHA-256.
set -eu

role=${1:?media or render}
results=${2:?results jsonl}
out=${3:?output directory}
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$root"
mkdir -p "$out"
fail=0

record() {
  # shellcheck disable=SC2086
  python3 qa/pr100/emit_cli.py "$results" "$1" G1 "$2" true "$3" || fail=1
}

probe_image() {
  image=$1
  docker run --rm --user root --network none --entrypoint sh "$image" -c '
    ffprobe -version | head -n 1 | grep -q 7.1.5-editagent1
    if ldd /usr/local/bin/ffprobe /usr/local/bin/ffmpeg | grep -i xml; then exit 1; fi
    if ffmpeg -hide_banner -demuxers | grep -w dash; then exit 1; fi
    if dpkg -s libxml2 >/dev/null 2>&1; then exit 1; fi
    ffmpeg -hide_banner -protocols | grep -q file
    if ffmpeg -hide_banner -protocols | grep -w http; then exit 1; fi
  '
}

if [ "$role" = "media" ]; then
  if docker build --progress=plain --platform linux/amd64 \
      --add-host=ffmpeg.org:127.0.0.1 \
      --target ffmpeg \
      -f workers/media-worker/Dockerfile \
      -t qa-ffmpeg-stage:media . >"$out/media-stage.log" 2>&1; then
    digest=$(docker run --rm --entrypoint sha256sum qa-ffmpeg-stage:media /src/ffmpeg-7.1.5.tar.xz | awk '{print $1}')
    bytes=$(docker run --rm --entrypoint stat qa-ffmpeg-stage:media -c %s /src/ffmpeg-7.1.5.tar.xz)
    if [ "$digest" = "de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f" ] && [ "$bytes" = "11050340" ]; then
      record g1.media_archive_sha PASS "stage archive sha256=$digest bytes=$bytes"
    else
      record g1.media_archive_sha FAIL "stage archive sha256=$digest bytes=$bytes"
    fi
  else
    record g1.media_archive_sha FAIL "ffmpeg stage build failed; see media-stage.log"
  fi
  if grep -q "Primary FFmpeg transfer failed; trying the checksum-identical Debian source" "$out/media-stage.log"; then
    record g1.media_fallback_log PASS "production stage log shows Debian fallback after forced primary failure"
  else
    record g1.media_fallback_log FAIL "fallback message absent from media stage log"
  fi
  if docker build --progress=plain --platform linux/amd64 \
      --add-host=ffmpeg.org:127.0.0.1 \
      -f workers/media-worker/Dockerfile \
      -t qa-media-worker:independent . >"$out/media-image.log" 2>&1; then
    image_id=$(docker image inspect --format '{{.Id}}' qa-media-worker:independent)
    record g1.media_image_build PASS "image=$image_id"
    if probe_image qa-media-worker:independent >"$out/media-probe.txt" 2>&1; then
      version=$(docker run --rm --entrypoint ffprobe qa-media-worker:independent -version | head -n 1)
      record g1.media_ffprobe PASS "$version"
      record g1.media_no_dash_libxml2 PASS "dash demuxer, libxml2 linkage, and http protocol are absent"
    else
      record g1.media_ffprobe FAIL "probe failed"
      record g1.media_no_dash_libxml2 FAIL "restriction probe failed"
    fi
    if ./infra/scripts/verify-media-ffmpeg.sh qa-media-worker:independent >"$out/media-sandbox.log" 2>&1; then
      record g1.media_sandbox_probe PASS "verify-media-ffmpeg.sh passed on the QA-built image"
    else
      record g1.media_sandbox_probe FAIL "verify-media-ffmpeg.sh failed"
    fi
    work=$(mktemp -d)
    chmod 0777 "$work"
    if docker run --rm --network none --entrypoint ffmpeg -v "$work:/out" qa-media-worker:independent \
        -y -v error -filter_complex "color=c=blue:s=320x180:r=25:d=1,format=yuv420p[v];anullsrc=r=48000:d=1[a]" \
        -map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest /out/distinct.mp4 >"$out/distinct.log" 2>&1; then
      mode=synthetic-color
    elif docker run --rm --network none --entrypoint ffmpeg \
        -v "$root/packages/media-core/fixtures/media:/fixtures:ro" -v "$work:/out" qa-media-worker:independent \
        -y -v error -i /fixtures/normal.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac /out/distinct.mp4 >>"$out/distinct.log" 2>&1; then
      mode=fixture-reencode
    else
      mode=""
    fi
    if [ -n "$mode" ] && [ -s "$work/distinct.mp4" ]; then
      sha=$(sha256sum "$work/distinct.mp4" | awk '{print $1}')
      ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of json "$work/distinct.mp4" >"$out/distinct-ffprobe.json"
      record g1.distinct_input_transcode PASS "$mode sha256=$sha"
    else
      record g1.distinct_input_transcode FAIL "production ffmpeg did not encode a distinct input"
    fi
    rm -rf "$work"
  else
    record g1.media_image_build FAIL "media-worker image build failed"
    record g1.media_ffprobe FAIL "image absent"
    record g1.media_no_dash_libxml2 FAIL "image absent"
    record g1.media_sandbox_probe FAIL "image absent"
    record g1.distinct_input_transcode FAIL "image absent"
  fi
elif [ "$role" = "render" ]; then
  if docker build --progress=plain --platform linux/amd64 \
      --add-host=ffmpeg.org:127.0.0.1 \
      --target media-tools \
      -f workers/render-worker/Dockerfile \
      -t qa-ffmpeg-stage:render . >"$out/render-stage.log" 2>&1; then
    digest=$(docker run --rm --entrypoint sha256sum qa-ffmpeg-stage:render /src/ffmpeg-7.1.5.tar.xz | awk '{print $1}')
    if [ "$digest" = "de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f" ]; then
      record g1.render_archive_sha PASS "render media-tools archive sha256=$digest"
    else
      record g1.render_archive_sha FAIL "render archive sha256=$digest"
    fi
  else
    record g1.render_archive_sha FAIL "render media-tools stage failed"
  fi
  if grep -q "Primary FFmpeg transfer failed; trying the checksum-identical Debian source" "$out/render-stage.log"; then
    record g1.render_fallback_log PASS "render production stage used the Debian fallback"
  else
    record g1.render_fallback_log FAIL "render fallback message absent"
  fi
  worker_ok=0
  executor_ok=0
  if docker build --progress=plain --platform linux/amd64 \
      --add-host=ffmpeg.org:127.0.0.1 \
      -f workers/render-worker/Dockerfile \
      -t qa-render-worker:independent . >"$out/render-worker.log" 2>&1; then
    worker_ok=1
    record g1.render_worker_build PASS "$(docker image inspect --format '{{.Id}}' qa-render-worker:independent)"
  else
    record g1.render_worker_build FAIL "render-worker build failed"
  fi
  if docker build --progress=plain --platform linux/amd64 \
      --add-host=ffmpeg.org:127.0.0.1 \
      --target executor \
      -f workers/render-worker/Dockerfile \
      -t qa-render-executor:independent . >"$out/render-executor.log" 2>&1; then
    executor_ok=1
    record g1.render_executor_build PASS "$(docker image inspect --format '{{.Id}}' qa-render-executor:independent)"
  else
    record g1.render_executor_build FAIL "render-executor build failed"
  fi
  if [ "$worker_ok" = 1 ] && [ "$executor_ok" = 1 ] && probe_image qa-render-worker:independent && probe_image qa-render-executor:independent; then
    worker_version=$(docker run --rm --entrypoint ffprobe qa-render-worker:independent -version | head -n 1)
    executor_version=$(docker run --rm --entrypoint ffprobe qa-render-executor:independent -version | head -n 1)
    record g1.render_ffprobe_restrictions PASS "worker=$worker_version executor=$executor_version dash/libxml2/http absent"
  else
    record g1.render_ffprobe_restrictions FAIL "render image restriction probe failed"
  fi
else
  echo "unknown role $role" >&2
  exit 2
fi

exit "$fail"
