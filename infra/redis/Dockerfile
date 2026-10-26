# syntax=docker/dockerfile:1
# Deployed Redis 7.4 image. The upstream tag's OpenSSL 3.3.7-r1 has HIGH
# CVE-2026-75804 and CVE-2026-84782, fixed in Alpine revision 3.3.7-r2.
# Upgrade through the signed apk index and reject anything older than that
# revision. A newer revision still satisfies the check.

FROM redis:8.0-alpine@sha256:5f61955be8ab2ccee9372b84ae4d4da2e2b156f87281e3f218544055e7ee04d4
USER root
COPY infra/redis/require-openssl.sh /usr/local/bin/require-openssl.sh
RUN chmod 0755 /usr/local/bin/require-openssl.sh \
    && apk add --no-cache --upgrade libcrypto3 libssl3 \
    && /usr/local/bin/require-openssl.sh 3.3.7-r2
USER redis
