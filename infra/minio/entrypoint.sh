#!/bin/sh
# Prepare the data directory, then run MinIO as the unprivileged minio user.
# CVE-2026-33322 and CVE-2026-33419 have no fix in github.com/minio/minio.
# This guard does not hide those findings from Trivy. It refuses the two
# identity modes those findings describe.
set -eu
if env | grep -E '^(MINIO_IDENTITY_OPENID_|MINIO_IDENTITY_LDAP_)' >/dev/null; then
  echo "Refusing to start. This open-source MinIO build has no fix for CVE-2026-33322 or CVE-2026-33419." >&2
  echo "Unset MINIO_IDENTITY_OPENID_* and MINIO_IDENTITY_LDAP_* or replace the image." >&2
  exit 1
fi
mkdir -p /data
chown minio:minio /data
exec su-exec minio:minio minio "$@"
