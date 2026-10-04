# syntax=docker/dockerfile:1
# Deployed Redis 7.4 image. The upstream tag's OpenSSL 3.3.7-r1 has HIGH
# CVE-2026-75804 and CVE-2026-84782. Alpine 3.21 publishes 3.3.7-r2. This
# image stays on Redis 7.4 and upgrades only those two packages.

FROM redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
USER root
RUN apk add --no-cache --upgrade 'libcrypto3=3.3.7-r2' 'libssl3=3.3.7-r2' \
    && grep -A1 '^P:libcrypto3$' /lib/apk/db/installed | grep -qx 'V:3.3.7-r2' \
    && grep -A1 '^P:libssl3$' /lib/apk/db/installed | grep -qx 'V:3.3.7-r2'
USER redis
