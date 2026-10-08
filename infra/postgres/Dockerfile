# syntax=docker/dockerfile:1
# Deployed Postgres image. postgres:16.15 on Alpine 3.24 clears the OpenSSL
# critical CVE-2026-31789 that postgres:16.10-alpine reported. Upstream still
# ships gosu 1.19 built with Go 1.24.6 (CVE-2025-68121). This image replaces
# that binary with the same gosu revision compiled by Go 1.25.14.

FROM golang:1.27-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS gosu
ENV CGO_ENABLED=0
RUN go install github.com/tianon/gosu@v0.0.0-20260606051551-40506998e34a

FROM postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
USER root
COPY --from=gosu /go/bin/gosu /usr/local/bin/gosu
RUN gosu nobody true && gosu --version
USER postgres
