# Critical image remediation

Baseline is supply-chain run [37217829799](https://github.com/mahmoudemad68/Your_Editor/actions/runs/37217829799) on scanner SHA `654ca3fcc4f9ba23bc7bb7269c7674a03803ca65`. Trivy 0.75.0, vulnerability database updated `2026-10-04T14:28:15Z`. The scanner policy is unchanged: HIGH and CRITICAL are reported, CRITICAL fails the image before a pass file is written, and there is no ignore file.

Counts are Trivy instances, not distinct CVE IDs. The after column is a local rebuild scanned with the same `supply-chain-scan-image.sh` flags.

| Image         | Before critical | Before high | After critical | After high |
| ------------- | --------------: | ----------: | -------------: | ---------: |
| api           |               5 |          66 |              0 |         59 |
| web           |               5 |          66 |              0 |         59 |
| render-worker |               5 |          66 |              0 |         59 |
| agent-worker  |               5 |          66 |              0 |         59 |
| ai-worker     |               5 |          60 |              0 |         47 |
| media-worker  |              11 |         254 |              1 |        228 |
| minio         |               7 |          60 |              2 |         32 |
| postgres      |               3 |          47 |              0 |          0 |
| redis         |               0 |           4 |              0 |          0 |

## Resolved

Shared Debian 12 findings on the Node and Python images came from `node:22.23.2-bookworm-slim` and `python:3.11-slim-bookworm`. The runtime images now use digest-pinned Debian 13 bases:

- `node:22.23.3-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4`
- `python:3.11-slim-trixie@sha256:45037981b62b34b44602584fccbc4d884d5f7dc92c7ee86bb38a698a79fe1e51`

That removes CVE-2023-45853 (`zlib1g`), CVE-2026-13221, CVE-2026-42496, and CVE-2026-8376 (`perl-base`), CVE-2026-59873 (`tar` 7.5.11 inside the Node image's npm), and CVE-2025-7458 (`libsqlite3-0` on the AI worker). Local scans of api, web, render-worker, agent-worker, and ai-worker reported zero critical findings.

Media-worker FFmpeg moves from Debian 12 `7:5.1.9-0+deb12u1` to Debian 13 `7:7.1.5-0+deb13u1`. `ffprobe version 7.1.5-0+deb13u1` runs in the image. That removes CVE-2023-6879 (`libaom3`), CVE-2025-47917, CVE-2026-34873, and CVE-2026-34875 (`libmbedcrypto7`), and CVE-2026-58016 (`libglib2.0-0`).

Postgres is now built from `infra/postgres/Dockerfile`. The base is `postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` (PostgreSQL 16.15, Alpine 3.24), which no longer contains CVE-2026-31789. `gosu` 1.19 is recompiled with Go 1.25.14 from `github.com/tianon/gosu@v0.0.0-20260606051551-40506998e34a`, the same approach as the US-113 image, so CVE-2025-68121 is absent. The local scan reported zero critical and zero high findings. `postgres --version` prints 16.15 and `gosu --version` prints `1.19 (go1.25.14)`.

Redis stays on 7.4.11. `infra/redis/Dockerfile` upgrades `libcrypto3` and `libssl3` through the signed Alpine index and rejects any revision older than `3.3.7-r2`, which is the fix for HIGH CVE-2026-75804 and CVE-2026-84782. A newer revision still builds. The local HIGH,CRITICAL scan reported zero findings. `redis-server --version` prints `v=7.4.11`.

MinIO is still built from tag `RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`. The toolchain is Go 1.25.14, which removes CVE-2025-68121. The build also upgrades `google.golang.org/grpc` to v1.79.3 and `github.com/rabbitmq/amqp091-go` to v1.13.0, which removes CVE-2026-33186, CVE-2026-77405, CVE-2026-77408, and CVE-2026-77411. `minio --version` still reports that upstream release and commit, with runtime `go1.25.14`.

## Still open

These critical findings have no fixed package version in this Trivy database. They are not ignored and they are not accepted.

| CVE            | Where                                                         | Why it remains                                                                                                       | Options for the project owner                                                                                                                                             |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CVE-2026-6653  | media-worker `libxml2` `2.12.7+dfsg+really2.9.14-2.1+deb13u3` | Debian 13 `libavformat61` depends on `libxml2`. Removing the package removes FFmpeg. Trivy reports no fixed version. | Wait for a Debian security update. Or build FFmpeg without libxml2, which drops XML-backed demuxers and is a separate media change.                                       |
| CVE-2026-33322 | MinIO binary, tag `RELEASE.2025-10-15T17-29-55Z`              | GitHub lists no newer MinIO release. Trivy reports no fixed version. The issue is JWT algorithm confusion in OIDC.   | Keep this MinIO build and leave the finding open. Or adopt the SeaweedFS design from PR #18 as its own reviewed change. This pull request does not switch object storage. |
| CVE-2026-33419 | Same MinIO binary                                             | Same release. LDAP login brute-force via user enumeration, no fixed version.                                         | Same options as CVE-2026-33322.                                                                                                                                           |

HIGH findings remain on the Debian application images and on MinIO. They are reported and do not by themselves fail the critical gate. They are not accepted.

The GitHub Actions `ci` job still starts a Postgres service from the upstream `postgres:16-alpine` digest because a service container cannot run `infra/postgres/Dockerfile` without a published image. That upstream image still contains the old `gosu` binary. The image Compose deploys is the rebuilt one, and that rebuilt image scanned clean. The `ci` Redis service remains `redis:7.4-alpine`, which still has the two HIGH OpenSSL findings. The image Compose deploys is `infra/redis/Dockerfile`, which scanned clean.

`supply-chain-security` stays red while CVE-2026-6653, CVE-2026-33322, or CVE-2026-33419 remain. This document does not claim a green security gate.
