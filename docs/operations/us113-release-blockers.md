# US-113 release blocker register

Technical QA accepted `aba33b01d2e0dfffb3d6a261e67e6252c99d1e7b` as safe to merge. Release readiness stays blocked. This page does not change `secure-up.sh`, does not accept a vulnerability, and does not record a staging deployment.

US-113 AC2 stays open. The security definition of done stays open.

The implementation at that SHA is frozen. A later documentation commit does not replace that technical acceptance.

## Security disposition matrix

Scanner: Trivy 0.75.0. Vulnerability database updated `2026-10-03T14:28:08Z`. A refresh on 2026-10-04 did not move that database. An instance is one CVE on one package. Status `undispositioned` means no human security owner has accepted or rejected the finding. This register does not accept any of them.

### Debian runtime images

These eight CVEs are the whole high set on the rebuilt API, web, agent worker, render worker, object ingress, and AI worker images. Object Ingress is 43 instances. The AI worker is 44 because it also includes `libncursesw6`. Trivy reports no fixed version. There is no package pin to apply from this database.

| CVE            | Packages                                                                                                                           | Instances on one Node image | Fixed version in this database | Status          | Remediation if an owner chooses to fix                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------: | ------------------------------ | --------------- | --------------------------------------------------------------------------- |
| CVE-2025-69720 | `ncurses-base`, `ncurses-bin`, `libtinfo6` (`libncursesw6` on the AI worker)                                                       |      3 (4 on the AI worker) | none                           | undispositioned | Wait for a Debian security update, then pin it. Do not ignore the CVE.      |
| CVE-2026-16742 | `libsystemd0`, `libudev1`                                                                                                          |                           2 | none                           | undispositioned | Same.                                                                       |
| CVE-2026-54369 | `libacl1`                                                                                                                          |                           1 | none                           | undispositioned | Same.                                                                       |
| CVE-2026-76642 | util-linux set: `bsdutils`, `libblkid1`, `liblastlog2-2`, `libmount1`, `libsmartcols1`, `libuuid1`, `login`, `mount`, `util-linux` |                           9 | none                           | undispositioned | Same. Alpine `libuuid` is a different package and is listed under Postgres. |
| CVE-2026-78408 | same util-linux set                                                                                                                |                           9 | none                           | undispositioned | Same.                                                                       |
| CVE-2026-78409 | same util-linux set                                                                                                                |                           9 | none                           | undispositioned | Same.                                                                       |
| CVE-2026-78410 | same util-linux set                                                                                                                |                           9 | none                           | undispositioned | Same.                                                                       |
| CVE-2026-9538  | `perl-base`                                                                                                                        |                           1 | none                           | undispositioned | Same.                                                                       |

Owner for a decision: the human security owner. Evidence required: a named decision for each CVE, either "accepted for staging" with a reason or "remediate". Completion: the decision is written here and, if the choice is remediate, a new image scan shows the CVE gone. Until then the security definition of done stays open.

### Postgres

Image scanned: the staging image built from `infra/postgres/Dockerfile` (`editagent-postgres:review-fix`, local id `a339b099aa92`). Base is `postgres:16.13-alpine`. Critical CVE-2025-68121 in upstream `gosu` is already removed by recompiling `gosu` with Go 1.25.14. That critical finding is not reopened here. High findings below were not in the critical gate and have not been dispositioned. Every one has a fixed Alpine package.

| CVE            | Package                 | Installed | Instances | Fixed version | Status          |
| -------------- | ----------------------- | --------- | --------: | ------------- | --------------- |
| CVE-2026-14456 | `libcrypto3`, `libssl3` | 3.5.6-r0  |         2 | 3.5.8-r0      | undispositioned |
| CVE-2026-45447 | `libcrypto3`, `libssl3` | 3.5.6-r0  |         2 | 3.5.7-r0      | undispositioned |
| CVE-2026-6732  | `libxml2`               | 2.13.9-r0 |         1 | 2.13.9-r1     | undispositioned |
| CVE-2026-53612 | `libuuid`               | 2.41.4-r0 |         1 | 2.41.6-r0     | undispositioned |
| CVE-2026-53613 | `libuuid`               | 2.41.4-r0 |         1 | 2.41.6-r0     | undispositioned |
| CVE-2026-53614 | `libuuid`               | 2.41.4-r0 |         1 | 2.41.6-r0     | undispositioned |
| CVE-2026-76642 | `libuuid`               | 2.41.4-r0 |         1 | 2.41.6-r0     | undispositioned |
| CVE-2026-78408 | `libuuid`               | 2.41.4-r0 |         1 | 2.41.6-r1     | undispositioned |
| CVE-2026-78410 | `libuuid`               | 2.41.4-r0 |         1 | 2.41.6-r0     | undispositioned |

Nine distinct CVEs, 11 instances. Owner: the human security owner, with the image maintainer applying a pin only after that owner asks for remediation. A pin would be a new image and a new technical QA SHA. It is not part of the frozen SHA.

### Redis

Image scanned: `redis:7.4-alpine`, the tag the supply-chain job pulls. Critical scan was clean. High findings were not dispositioned. Both have a fixed Alpine package.

| CVE            | Package                 | Installed | Instances | Fixed version | Status          |
| -------------- | ----------------------- | --------- | --------: | ------------- | --------------- |
| CVE-2026-75804 | `libcrypto3`, `libssl3` | 3.3.7-r1  |         2 | 3.3.7-r2      | undispositioned |
| CVE-2026-84782 | `libcrypto3`, `libssl3` | 3.3.7-r1  |         2 | 3.3.7-r2      | undispositioned |

Two distinct CVEs, 4 instances. The Debian images already pin a different OpenSSL build for these two identifiers. That pin does not cover Alpine 3.21. Owner and completion rule are the same as Postgres.

## Staging-host readiness checklist

This checklist is the gate for a future staging deploy. Nothing here was executed against a remote host. `secure-up.sh` is the only startup path. Do not start Compose first and do not switch that script to a weaker firewall just because a host lacks `DOCKER-USER`.

| Check               | Required state                                                                                                                                                                                                                      | Evidence                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Architecture        | linux/amd64. Published images are built with `--platform linux/amd64`.                                                                                                                                                              | `uname -m` prints `x86_64`.                                                                                |
| Docker              | Docker Engine and Compose v2. The deploy user can run Docker. Non-interactive `sudo -n` or root is available for iptables.                                                                                                          | `docker compose version` and `sudo -n true`.                                                               |
| Firewall backend    | Docker's firewall driver is `iptables`, or the driver field is absent and `/usr/sbin/iptables` resolves to nft or legacy. A reported driver other than iptables fails closed.                                                       | `docker info` and `readlink -f /usr/sbin/iptables`.                                                        |
| Chain compatibility | At least one of `iptables-nft`, `iptables-legacy`, and `iptables` has `DOCKER-USER`, `DOCKER-FORWARD`, and `OUTPUT`. The first IPv4 `FORWARD` rule jumps to `DOCKER-USER`.                                                          | `iptables -S DOCKER-USER`, `iptables -S DOCKER-FORWARD`, and `iptables -S FORWARD`.                        |
| IPv4 isolation      | Internal subnet: `RETURN` on the internal bridge, then `DROP`. Application subnet: established traffic and the published ports are allowed before the subnet `DROP`. No other bridge is accepted before that internal `DROP`.       | `secure-up.sh` log contains `isolation-verified` and `order-ok`.                                           |
| IPv6 isolation      | Compose networks stay IPv6-disabled. If the kernel has IPv6, `ip6tables` exists and both bridges are dropped on `FORWARD` and `OUTPUT` before any accept.                                                                           | `isolation-verified` and `ipv6-policy: drop`, or `kernel has no IPv6` when `/proc/net/if_inet6` is absent. |
| Probe               | An authorized client on the internal network reaches the listener. Host curl exits 28 and the internal subnet DROP counter increases.                                                                                               | Log line `bootstrap-host-blocked` with `curl_exit=28` and a higher drop count.                             |
| Restart             | Every service has restart policy `no`. A Docker restart does not start them. The boot unit runs `secure-up.sh` and stops with `docker compose stop`.                                                                                | `docker inspect` restart policy `no`, and the unit file has `EnvironmentFile=` without a leading dash.     |
| Volumes             | Persistent volumes are `staging-postgres-data`, `staging-redis-data`, `staging-seaweed-master`, `staging-seaweed-volume`, and `staging-seaweed-filer`. Historical MinIO volumes stay on disk and are not mounted as SeaweedFS data. | `docker volume ls`. Deploy does not run `docker compose down -v`.                                          |
| GHCR                | `STAGING_GHCR_USER` and a durable `read:packages` `STAGING_GHCR_TOKEN` exist. The host runs `docker login ghcr.io` before pull. The Actions job token is not enough for a later boot.                                               | `docker login` succeeds and a private `ghcr.io` image can be pulled.                                       |
| SeaweedFS image     | `EDITAGENT_SEAWEEDFS_IMAGE` is exactly `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`.                                                                                               | `secure-up.sh` does not print a digest failure.                                                            |
| Secret files        | SeaweedFS secret directory is mode `0700`. `security.toml` and `s3.json` are mode `0600` and owned by the image user from `id seaweed` (uid 1000, gid 1000).                                                                        | `stat` after `prepare-secrets.sh`. An unrelated uid cannot read the files.                                 |
| Environment file    | `staging.env` is mode `0600` or `0400`. It is shell-quoted. Staging refuses the development S3 secret.                                                                                                                              | `stat` and a failed boot when the file is missing or mode `0644`.                                          |

## GitHub administrator action

Ruleset `main` (id `24207418`) was read on 2026-10-04. Required status checks are only `ci` (GitHub Actions integration id `15368`). Strict status checks are already on. Required approving reviews are already 1. Code-owner review is off. An update that added `supply-chain-security` returned HTTP 403, `Resource not accessible by integration`. The ruleset was not changed.

Requested admin action, and only an admin can do it:

1. Add required status check `supply-chain-security` with integration id `15368` beside `ci`. Do not remove `ci`. Leave strict status checks enabled.
2. Leave required approving reviews at 1. That matches `docs/process/pull-requests.md`.
3. Do not enable "require review from code owners" until real GitHub teams replace the placeholder slugs in `.github/CODEOWNERS`. Those slugs are not accounts. Turning the setting on now would block every merge.
4. The story definition of done still asks for two approvals on security-sensitive modules. That second approval stays a human review practice. It is not recorded as a GitHub setting in this request.

Evidence that the request is done: `GET /repos/mahmoudemad68/Your_Editor/rulesets/24207418` lists both `ci` and `supply-chain-security`, and approving review count is still 1.

## US-118 dependency

US-113 AC2 needs a staging smoke test that passes. `infra/scripts/staging-smoke.sh` exits 2 with `STAGING_SMOKE_BLOCKED` when project creation returns 401. That is the current API. US-118 is the story that adds registration, login, argon2id passwords, and project authorization. Its AC1 is the 404-not-403 isolation check. US-119 depends on US-118 for the web sign-in screens.

Until US-118 is merged and deployed to the same staging SHA, authenticated smoke cannot pass. Exit 2 is not a passed staging deployment. US-113 AC2 stays open for that reason even after a host exists.

Owner: the US-118 backend owner. Completion: a staging run of `staging-smoke.sh` exits 0, with one delivered outbox row and one logical job, using a real signed-in caller. The 401 branch must not be the path that is called a pass.

## Controlled staging verification plan

Do not run this plan until the host checklist is true and an operator explicitly authorizes contact with that host. Do not change `secure-up.sh` to make either case pass.

### Case A — SeaweedFS bucket provisioning

Depends on the host checklist and GHCR login. Does not depend on US-118.

1. Deploy only through `infra/scripts/staging-deploy.sh`.
2. Confirm the log shows isolation before any service starts, then `bootstrap-host-blocked` with curl exit 28 and a higher DROP count.
3. Confirm `ensure_bucket.py` prints `created bucket` or `bucket already exists` for `S3_BUCKET`.
4. From the application network, an unsigned request for an object in that bucket is not HTTP 200 and does not return object bytes.
5. Save the deploy log, the bucket line, and the unsigned-read status. Do not delete volumes.

Failure of the firewall or the probe stops the deploy. Do not bypass it with `docker compose up`.

### Case B — Authenticated upload with the configured application credentials

Depends on case A and on US-118.

1. The access key and secret in `s3.json` match `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` from the mode-`0600` env file. They are not the development secret.
2. A signed-in caller creates a project and receives a presigned PUT for the object ingress, not for a direct SeaweedFS port.
3. The first PUT returns 200. The second PUT of the same object returns 412.
4. An unsigned GET of that object returns 403 and no bytes.
5. `staging-smoke.sh` then exits 0, not 2.

Evidence is the HTTP statuses, the correlation id, and the smoke script exit code. A 401 from project creation keeps this case blocked.

## RELEASE_BLOCKER_REGISTER

| ID   | Blocker                                                                              | Owner                                                      | Evidence required                                                                                | Dependencies                                                                           | Completion criteria                                                                                  | State |
| ---- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----- |
| RB-1 | Eight Debian high CVEs have no fixed version and no human decision                   | Human security owner                                       | A decision that names each CVE                                                                   | None for the decision. A Debian update if the decision is to remediate                 | Each CVE is either explicitly accepted or absent from a new scan. Security DoD stays open until then | Open  |
| RB-2 | Postgres high findings with Alpine fixes, 9 CVEs, 11 instances                       | Human security owner, then image maintainer if told to pin | This matrix plus a later scan if pins land                                                       | Alpine packages named above. A new image is a new QA SHA                               | Each CVE is explicitly accepted or gone. Not accepted in this register                               | Open  |
| RB-3 | Redis high findings with Alpine fixes, 2 CVEs, 4 instances                           | Human security owner, then image maintainer if told to pin | This matrix plus a later scan if the base image changes                                          | `libcrypto3` and `libssl3` `3.3.7-r2` or a newer Redis image that contains them        | Each CVE is explicitly accepted or gone. Not accepted in this register                               | Open  |
| RB-4 | `supply-chain-security` is not a required check                                      | GitHub repository admin                                    | Ruleset `24207418` after the admin edit                                                          | Admin permission. The 403 above is the current limit                                   | `ci` and `supply-chain-security` are both required, strict checks stay on                            | Open  |
| RB-5 | Second approval for security-sensitive modules is not a GitHub setting               | Repository admin and the reviewers named by the story DoD  | The ruleset still requires 1 review, and security-sensitive changes show a second human approval | Real teams before code-owner enforcement. Placeholder CODEOWNERS must not be turned on | The written policy is followed. Code-owner enforcement stays off until teams exist                   | Open  |
| RB-6 | No staging host has been authorized or contacted                                     | Staging operator                                           | Completed host checklist and a `secure-up.sh` log from that host                                 | linux/amd64 host, GHCR token, env file, volumes                                        | Deploy does not print `STAGING_DEPLOYMENT_BLOCKED`, and the probe evidence above is saved            | Open  |
| RB-7 | Authenticated smoke is blocked on US-118                                             | US-118 owner                                               | US-118 AC1 on the staging API, then `staging-smoke.sh` exit 0                                    | US-118 merged and deployed. US-119 for the browser path                                | Smoke is not accepted on the 401 exit-2 path                                                         | Open  |
| RB-8 | Real SeaweedFS bucket provisioning has not been run on a host                        | Staging operator                                           | Case A log                                                                                       | RB-6                                                                                   | Bucket line is `created` or `already exists`, and an unsigned read returns no bytes                  | Open  |
| RB-9 | Authenticated S3 upload with the configured application credentials has not been run | US-118 owner and staging operator                          | Case B statuses                                                                                  | RB-7 and RB-8                                                                          | PUT 200, repeat PUT 412, unsigned GET 403, smoke exit 0                                              | Open  |

US-113 AC2 stays open because RB-6, RB-7, and RB-9 are open. The security definition of done stays open because RB-1, RB-2, and RB-3 are open.
