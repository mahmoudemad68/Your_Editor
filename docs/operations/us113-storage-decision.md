# US-113 storage decision

The open-source MinIO binary built from `github.com/minio/minio` tag `RELEASE.2025-10-15T17-29-55Z` still contains CVE-2026-33322 and CVE-2026-33419. No exception is authorized. This note compares the two ways to clear that block. It does not buy a license, deploy a service, or change the storage engine.

The current adapter in `apps/api/src/infrastructure/s3-object-storage.ts` needs:

- path-style `CreateBucket`, `PutObject`, `GetObject`, `HeadObject`, and `DeleteObject`
- `ChecksumSHA256` on upload and on `HeadObject`
- presigned `PutObject` whose signature covers `content-type`, `if-none-match`, and `x-amz-checksum-sha256`
- a private bucket, with the browser using a separate public host from the API's internal endpoint

## A. Verified patched AIStor release

The GitHub advisories name MinIO AIStor `RELEASE.2026-03-17T21-25-16Z` as the fixed release. That release is not in `github.com/minio/minio`. Using it needs an explicit procurement and licensing decision. This repository does not record a price, and it does not download the binary.

| Question                             | Assessment                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presigned uploads                    | Expected to keep the MinIO S3 behavior this API already tests. Must be re-run against the exact release before adoption.                                         |
| Required S3 operations               | Same API surface as the current server if the release remains S3-compatible.                                                                                     |
| Existing API integration             | The adapter can stay if the endpoint, path style, checksum, and `If-None-Match` behavior match.                                                                  |
| Persistence and backup               | The on-disk layout may differ from the open-source release. A backup and restore rehearsal is required before a volume is reused.                                |
| Authentication and network isolation | Root credentials remain. OIDC and LDAP can be enabled only after the patched binary is in place. The object ingress still must hide STS and admin from browsers. |
| Known security findings              | The two critical identity CVEs are fixed in the named AIStor release. Other findings have to be scanned on that exact image.                                     |
| Migration complexity                 | Replace the image and prove the volume. No application rewrite is implied.                                                                                       |
| Licensing and cost                   | Commercial or otherwise restricted terms are likely. A person has to accept the license and the operating cost. Neither is accepted here.                        |

## B. Maintained open-source S3-compatible replacement

SeaweedFS is the concrete candidate: Apache-2.0, an S3 gateway, and an active upstream. Garage (AGPL-3.0) and Ceph RGW (LGPL-2.1) are alternatives with heavier operations. None of them is approved. ADR-005 currently says MinIO. Changing that is an architecture decision, not a silent image swap.

| Question                             | Assessment                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Presigned uploads                    | Not demonstrated. SigV4 host, checksum, and `If-None-Match` behavior must be tested with `S3ObjectStorage` before an ADR.                    |
| Required S3 operations               | Must pass the same bucket, put, head, get, and delete calls the API uses.                                                                    |
| Existing API integration             | The port can stay. The adapter stays only if those calls match. A failed checksum or conditional put is a blocker.                           |
| Persistence and backup               | A new volume format. The current MinIO volume is not a drop-in backup source.                                                                |
| Authentication and network isolation | Use static credentials and the same ingress rule: browsers reach object methods only. Do not expose an admin or STS port.                    |
| Known security findings              | Must be scanned with the same Trivy critical gate before publish.                                                                            |
| Migration complexity                 | New compose service, data migration, and compatibility tests. Larger than an image replacement.                                              |
| Licensing and cost                   | SeaweedFS is Apache-2.0. Operating cost is the host we already need, not a license purchase. AGPL candidates need a separate license review. |

## Decision required

Pick one authorized path:

1. Procure a named AIStor release and accept its license, then replace the image and re-scan it.
2. Approve an ADR that replaces MinIO, then run the compatibility tests above.

Until then the MinIO image fails the critical scan, the security gate fails, and no image is published.
