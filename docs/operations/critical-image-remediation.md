# Critical image remediation

Baseline is supply-chain run [37217829799](https://github.com/mahmoudemad68/Your_Editor/actions/runs/37217829799) on scanner SHA `654ca3fcc4f9ba23bc7bb7269c7674a03803ca65`. Trivy 0.75.0, vulnerability database updated `2026-10-04T14:28:15Z`. The scanner policy is unchanged: HIGH and CRITICAL are reported, CRITICAL fails the image before a pass file is written, and there is no ignore file.

Counts are Trivy instances, not distinct CVE IDs. The after column is a local rebuild scanned with the same `supply-chain-scan-image.sh` flags.

| Image         | Before critical | Before high | After critical |   After high |
| ------------- | --------------: | ----------: | -------------: | -----------: |
| api           |               5 |          66 |              0 |           59 |
| web           |               5 |          66 |              0 |           59 |
| render-worker |               5 |          66 |              0 |           59 |
| agent-worker  |               5 |          66 |              0 |           59 |
| ai-worker     |               5 |          60 |              0 |           47 |
| media-worker  |              11 |         254 |              0 |           59 |
| minio         |               7 |          60 |   not deployed | not deployed |
| seaweedfs     |               — |           — |              0 |            0 |
| postgres      |               3 |          47 |              0 |            0 |
| redis         |               0 |           4 |              0 |            0 |

## Resolved

Shared Debian 12 findings on the Node and Python images came from `node:22.23.2-bookworm-slim` and `python:3.11-slim-bookworm`. The runtime images now use digest-pinned Debian 13 bases:

- `node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4`
- `python:3.11-slim-trixie@sha256:45037981b62b34b44602584fccbc4d884d5f7dc92c7ee86bb38a698a79fe1e51`

That removes CVE-2023-45853 (`zlib1g`), CVE-2026-13221, CVE-2026-42496, and CVE-2026-8376 (`perl-base`), CVE-2026-59873 (`tar` 7.5.11 inside the Node image's npm), and CVE-2025-7458 (`libsqlite3-0` on the AI worker). Local scans of api, web, render-worker, agent-worker, and ai-worker reported zero critical findings.

Media-worker FFmpeg is built from the upstream 7.1.5 tarball, SHA-256 `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`. That checksum is the one Debian records for `ffmpeg_7.1.5.orig.tar.xz` in `ffmpeg_7.1.5-0+deb13u1.dsc`. The build passes `--disable-libxml2` and does not enable the MPEG-DASH demuxer. `ffprobe version 7.1.5-editagent1` is linked to `libx264`, `libvpx`, and `libopus` only. The runtime image does not install the `libxml2` package. A local HIGH,CRITICAL scan reported zero critical findings and 59 high findings. The process still runs as uid 10001.

The SRS accepted containers are MP4, MOV, MKV, and WebM. Probes of those four succeed, including an H.264/AAC re-encode, a VP9/Opus WebM, the rotated MOV fixture, variable-frame-rate MP4 timestamps, WAV PCM, and the PNG fixture. MPEG-DASH is not an accepted input. Debian's `ffmpeg` package demuxes it through `libxml2`. This build rejects an MPD with `Invalid data found when processing input` and `ffmpeg -demuxers` does not list `dash`. That is the assessed loss. It is not a removed SRS capability.

`ffprobe` reports `format_name` `matroska,webm` for both MKV and WebM. Debian `7.1.5-0+deb13u1` does the same. `containerOf` therefore still labels both WebM. Demuxing both containers works.

Postgres is now built from `infra/postgres/Dockerfile`. The base is `postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` (PostgreSQL 16.15, Alpine 3.24), which no longer contains CVE-2026-31789. `gosu` 1.19 is recompiled with Go 1.25.14 from `github.com/tianon/gosu@v0.0.0-20260606051551-40506998e34a`, the same approach as the US-113 image, so CVE-2025-68121 is absent. The local scan reported zero critical and zero high findings. `postgres --version` prints 16.15 and `gosu --version` prints `1.19 (go1.25.14)`.

Redis stays on 7.4.11. `infra/redis/Dockerfile` upgrades `libcrypto3` and `libssl3` through the signed Alpine index and rejects any revision older than `3.3.7-r2`, which is the fix for HIGH CVE-2026-75804 and CVE-2026-84782. A newer revision still builds. The local HIGH,CRITICAL scan reported zero findings. `redis-server --version` prints `v=7.4.11`.

MinIO is not started by Compose or CI. The active object store is SeaweedFS at `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`. That digest's HIGH,CRITICAL scan reported zero findings. `S3ObjectStorage` is unchanged. The historical `minio-data` volume stays declared and unmounted. Object copy is `infra/scripts/migrate-minio-objects.py`, which does not delete volumes.

## Critical findings in the active images

CVE-2026-33322 and CVE-2026-33419 belong to the MinIO binary. They are not ignored and they have no upstream fix. MinIO is not in Compose, CI, or the supply-chain matrix, so those findings are not in an image this workflow builds. The `minio-data` volume is kept.

HIGH findings remain on the Debian application images. They are reported and do not by themselves fail the critical gate. They are not accepted.

The GitHub Actions `ci` job still starts a Postgres service from the upstream `postgres:16-alpine` digest because a service container cannot run `infra/postgres/Dockerfile` without a published image. That upstream image still contains the old `gosu` binary. The image Compose deploys is the rebuilt one, and that rebuilt image scanned clean. The `ci` Redis service remains `redis:7.4-alpine`, which still has the two HIGH OpenSSL findings. The image Compose deploys is `infra/redis/Dockerfile`, which scanned clean.

The critical gate is expected to pass for the images this workflow builds. HIGH findings are still open, so the security definition of done is not complete.
