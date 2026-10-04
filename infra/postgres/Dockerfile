# syntax=docker/dockerfile:1
# Staging Postgres. Upstream postgres:16.13-alpine vendors gosu 1.19 built with
# Go 1.24.6, which Trivy reports as CVE-2025-68121. Rebuild that gosu release
# with the pinned Go toolchain so the critical finding is actually removed.

FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS gosu
ENV CGO_ENABLED=0
RUN go install github.com/tianon/gosu@v0.0.0-20260606051551-40506998e34a

FROM postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50
USER root
COPY --from=gosu /go/bin/gosu /usr/local/bin/gosu
RUN gosu nobody true && gosu --version
USER postgres
