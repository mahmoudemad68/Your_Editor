# SeaweedFS object storage

The active Compose stack uses SeaweedFS instead of MinIO. `S3ObjectStorage` is unchanged. API calls use `S3_ENDPOINT=http://seaweed-s3:8333`. Presigned browser URLs use `S3_PUBLIC_ENDPOINT`, published only on `127.0.0.1`.

## Topology

One digest-pinned image runs four roles on `storage_internal` (`172.30.210.0/24`, IPv6 disabled):

| Role       | DNS name         | Address         | Ports                                      |
| ---------- | ---------------- | --------------- | ------------------------------------------ |
| Master     | `seaweed-master` | `172.30.210.10` | 9333 HTTPS, gRPC 19333                     |
| Volume     | `seaweed-volume` | `172.30.210.11` | 8080 HTTP, gRPC 18080                      |
| Filer      | `seaweed-filer`  | `172.30.210.12` | 8888 HTTP, gRPC 18888                      |
| S3 gateway | `seaweed-s3`     | `172.30.210.13` | 8333 HTTP, also on the application network |

`storage_internal` is an internal Compose network. Master, volume, and filer publish no host ports. The gateway is bound to `127.0.0.1:${S3_PORT:-9000}`. Addresses are fixed in `infra/seaweedfs/storage-network.env` and `compose.yaml`. An empty network left from an older subnet is removed by `infra/seaweedfs/ensure-storage-network.sh`. A network that still has containers is not removed.

The image is `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` (SeaweedFS 4.48, Alpine 3.24.2). A Trivy HIGH,CRITICAL scan of that digest reported zero findings. The upstream entrypoint drops to uid 1000 after fixing `/data` ownership.

## Required internal paths

These are the flows SeaweedFS 4.48 uses for the S3 gateway. Application containers are not part of them.

```text
apps and browsers
        |  SigV4 HTTP :8333
        v
   seaweed-s3 ---------------- gRPC mTLS :19333 -----> seaweed-master
        |  \                                              ^
        |   \ HTTP :8888 + filer JWT                      | gRPC mTLS
        |    \                                            |
        |     +---------- gRPC mTLS :18888 --------> seaweed-filer
        |                                              /
        +---------- HTTP :8080 + volume JWT ---------+
                         |
                         v
                   seaweed-volume -- gRPC mTLS :19333 --> seaweed-master
                         ^
                         |
            master admin gRPC mTLS :18080 (AllocateVolume)
```

- Volume heartbeats and filer assignment use master gRPC 19333. The master gRPC `Assign` method mints the volume write JWT, so that listener requires a client certificate.
- Master allocates volumes through volume gRPC 18080. The volume server allows that call only from a whitelisted source address. The master address is on that list.
- Filer and the S3 gateway upload and delete needles through volume HTTP 8080. The volume whitelist is master, volume, filer, and the S3 gateway. A write also needs the volume JWT.
- The S3 gateway reads and writes metadata through filer gRPC 18888 and filer HTTP 8888. Its gRPC client identity is `[grpc.client]` in `security.toml`. Filer HTTP requires the filer JWT.

## Trust boundary

An unauthorized container attached to `storage_internal` was able to call master `GET /dir/assign`, receive a write JWT, and upload to the volume server. Master `/`, `/dir/status`, and `/cluster/status` answered without credentials. `internal: true` does not stop a container that joins the network, and gRPC mTLS does not protect an HTTP listener.

SeaweedFS 4.48 is pinned, and these controls are what that build actually enforces:

| Control                                                 | What it closes                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Master `-disableHttp`                                   | `/dir/assign`, `/dir/lookup`, `/dir/status`, `/vol/grow`, and the other master HTTP routes are not registered. `/healthz` and `/readyz` remain.                                                                                                                            |
| `[https.master]` with a client CA                       | The master UI, `/cluster/status`, and `/healthz` require a storage client certificate. Plain HTTP to 9333 is not an application response.                                                                                                                                  |
| Separate certificates for master, volume, filer, and S3 | Each gRPC server allows only the common names that must dial it. The S3 certificate is `[grpc.client]`. Volume gRPC does not allow the S3 name. Volume `GET /status` is not covered by this, because 4.48 registers that route with no JWT and no whitelist.               |
| Volume `-whiteList` of the four storage addresses       | Volume needle HTTP and volume admin gRPC reject every other source. `/status` and `/healthz` are not wrapped by that whitelist.                                                                                                                                            |
| Per-role firewall in `apply-host-isolation.sh`          | Only the four storage addresses may open master, volume, and filer ports. An extra container on `storage_internal` is dropped, including `GET /status`. Host and other networks are dropped. TCP 8333 on the S3 address stays open. IPv6 on the storage bridge is dropped. |
| Filer JWT keys and `access.ui = false`                  | Anonymous filer HTTP is rejected. Filer `/healthz` stays empty and unauthenticated. `access.ui` does not remove the master UI route in 4.48; master mTLS does.                                                                                                             |

The master health check is `https://127.0.0.1:9333/healthz` with the master certificate. Volume and filer health checks run on `127.0.0.1` inside the container, so they do not cross the bridge. `/dir/status` is not a health check, because `-disableHttp` does not register it.

`infra/seaweedfs/start-storage.sh` stops the storage roles, creates the network, installs the firewall, checks the rules, and only then starts the containers. The four roles use `restart: "no"`, so Docker does not start them on its own during daemon startup. When systemd is running, `--install` enables `editagent-storage-isolation.service` and a `docker.service` `ExecStartPost`. Both call `start-storage.sh --from-boot`, which installs the rules before `docker compose up`. Without systemd, `--install` exits 3 and prints `REBOOT_PERSISTENCE=open`. It does not claim that a reboot will restore the rules. A missing iptables or ip6tables backend exits 1 and the containers stay stopped.

The rules are replaced in place on every run. They are installed on every iptables backend that currently has a `DOCKER-USER` chain, including a leftover `iptables-legacy` table. Established flows are returned first. A same-subnet `ACCEPT` remains on `DOCKER-FORWARD` only for packets that the drop chain did not discard, so a legacy table that Docker did not update can still forward the allowed pairs.

## Secrets

`make up` runs `infra/seaweedfs/start-storage.sh`, which runs `prepare-secrets.sh`. The directory is mode `0700`. `security.toml`, `s3.json`, `ca.key`, and each role key are mode `0600` and owned by the `seaweed` user. An existing `security.toml` keeps its JWT keys; the gRPC and master HTTPS sections are rewritten to the role paths. Each role certificate is mounted only into that role. Application containers do not receive them. The previous shared `seaweed.key` is removed so it cannot impersonate every role. `ca.key` is not mounted into any service. `s3.json` is rewritten from `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. `SEAWEED_REQUIRE_S3_ENV=1` refuses the development secret.

## S3 contract

Verified against this image:

- SigV4 `PutObject`, `GetObject`, and `HeadObject`.
- `Content-Type` and `ChecksumSHA256` round-trip.
- Presigned PUT with `If-None-Match: *` returns 412 when the key exists and 200 when it does not.
- An anonymous GET of a private key returns 403 and does not return the body.

`infra/seaweedfs/verify-trust-boundary.sh` is the negative test. An unauthorized container on `storage_internal` must not receive a write token, read volume `/status`, write or delete on the volume, or read or delete a private object through the filer or unauthenticated S3. The Docker host and a container on another network must not open master, volume, or filer. The filer must still be able to read volume `/status`, and the S3 certificate must not complete a volume gRPC handshake. The script does not print JWTs, signing keys, S3 credentials, or volume topology. CI runs it after the gateway is healthy and runs the S3 contract only after `pnpm install`.

## Persistence, backup, restore

Master, volume, and filer each have their own volume. `infra/seaweedfs/backup-volumes.sh` stops those roles, writes one tar per volume, and starts them again. `infra/seaweedfs/restore-volumes.sh` stops them, clears each data directory, extracts the matching archive, and starts them. A restore replaces the directory. It does not merge a later log onto an older one.

## MinIO history

`minio-data` remains declared and unmounted. `infra/scripts/migrate-minio-objects.py` copies keys, content types, and bodies from a source S3 endpoint to the SeaweedFS gateway and checks SHA-256. It has no delete-source or delete-volume mode. Do not run `docker compose down -v` as part of the copy.

## Limitations of SeaweedFS 4.48

- `/cluster/status` stays registered when `-disableHttp` is set. Master HTTPS checks the CA, not the role common name, so any role certificate can open it. A process that can read one of those keys can.
- Volume `GET /status` has no authentication in SeaweedFS 4.48. The firewall is what stops every address except master, filer, and S3. A compromised filer or S3 container can still read that topology. Needle writes still need the volume JWT, which those processes already hold in `security.toml`.
- Volume gRPC allows the master and filer certificates. `WriteNeedleBlob` has no further application check. The S3 certificate is not on that allow list. An unauthorized container does not have either allowed key, and the firewall drops its packets to port 18080.
- A stolen master or filer key can still call volume gRPC from a host that can route to port 18080. The firewall drops every source except the four storage addresses.
- The S3 port on `172.30.210.13` stays reachable so the published `127.0.0.1` mapping works. Callers still need SigV4.
- `ca.key` on the host can mint another role certificate. The secret directory is mode `0700` and `ca.key` is not mounted.
- IPv6 is disabled inside the storage containers and dropped on the storage bridge. This does not by itself prove a host reboot. On a machine without systemd, `REBOOT_PERSISTENCE` stays open: the rules exist for the current boot, and `restart: "no"` keeps Docker from starting the roles until `start-storage.sh` runs again.
