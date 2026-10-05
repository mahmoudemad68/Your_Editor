# syntax=docker/dockerfile:1
# Deployed Redis 7.4 image. The upstream tag's OpenSSL 3.3.7-r1 has HIGH
# CVE-2026-75804 and CVE-2026-84782, fixed in Alpine revision 3.3.7-r2.
# Upgrade through the signed apk index and reject anything older than that
# revision. A newer revision still satisfies the check.

FROM redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
USER root
COPY infra/redis/require-openssl.sh /usr/local/bin/require-openssl.sh
RUN chmod 0755 /usr/local/bin/require-openssl.sh \
    && apk add --no-cache --upgrade libcrypto3 libssl3 \
    && /usr/local/bin/require-openssl.sh 3.3.7-r2
USER redis
