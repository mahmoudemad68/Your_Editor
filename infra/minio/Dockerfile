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
# The first stage holds the Go toolchain. The runtime stage does not.
# No MinIO credentials are set in the image. The entrypoint is root only
# long enough to make the mounted /data directory writable, then the
# server process runs as the non-root minio user (uid 1000).

FROM golang:1.26.8-alpine3.23@sha256:a8fa79c5bd40d880b52bd3b6d7669ecdcfd00e85facdd427d279efb5ddd79cb1 AS build

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
# These two modules have published fixes. The MinIO module stays on the
# upstream tag above. github.com/minio/minio has no newer open-source release.
RUN go get github.com/rabbitmq/amqp091-go@v1.13.0 \
    && go get google.golang.org/grpc@v1.79.3 \
    && go mod tidy
RUN ldflags="$(go run buildscripts/gen-ldflags.go "${MINIO_VERSION_TIME}")" \
    && CGO_ENABLED=0 GOFLAGS=-mod=readonly go build -p 1 -tags kqueue -trimpath --ldflags "${ldflags}" -o /out/minio .

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0

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
