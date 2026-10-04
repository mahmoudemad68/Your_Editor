# SeaweedFS feasibility proof

This page is the disposable proof that Independent QA reviewed at `b075d38e22ce7888e32255c9f7912887c81627c9`. The owner later accepted the ADR-005 revision. Development and staging now use the same image and component split. The spike Compose file remains the original proof. It is not the staging firewall. No MinIO volume was mounted, migrated, or deleted.

Independent QA rejected `weed mini` at `5c973b5c0d74c2c3b9200639c408f2e47970b53c`. The Filer HTTP listener on port 8888 returned a private object with no credentials. The S3 API rejected the same unsigned request. That mini topology is not a candidate.

## Image

- Image: `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`
- Tag recorded with that digest: `4.48`
- License: Apache-2.0 (`github.com/seaweedfs/seaweedfs`)
- Image size: 529,212,727 bytes
- Earlier Syft SBOM for this digest: SPDX 2.3, 284 packages
- Trivy 0.75.0, `--severity CRITICAL,HIGH`, rerun on this digest: no findings in Alpine 3.24.2 or `usr/bin/weed`. Exit code 0. The critical publish gate was not changed and was not pointed at this image.

## Disposable topology

Compose file: `compose.seaweedfs-spike.yaml`. Project name: `editagent-seaweedfs-secure`.

| Service        | Command                                                  | Listeners             | Network                              | Published         |
| -------------- | -------------------------------------------------------- | --------------------- | ------------------------------------ | ----------------- |
| master         | `master`, telemetry off, 8 MB volume limit in this proof | HTTP 9333, gRPC 19333 | `editagent-seaweed-internal`         | none              |
| volume         | `volume -max=8`                                          | HTTP 8080, gRPC 18080 | internal only                        | none              |
| filer          | `filer -disableDirListing`                               | HTTP 8888, gRPC 18888 | internal only                        | none              |
| s3             | `s3 -iam=false -port.iceberg=0 -port.lance=0`            | HTTP 8333, gRPC 18333 | internal and `editagent-seaweed-app` | `127.0.0.1:18333` |
| object-ingress | existing Node proxy                                      | HTTP 8080             | app network only                     | `127.0.0.1:18081` |

WebDAV, Iceberg, Lance, the admin server, the filer IAM port, and pprof were not started. Volume 4.48 has no `-disableHttp` flag. File reads on the volume server are rejected with JWT instead.

Observed memory after the adversarial upload: master 59 MiB, volume 135 MiB, filer 59 MiB, S3 59 MiB, object ingress 56 MiB.

## Authentication

Secrets are written at test runtime into a `0700` directory and mounted read-only at `/etc/seaweedfs/security.toml` and `/etc/seaweedfs/s3.json`. The files stay mode `0600`. The test reads `id seaweed` from the image and changes ownership to that uid and gid, so the non-root process can read them when the host user is different. An unrelated uid cannot read them. They are not baked into the image and are not committed. The previous `infra/seaweedfs-spike/s3.json` spike credentials were removed.

`security.toml` sets four distinct keys:

- `jwt.signing` and `jwt.signing.read` for master and volume writes and reads
- `jwt.filer_signing` and `jwt.filer_signing.read` for Filer HTTP writes and reads

`access.ui` is false, which disables the volume UI. `filer.expose_directory_metadata` is false. The S3 gateway uses the same file, so it can mint the Filer tokens. Unsigned S3 requests return 403. Unsigned Filer object reads return 401 `wrong jwt`. A known volume needle URL, and `weed download` of that needle without the signing key, return 401 rather than the object.

## Network boundary

Compose `internal` networks do not stop the Docker host. On this host, container-to-container traffic also needs an `iptables-legacy` `DOCKER-FORWARD` accept because the legacy `FORWARD` policy is DROP. `infra/seaweedfs-spike/isolate-internal-network.sh` is part of the proof. It is not installed as a staging firewall.

The script drops new traffic to the internal subnet from every interface except the internal bridge, and drops host `OUTPUT` to that subnet. On the application subnet it allows new TCP connections only to ports 8333 and 8080, plus the established replies those connections need. It installs each required rule on every backend that has the chain (`iptables-nft` and `iptables-legacy`). A backend without that chain is skipped. If no backend accepts the rule, the script exits with an unsupported-firewall error and the test fails. `verify` then checks the effective rules before any upload. A deployment that skips these rules, or an equivalent host firewall on a dedicated VM, is not isolated.

| Caller                        | Target                                     | Result                                      |
| ----------------------------- | ------------------------------------------ | ------------------------------------------- |
| Docker host                   | Filer, volume, master, and S3 internal IPs | no connection                               |
| Docker host                   | published S3 object path                   | 403, private bytes absent                   |
| Docker host                   | object ingress object path                 | 403, private bytes absent                   |
| App network (API position)    | Filer, volume, and master                  | no connection                               |
| App-network sibling           | S3 `:8333` unsigned                        | 403, private bytes absent                   |
| App-network sibling and host  | S3 gRPC `:18333`                           | no connection                               |
| Object ingress container      | Filer object URL                           | no response, private bytes absent           |
| Another Docker network        | Filer and volume                           | no connection                               |
| Internal unauthorized sibling | Filer object path and volume needle URL    | 401, private bytes absent                   |
| Internal unauthorized sibling | volume `/` and Filer `/`                   | 401                                         |
| Internal unauthorized sibling | `weed filer.cat` and `weed download`       | no private bytes                            |
| Internal unauthorized sibling | master `:9333`                             | 200 topology JSON and HTML, no object bytes |
| Internal unauthorized sibling | volume `/status`                           | 200 disk and volume counts, no object bytes |
| Internal unauthorized sibling | volume and Filer `/healthz`                | 200 empty body                              |
| Internal unauthorized sibling | S3 `:8333` unsigned                        | 403                                         |

Status 0 in the automated test means the client received no HTTP response before the one-second limit. The private marker was `private-video-bytes-MUST-NOT-LEAK`. It was absent from every unauthorized response.

## Adapter retest

`tests/architecture/seaweedfs-s3-spike.test.mjs` uses the built `S3ObjectStorage` class. The adapter source was not changed. Checksum validation and `If-None-Match: *` stayed in place.

| Requirement                  | Result | Evidence                                                             |
| ---------------------------- | ------ | -------------------------------------------------------------------- |
| CreateBucket, Put, Get, Head | PASS   | direct client against `127.0.0.1:18333`                              |
| Delete, then restore         | PASS   | object returned after the volume and filer directories were replaced |
| Path-style and SigV4         | PASS   | presigned host was `127.0.0.1:18081`; unsigned S3 returned 403       |
| ChecksumSHA256               | PASS   | `stat().checksumSha256Hex` matched the body                          |
| Presigned PUT via ingress    | PASS   | HTTP 200                                                             |
| Signed Content-Type          | PASS   | changed header returned 403                                          |
| Signed If-None-Match         | PASS   | omitted header returned 403                                          |
| Signed checksum header       | PASS   | omitted header returned 403                                          |
| Wrong body checksum          | PASS   | not HTTP 200                                                         |
| Duplicate upload             | PASS   | second PUT returned 412                                              |
| Restart                      | PASS   | checksum still matched after volume, filer, and S3 restarted         |
| Anonymous byte bypass        | PASS   | no unauthorized listener returned the marker                         |

## Volumes, backup, and health

Three named volumes: `seaweed-master`, `seaweed-volume`, and `seaweed-filer`. Filer metadata is LevelDB under the filer data directory. Object bytes are collection `.dat` and `.idx` files on the volume server. That is not the MinIO layout. A MinIO volume cannot be mounted here.

Backup is a copy taken while the volume server and filer are stopped. Restore replaces each data directory. Copying the backup over a later LevelDB log leaves the deletion in place, so the proof deletes the current directory before copying the backup back. Master Raft state is a third copy and was not required to read the restored object. Postgres metadata is unchanged and must still point at the same keys. The two stores are restored together, as ADR-005 already requires.

Health checks: master `GET /dir/status`; volume and filer any HTTP response on their own port (401 counts as alive); S3 `GET /status`; ingress `GET /health`.

## Unresolved concerns

- Master HTTP on the internal network is not JWT-protected. It returns topology and an HTML status page. It did not return object bytes.
- Volume `/status` is intentionally unauthenticated upstream. It lists collection names, volume ids, and file counts. It did not return object bytes. `/healthz` on the volume and filer is empty and unauthenticated.
- Volume and Filer gRPC ports reset unauthenticated clients in this test. They are not protected by mTLS. Isolation is the network rule above.
- Anyone who can create containers, run `docker exec`, or mount the volumes can read the bytes. That is the same host-admin boundary as MinIO.
- This host's legacy iptables behavior is not a universal Docker guarantee. The firewall script has to be applied, and then removed, with the disposable project.

## Operational complexity against AIStor

AIStor `RELEASE.2026-03-17T21-25-16Z` remains one process, close to the current MinIO service, with a license and a procurement decision. It was not downloaded or scanned. The SeaweedFS secure proof is four storage processes, an ingress, three volumes, two secret files, and a host firewall. Observed memory was about 370 MiB before counting the kernel. Backup has to stop the filer and the volume server and replace both directories. That is more operational surface than a licensed single-binary swap. Neither option is accepted for staging.
