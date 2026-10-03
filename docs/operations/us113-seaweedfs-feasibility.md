# SeaweedFS feasibility proof

This is an investigation. MinIO remains the development object store. ADR-005 stays Accepted. The proposed revision in that record is not approved.

## Environment

- Image: `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`
- Tag recorded with that digest: `4.48`
- License: Apache-2.0 (`github.com/seaweedfs/seaweedfs`)
- Compose project: `editagent-seaweedfs-spike`
- Volume: `editagent-seaweedfs-spike_seaweedfs-spike-data`
- Published port: `127.0.0.1:18333` to container port 8333
- Existing MinIO volume `editagent_minio-data` was not mounted, migrated, or deleted
- Image size: 529,212,727 bytes
- Observed process memory after startup: about 73 MiB
- Syft SBOM: SPDX 2.3, 284 packages
- Trivy 0.75.0, `--severity CRITICAL,HIGH`: no findings in the Alpine 3.24.2 base or `usr/bin/weed`

The critical publish gate was not changed and was not pointed at this image.

## Compatibility

The test `tests/architecture/seaweedfs-s3-spike.test.mjs` uses the built `S3ObjectStorage` class. Checksum validation and `If-None-Match: *` stayed in place.

| Requirement                  | Result | Evidence                                                                                      |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| CreateBucket                 | PASS   | `ensureBucket()` completed                                                                    |
| PutObject                    | PASS   | `put()` completed                                                                             |
| GetObject                    | PASS   | returned bytes matched the upload                                                             |
| HeadObject                   | PASS   | `stat()` returned size, type, and checksum                                                    |
| DeleteObject                 | PASS   | `stat()` returned null afterward                                                              |
| Path-style requests          | PASS   | signed URL path started with `/editagent-spike/`                                              |
| ChecksumSHA256 on upload     | PASS   | `put()` and the signed PUT sent `x-amz-checksum-sha256`                                       |
| ChecksumSHA256 on HeadObject | PASS   | `stat().checksumSha256Hex` matched the SHA-256 of the body                                    |
| Presigned PUT                | PASS   | HTTP 200                                                                                      |
| SigV4 Host                   | PASS   | URL host was `127.0.0.1:18333` for the direct client and the ingress host for the proxied PUT |
| Signed Content-Type          | PASS   | changing it returned 403 `SignatureDoesNotMatch`                                              |
| Signed If-None-Match         | PASS   | omitting it returned 403 `SignatureDoesNotMatch`                                              |
| Signed x-amz-checksum-sha256 | PASS   | omitting it returned 403 `SignatureDoesNotMatch`                                              |
| Duplicate object protection  | PASS   | second PUT returned 412                                                                       |
| Upload completion checks     | PASS   | size, `video/mp4`, and checksum matched the declaration                                       |

## Ingress, network, and credentials

The existing object ingress accepted the signed PUT (HTTP 200) and returned 403 for `POST /?Action=AssumeRoleWithLDAPIdentity` and `GET /minio/admin/v3/info`.

S3 credentials are a mounted JSON file, `infra/seaweedfs-spike/s3.json`. They are spike values, not the MinIO root password, and they are not baked into the image.

`weed mini` also listens, inside the container, on the master UI, volume server, filer, WebDAV, Iceberg, Lance, and admin ports. Compose publishes only 8333. On this host, the container bridge address still answered the admin UI on port 23646 and the filer on port 8888. Unpublished ports are not same-host isolation. The spike now sets an admin username and password. A shared environment must keep those extra ports off the host firewall and must not reuse this password.

## Operations

SeaweedFS data lives under `/data` as filer LevelDB, master snapshots, and volume files. That is not the MinIO layout under `.minio.sys`. A MinIO volume cannot be mounted as a SeaweedFS volume.

Backup is a copy of `/data` while the process is stopped, or an S3 copy of the objects. Restore is the reverse. Postgres metadata is unchanged and must still point at the copied keys. The two stores are restored together, as ADR-005 already requires.

A migration would create a new volume, copy objects through the S3 API, then point `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` at SeaweedFS and the object ingress. It would not be an in-place disk conversion.

## Feasibility

Replacing MinIO is technically feasible for the guarantees this adapter enforces. No application change was required for the tests above. The work that remains is operational: one process with several internal ports, a new volume, an S3 copy, and an accepted ADR. The critical MinIO CVEs are not in this image. High and critical Trivy findings were not reported for this digest. That scan is not a waiver for later versions.

AIStor remains the other unaccepted option. It needs a license. This proof did not purchase one.
