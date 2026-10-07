# syntax=docker/dockerfile:1
# Test-only: MinIO community images/downloads were withdrawn after archival.
# Build the final upstream release from its immutable commit/release checksum.
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
ADD --checksum=sha256:be6d0bd3696c3a13a35f02d3a0280b64319c67918b4501c5c3d87f96d000085c https://github.com/minio/minio/archive/refs/tags/RELEASE.2025-10-15T17-29-55Z.tar.gz /source.tar.gz
RUN mkdir /src /out /data && tar -xzf /source.tar.gz -C /src --strip-components=1
WORKDIR /src
# Archived upstream dependencies patched to fixed versions; checked-in Go sums
# make this test-only rebuild deterministic (no go get/latest during builds).
COPY tests/integration/support/minio.go.mod /src/go.mod
COPY tests/integration/support/minio.go.sum /src/go.sum
# Optional managed-cloud trust; no session certificate is retained in the image.
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/minio .
FROM scratch
COPY --from=build /out/minio /minio
COPY --from=build --chown=10001:10001 /data /data
USER 10001:10001
EXPOSE 9000
ENTRYPOINT ["/minio"]
CMD ["server", "/data", "--address", ":9000"]
