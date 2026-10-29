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
fallback_url="https://security.debian.org/debian-security/pool/updates/main/f/ffmpeg/ffmpeg_${version}.orig.tar.xz"

cd /src
# A TLS receive reset (curl 35) is not covered by --retry alone. This is an
# idempotent, checksum-pinned GET. Both fixed HTTPS origins must supply the same
# bytes. Each has at most four attempts and a 120s retry window plus a final 90s
# transfer (at most 420s across both). Never extract partial/unverified archives.
trap 'rm -f "${archive}.part"' EXIT HUP INT TERM
download() {
  curl -fsSL --proto '=https' --proto-redir '=https' \
    --retry 3 --retry-all-errors --retry-delay 2 --retry-max-time 120 \
    --connect-timeout 15 --max-time 90 --remove-on-error \
    --output "${archive}.part" "$1"
}
if download "$url"; then
  :
else
  echo "Primary FFmpeg transfer failed; trying the checksum-identical Debian source" >&2
  rm -f "${archive}.part"
  download "$fallback_url"
fi
# A successful transfer with wrong bytes fails closed, without trying another
# origin. Transport recovery must never conceal a checksum-integrity failure.
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
