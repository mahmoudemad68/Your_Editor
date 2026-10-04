# SeaweedFS object storage

The active Compose stack uses SeaweedFS instead of MinIO. `S3ObjectStorage` is unchanged. API calls use `S3_ENDPOINT=http://seaweed-s3:8333`. Presigned browser URLs use `S3_PUBLIC_ENDPOINT`, published only on `127.0.0.1`.

## Topology

One digest-pinned image runs four roles:

| Role       | DNS name         | Port             | Network                                        |
| ---------- | ---------------- | ---------------- | ---------------------------------------------- |
| Master     | `seaweed-master` | 9333, gRPC 19333 | `storage_internal` only                        |
| Volume     | `seaweed-volume` | 8080             | `storage_internal` only                        |
| Filer      | `seaweed-filer`  | 8888             | `storage_internal` only                        |
| S3 gateway | `seaweed-s3`     | 8333             | `storage_internal` and the application network |

`storage_internal` is an internal Compose network, so it has no route off the Docker host. Master, volume, and filer publish no host ports. The gateway is bound to `127.0.0.1:${S3_PORT:-9000}`.

The image is `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` (SeaweedFS 4.48, Alpine 3.24.2). A Trivy HIGH,CRITICAL scan of that digest reported zero findings. The upstream entrypoint drops to uid 1000 after fixing `/data` ownership.

## Secrets

`make up` runs `infra/seaweedfs/prepare-secrets.sh`. The directory is mode `0700`. `security.toml` and `s3.json` are mode `0600` and owned by the `seaweed` user. An existing `security.toml` is kept so a restart does not rotate JWT keys. `s3.json` is rewritten from `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. `SEAWEED_REQUIRE_S3_ENV=1` refuses the development secret. The UI is disabled and filer directory metadata is not exposed.

## S3 contract

Verified against this image:

- SigV4 `PutObject`, `GetObject`, and `HeadObject`.
- `Content-Type` and `ChecksumSHA256` round-trip.
- Presigned PUT with `If-None-Match: *` returns 412 when the key exists and 200 when it does not.
- An anonymous GET of a private key returns 403 and does not return the body.

## Persistence, backup, restore

Master, volume, and filer each have their own volume. `infra/seaweedfs/backup-volumes.sh` stops those roles, writes one tar per volume, and starts them again. `infra/seaweedfs/restore-volumes.sh` stops them, clears each data directory, extracts the matching archive, and starts them. A restore replaces the directory. It does not merge a later log onto an older one.

## MinIO history

`minio-data` remains declared and unmounted. `infra/scripts/migrate-minio-objects.py` copies keys, content types, and bodies from a source S3 endpoint to the SeaweedFS gateway and checks SHA-256. It has no delete-source or delete-volume mode. Do not run `docker compose down -v` as part of the copy.
