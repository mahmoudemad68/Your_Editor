# SeaweedFS migration

ADR-005's 2026-10-04 revision replaces MinIO with SeaweedFS for development and staging. This procedure copies objects through the S3 API. It does not mount a MinIO volume as SeaweedFS data and it does not delete the MinIO volume.

## What stays

- The existing `S3ObjectStorage` adapter.
- Object keys already stored in PostgreSQL.
- The Docker volume that holds old MinIO data, such as `editagent_minio-data` or `editagent-staging_staging-minio-data`. Leave it in place until a later, separate decision removes it.

## Copy

1. Start the old MinIO process from its existing volume on an address that is not the new S3 port. Do not run `docker compose down -v`.
2. Start the SeaweedFS topology and create the destination bucket with the same name.
3. Copy each object with an S3 client that preserves the key, content type, and body. A suitable command shape is `aws s3 sync` or `rclone copy` with path-style addressing, from the MinIO endpoint to `http://127.0.0.1:19083` in development or to the staging S3 gateway on the Compose network.
4. Compare object counts and a sample of SHA-256 checksums. PostgreSQL rows must still point at the same keys.
5. Stop the temporary MinIO process. Do not delete its volume in the same step.

SeaweedFS filer metadata and volume files are a new layout. Restoring them is a stopped copy of the `seaweed-master`, `seaweed-volume`, and `seaweed-filer` volumes, replacing each directory rather than merging a later LevelDB log. Take that backup only after the copy has been checked.

## Secrets

`infra/seaweedfs/prepare-secrets.sh` writes `security.toml` once and rewrites `s3.json` from `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The directory is mode `0700`. The files are mode `0600` and owned by the uid reported by `id seaweed` in the pinned image. Staging sets `SEAWEED_REQUIRE_S3_ENV=1` and refuses the development defaults.

## Host isolation

After Compose creates the networks, `infra/seaweedfs/apply-compose-isolation.sh` installs and verifies host rules. IPv6 must be disabled on `storage_internal`. The script drops IPv4 to that subnet from the host and from other bridges, drops every port on the S3 container's application address except 8333, and drops IPv6 forwarded through the internal bridge. Run it again after a host reboot. A missing firewall chain or an IPv6-enabled storage network fails the deploy.
