#!/bin/sh
# Build FFmpeg 7.1.5 without libxml2.
# The SHA-256 matches Debian's ffmpeg_7.1.5-0+deb13u1.dsc checksum for
# ffmpeg_7.1.5.orig.tar.xz and the bytes published at ffmpeg.org.
# MPEG-DASH demuxing needs libxml2. The SRS accepted containers are MP4, MOV,
# MKV, and WebM, so the dash demuxer is not built and the package must stay absent.
set -eu

version=7.1.5
expected=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
archive="ffmpeg-${version}.tar.xz"
url="https://ffmpeg.org/releases/${archive}"

cd /src
# A TLS receive reset (curl 35) is not covered by --retry alone. This is an
# idempotent, checksum-pinned GET to one trusted HTTPS source. Retry all transfer
# errors, with at most four attempts; a final transfer can finish at most 120s
# after the 300s retry window. Never extract a partial or unverified archive.
trap 'rm -f "${archive}.part"' EXIT HUP INT TERM
curl -fsSL --proto '=https' --proto-redir '=https' \
  --retry 3 --retry-all-errors --retry-delay 2 --retry-max-time 300 \
  --connect-timeout 15 --max-time 120 --remove-on-error \
  --output "${archive}.part" "$url"
echo "${expected}  ${archive}.part" | sha256sum -c -
mv "${archive}.part" "$archive"
tar -xJf "$archive"
cd "ffmpeg-${version}"

./configure \
  --prefix=/usr/local \
  --extra-version=editagent1 \
  --disable-everything \
  --disable-autodetect \
  --disable-doc \
  --disable-network \
  --disable-ffplay \
  --disable-shared \
  --enable-static \
  --enable-gpl \
  --enable-zlib \
  --enable-libx264 \
  --enable-libvpx \
  --enable-libopus \
  --disable-libxml2 \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-avcodec \
  --enable-avformat \
  --enable-avutil \
  --enable-swscale \
  --enable-swresample \
  --enable-avfilter \
  --enable-protocol=file,pipe \
  --enable-demuxer=mov,matroska,wav,pcm_s16le,image_png_pipe \
  --enable-muxer=mp4,mov,matroska,webm,wav,ipod,image2,null,pcm_f32le \
  --enable-decoder=mjpeg,h264,hevc,vp9,av1,aac,opus,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,png \
  --enable-encoder=libx264,aac,libvpx_vp9,libopus,pcm_s16le,pcm_f32le,mjpeg \
  --enable-parser=h264,hevc,vp9,av1,aac,opus,png \
  --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe \
  --enable-filter=aresample,scale,format,aformat,null,anull,trim,atrim,concat,setpts,asetpts,settb,asettb,fps,tpad,apad,pad,tile,setsar,transpose,hflip,vflip,select,silencedetect,ebur128,color,anullsrc,crop,atempo,loudnorm,acrossfade,afade

make -j"$(nproc)"
make install

if ldd /usr/local/bin/ffprobe /usr/local/bin/ffmpeg | grep -i xml; then
  echo "ffprobe or ffmpeg is linked to libxml2" >&2
  exit 1
fi
if ffmpeg -hide_banner -demuxers | grep -w dash; then
  echo "MPEG-DASH demuxer was built" >&2
  exit 1
fi
ffmpeg -hide_banner -demuxers | grep -q 'matroska,webm'
ffmpeg -hide_banner -demuxers | grep -q 'mov,mp4'
ffmpeg -hide_banner -demuxers | grep -q 'png_pipe'
ffprobe -version | head -n 1 | grep -q '7.1.5-editagent1'

# The cut renderer needs sample-count join ramps; fail the build if omitted.
ffmpeg -hide_banner -filters | grep -q ' afade '
