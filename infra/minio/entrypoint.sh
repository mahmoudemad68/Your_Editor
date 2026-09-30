#!/bin/sh
# Prepare the data directory, then run MinIO as the unprivileged minio user.
set -eu
mkdir -p /data
chown minio:minio /data
exec su-exec minio:minio minio "$@"
