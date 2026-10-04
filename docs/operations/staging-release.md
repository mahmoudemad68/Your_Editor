# Staging release and rollback

US-113 publishes digest-pinned images and can deploy them to a staging host. The local file `compose.yaml` is the development stack. Staging uses `compose.staging.yaml` and does not inherit development passwords.

Remote staging is not claimed until the GitHub Environment `staging` has the names below and a host exists. A workflow run that lacks them exits with `STAGING_DEPLOYMENT_BLOCKED` and does not contact a host.

## What is already true

- US-112: pull requests run the required `ci` check. That check now also runs secret scanning and critical dependency scanning.
- US-114: `compose.yaml` starts the local stack. Its credential fallbacks stay local. They are not used for staging.
- The API applies SQL migrations, including `0006_inspect_publication_outbox.sql`, when it starts. The deploy script does not drop databases or volumes.

## Images

On every push to `main`, `.github/workflows/supply-chain.yml` builds:

- `ghcr.io/<owner>/editagent-api`
- `ghcr.io/<owner>/editagent-web`
- `ghcr.io/<owner>/editagent-media-worker`
- `ghcr.io/<owner>/editagent-render-worker`
- `ghcr.io/<owner>/editagent-agent-worker`
- `ghcr.io/<owner>/editagent-ai-worker`
- `ghcr.io/<owner>/editagent-object-ingress`

SeaweedFS is not rebuilt. Staging pulls `chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`. The supply-chain workflow generates its SBOM and fails the image job on a critical Trivy finding. That scan is mandatory for the security gate.

`<owner>` is the GitHub owner in lowercase. The tag is the full Git SHA. The workflow records `name@sha256:<digest>` and a Syft SPDX SBOM for each image. Staging must use the digest form. Tags `:latest` and `:local` are rejected.

Application images are built with `--platform linux/amd64`. A staging host must be linux/amd64. The supply-chain tool installer can run on arm64, but it does not publish arm64 application images.

Postgres for staging is built from `infra/postgres/Dockerfile`. That image starts from `postgres:16.13-alpine` and replaces the upstream `gosu` binary, which was compiled with Go 1.24.6 (`CVE-2025-68121`), with the same gosu source compiled by Go 1.25.14. Redis `7.4-alpine` is not rebuilt. The workflow records its digest, writes a Syft SBOM, and fails the platform job on a critical Trivy finding. Both results are mandatory for the security gate.

Pull requests build and scan the same images and upload SBOMs. They do not push to GHCR and they do not deploy.

Trivy fails that image job when it reports a critical finding. The failed image is not pushed. The SBOM from the earlier step remains as an artifact. A red image scan is not a release. The current finding record is in `docs/operations/us113-vulnerability-review.md`. The MinIO image is no longer in this release matrix.

## GitHub Environment `staging`

Create an environment named `staging` on this repository. Put secrets and variables there. Do not commit their values.

Secrets:

- `STAGING_HOST`
- `STAGING_SSH_USER`
- `STAGING_SSH_KEY`
- `STAGING_SSH_KNOWN_HOSTS`
- `POSTGRES_PASSWORD`
- `S3_SECRET_ACCESS_KEY`
- `STAGING_GHCR_TOKEN` a read:packages token that stays valid between deploys. The Actions `GITHUB_TOKEN` expires when the job ends, so it cannot authorize a later pull.

Variables:

- `POSTGRES_USER`
- `POSTGRES_DB`
- `S3_ACCESS_KEY_ID`
- `S3_BUCKET`
- `S3_REGION`
- `S3_PUBLIC_ENDPOINT`
- `STAGING_BIND_IP`
- `STAGING_WEB_PORT`
- `STAGING_OBJECTS_PORT`
- `STAGING_WEB_URL`
- `STAGING_API_URL`
- `STAGING_SILENT_API_URL` an API whose dependency does not answer, used by the readiness measurement
- `STAGING_GHCR_USER`
- `STAGING_DEPLOY_PATH`
- `MEDIA_INSPECT_QUEUE`

`STAGING_BIND_IP` should be `127.0.0.1` unless a local reverse proxy is intentionally elsewhere. `S3_PUBLIC_ENDPOINT` is the browser-facing object ingress. Presigned URLs are signed for that host, and the proxy in front of it must forward the Host header unchanged. `STAGING_OBJECTS_PORT` is the ingress port. `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are written into the SeaweedFS `s3.json` on the host by `infra/seaweedfs/prepare-secrets.sh`. `MEDIA_INSPECT_QUEUE` must not contain a colon. Passwords must be URL-safe because they are placed in `DATABASE_URL`.

Image digests are workflow outputs, not environment secrets.

## Host checklist

Provision this before expecting a deploy to succeed. This repository does not create the host.

1. A linux/amd64 host with Docker Engine and Docker Compose v2. CPU is enough. NVIDIA is optional and only used with `--profile gpu`. The host logs in to `ghcr.io` with `STAGING_GHCR_USER` and `STAGING_GHCR_TOKEN` before images are pulled.
2. A persistent disk for the Compose volumes `staging-postgres-data`, `staging-redis-data`, `staging-seaweed-master`, `staging-seaweed-volume`, and `staging-seaweed-filer`. Leave any existing MinIO volume on that disk. Do not mount it as SeaweedFS data and do not delete it during this cutover.
3. A non-root deploy user that can run Docker.
4. OpenSSH with a dedicated key. Record that key as `STAGING_SSH_KEY` and the host key as `STAGING_SSH_KNOWN_HOSTS`.
5. Host firewall tooling: `iptables` or `iptables-nft`, and `ip6tables` when the kernel has IPv6. `staging-deploy.sh` runs `infra/seaweedfs/apply-compose-isolation.sh` after Compose creates the networks and fails if the rules are not effective. IPv6 must stay disabled on the internal storage network. Compose publishes the web port and the object ingress, both bound to `STAGING_BIND_IP`. Master, volume, filer, and the S3 gateway have no host ports. The ingress forwards signed object requests and refuses `/minio/` and `Action=` STS calls. Run the isolation script again after a host reboot.
6. A reverse proxy or SSH tunnel from the operators to that web port. Point `STAGING_WEB_URL` and `STAGING_API_URL` at the URLs the smoke test can call. The API is on the Compose network at `http://api:3001` and is not published.
7. Clone this repository at `STAGING_DEPLOY_PATH`. The workflow replaces `infra/` with the contents of this run's `infra` directory, copies `compose.staging.yaml`, and writes a mode-`600` `staging.env`. It does not nest a second `infra` directory and it does not delete the deploy path. Values are shell-quoted so `$`, quotes, backticks, and `#` stay data when the file is sourced. `staging-deploy.sh` then creates `S3_BUCKET` on the SeaweedFS S3 gateway with `S3_ACCESS_KEY_ID`.
8. Confirm `node`, `python3`, `curl`, and `sha256sum` exist on the host. The smoke script uses them.

## Deploy

Merging to `main` runs the supply-chain workflow. Each image is built, given an SBOM, and scanned with `trivy image --severity CRITICAL --exit-code 1`. The job `supply-chain-security` passes only when every mandatory scan result is `pass`. The publish job runs only after that gate and only on a push to `main`. A failed scan, including the pinned SeaweedFS image, skips publish, so no `docker push` runs. Deploy runs only after publish succeeds. If any staging name above is empty, the deploy job prints `STAGING_DEPLOYMENT_BLOCKED` and exits. It does not invent a host.

The `main` ruleset required status check is only `ci`. `supply-chain-security` is not a required check. An attempt to add it beside `ci` returned HTTP 403, `Resource not accessible by integration`, and the ruleset was left unchanged. A repository admin has to add that check before a green security gate can block a merge.

When the names are present, the job copies the compose file and a mode-`600` env file, then runs `infra/scripts/staging-deploy.sh`. That script calls `infra/seaweedfs/secure-up.sh`. The secure path checks privileges, requires `EDITAGENT_SEAWEEDFS_IMAGE` to be the approved SeaweedFS digest, refuses the development S3 secret, prepares secrets, creates networks without starting them, installs subnet firewall rules, proves an internal listener is open to its own network and blocked on the host, and only then starts services. The host probe succeeds only when curl exits 28 and the internal subnet DROP counter increases. Any other curl exit fails closed. A failed check stops containers and does not delete volumes. `docker compose up` by itself is not this path. The boot unit `editagent-secure-up.service` loads that same env file with a required systemd `EnvironmentFile` and runs `secure-up.sh`. Its `ExecStop` is `docker compose stop`. There is no unit restart policy that starts containers on its own. Container restart policy stays `no`, so a reboot or Docker restart does not start services until that unit runs. A missing or world-readable env file fails the boot and leaves services stopped.

Manual redeploy of an already built SHA, on the host:

```bash
set -a
. ./staging.env
set +a
./infra/scripts/staging-preflight.sh --compose
./infra/scripts/staging-deploy.sh
```

## Migrations and backups

The API applies `apps/api/migrations` in order, including `0006_inspect_publication_outbox.sql`, on startup. Applying them again is a no-op. The deploy does not drop schemas.

Before a deploy that includes a new migration:

```bash
docker compose -f compose.staging.yaml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  > "editagent-staging-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Keep that dump off the database volume. Do not restore it with `docker compose down -v` as part of a routine deploy.

## Rollback

1. Choose the previous Git SHA whose supply-chain artifacts contain `digest-*.txt` and `platform-digests.txt`.
2. Put those digest lines into `staging.env`. Do not switch the files back to `:latest` or `:local`.
3. Run `staging-preflight.sh --compose` and `staging-deploy.sh` again.
4. If the bad deploy applied a migration that the previous images cannot read, restore the `pg_dump` taken before that deploy. Do not invent a down migration. The SQL in this repository is forward-only.

Rolling the images back without a database restore is safe only when the newer migration is still compatible with the older image.

## Smoke test

On the staging host, after deploy:

```bash
set -a
. ./staging.env
set +a
export COMPOSE_FILE=compose.staging.yaml
export STAGING_WEB_URL
export STAGING_API_URL
./infra/scripts/staging-smoke.sh
```

The script checks web availability, API `/health`, and API `/ready`. It then creates a project, uploads an object, completes the upload, and waits for one outbox row, one BullMQ payload, one completed job, one completed attempt, and the same correlation id in the API and media-worker logs. It stops Redis, completes the upload again, restores Redis, restarts the API, and checks that the same logical job is still the only job.

Exit `2` with `STAGING_SMOKE_BLOCKED` means the URL or sign-in gate is missing. Project creation currently requires a signed-in actor. US-118 is not implemented, so this upload portion stays blocked on a stock API. Exit `2` is not a passing staging deployment.

## Readiness connection measurement

```bash
export COMPOSE_FILE=compose.staging.yaml
export STAGING_API_URL
export POSTGRES_USER POSTGRES_DB
./infra/scripts/staging-readiness-measure.sh
```

The script records PostgreSQL `pg_stat_activity` and Redis `connected_clients` before 20 `/ready` polls, during them, and five seconds after. Growth beyond a small overlap allowance fails the script. `STAGING_SILENT_API_URL`, when set to an API whose dependency does not answer, must return `/ready` 503. The service command deadline is one second. The script allows two seconds so the HTTP client is included, and fails if the call hangs or returns another status. Without that URL the script exits `2` and does not pretend the silent-dependency check passed.

## Local validation

These commands do not deploy staging:

```bash
docker compose config --quiet
./infra/scripts/install-supply-chain-tools.sh gitleaks
gitleaks detect --source . --redact --config .gitleaks.toml --exit-code 1
pnpm audit --audit-level critical
./infra/scripts/audit-python.sh
pnpm check
```

`pnpm check` includes the staging Compose and secret-fixture tests.
