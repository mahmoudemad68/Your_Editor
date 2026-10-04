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

| Question                             | Assessment                                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presigned uploads                    | Demonstrated on SeaweedFS 4.48 with the unchanged adapter, including signed Content-Type, If-None-Match, and checksum. `weed mini` is rejected.                                                          |
| Required S3 operations               | Create, put, head, get, delete, duplicate rejection, and a bad checksum passed against the secure topology.                                                                                              |
| Existing API integration             | `S3ObjectStorage` was not modified.                                                                                                                                                                      |
| Persistence and backup               | New volumes. Filer LevelDB and volume files must be stopped and replaced together. The MinIO volume was not reused.                                                                                      |
| Authentication and network isolation | S3 and Filer HTTP require credentials. The host can still open unpublished container ports unless a host firewall drops the internal subnet. That firewall was proven locally and is not staging config. |
| Known security findings              | The pinned digest had no Trivy CRITICAL or HIGH findings. The critical gate was not weakened.                                                                                                            |
| Migration complexity                 | Four storage processes, three volumes, mounted secrets, and a host firewall. Larger than an AIStor image replacement.                                                                                    |
| Licensing and cost                   | SeaweedFS is Apache-2.0. Operating cost is the host we already need, not a license purchase. AGPL candidates need a separate license review.                                                             |

## Decision required

Pick one authorized path:

1. Procure a named AIStor release and accept its license, then replace the image and re-scan it.
2. Approve an ADR that replaces MinIO, then run the compatibility tests above.

The project owner accepted the SeaweedFS revision of ADR-005 on 2026-10-04 in a comment on PR #18. Development and staging Compose now use that topology. The MinIO image is no longer in the release matrix. The pinned SeaweedFS digest is scanned with the same critical gate. One failed scan still blocks every publish. AIStor was not procured. Independent Integration QA of this integrated change is still required, and PR #18 stays unmerged until that review and the release gates pass.
