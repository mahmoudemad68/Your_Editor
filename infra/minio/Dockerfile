# syntax=docker/dockerfile:1
# Development MinIO image for ADR-005. The product decision stays MinIO.
#
# docker.io/minio/minio is no longer published, and the upstream security
# release is distributed as source. This image is built from the official
# github.com/minio/minio tag RELEASE.2025-10-15T17-29-55Z
# (commit 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a). A community republish
# such as alpine/minio is not the supply-chain baseline: those binaries
# report DEVELOPMENT.GOGET. MINIO_RELEASE=RELEASE makes `minio --version`
# report the upstream release tag and that commit.
#
# The build uses Go 1.25.14 and upgrades grpc to v1.79.3 and amqp091-go to
# v1.13.0. The latest upstream tag is still RELEASE.2025-10-15T17-29-55Z.
# Trivy reports CVE-2026-33322 and CVE-2026-33419 in github.com/minio/minio
# with no fixed release. Those two findings stay open. This image does not
# ignore them.
# The first stage holds the Go toolchain. The runtime stage does not.
# No MinIO credentials are set in the image. The entrypoint is root only
# long enough to make the mounted /data directory writable, then the
# server process runs as the non-root minio user (uid 1000).

FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build

ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MINIO_VERSION_TIME=2025-10-15T17:29:55Z

RUN apk add --no-cache git
WORKDIR /src
RUN git init \
    && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth 1 origin "refs/tags/${MINIO_TAG}:refs/tags/${MINIO_TAG}" \
    && git checkout --detach "${MINIO_TAG}" \
    && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"

ENV CGO_ENABLED=0 \
    MINIO_RELEASE=RELEASE
# The pinned tag vendors grpc v1.72.0 and amqp091-go v1.10.0. Those modules
# have fixed releases. The MinIO module itself has no fixed release for
# CVE-2026-33322 or CVE-2026-33419, so those stay in the binary.
RUN go get google.golang.org/grpc@v1.79.3 github.com/rabbitmq/amqp091-go@v1.13.0 \
    && go mod tidy
RUN ldflags="$(go run buildscripts/gen-ldflags.go "${MINIO_VERSION_TIME}")" \
    && CGO_ENABLED=0 go build -p 1 -tags kqueue -trimpath --ldflags "${ldflags}" -o /out/minio .

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache ca-certificates su-exec wget \
    && addgroup -g 1000 -S minio \
    && adduser -S -D -H -u 1000 -G minio -s /sbin/nologin minio \
    && mkdir -p /data \
    && chown minio:minio /data

COPY --from=build /out/minio /usr/local/bin/minio
COPY infra/minio/entrypoint.sh /usr/local/bin/minio-entrypoint
RUN chmod 0755 /usr/local/bin/minio /usr/local/bin/minio-entrypoint

EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio-entrypoint"]
CMD ["server", "/data", "--console-address", ":9001"]
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=20 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9000/minio/health/live"]
