# Development MinIO image.
# docker.io/minio/minio was removed in September 2026. This wraps the community
# republish of MinIO RELEASE.2025-10-15T17-29-55Z. The entrypoint starts as root
# only to make the data volume writable, then the server process runs as minio.
# syntax=docker/dockerfile:1

FROM alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4

USER root
RUN apk add --no-cache su-exec \
    && mkdir -p /data \
    && chown minio:minio /data
COPY infra/minio/entrypoint.sh /usr/local/bin/minio-entrypoint
RUN chmod 0755 /usr/local/bin/minio-entrypoint
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio-entrypoint"]
CMD ["server", "/data", "--console-address", ":9001"]
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=20 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9000/minio/health/live"]
