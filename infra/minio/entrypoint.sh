#!/bin/sh
# Prepare the data directory, then run MinIO as the unprivileged minio user.
# Rejecting OIDC and LDAP configuration does not patch CVE-2026-33322 or
# CVE-2026-33419. Replacing this entrypoint requires host administrator
# control of the container runtime and is a separate trust boundary.
set -eu
/usr/local/bin/reject-vulnerable-identity
mkdir -p /data
chown minio:minio /data
exec su-exec minio:minio minio "$@"
