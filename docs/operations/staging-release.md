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
- `ghcr.io/<owner>/editagent-minio`

`<owner>` is the GitHub owner in lowercase. The tag is the full Git SHA. The workflow records `name@sha256:<digest>` and a Syft SPDX SBOM for each image. Staging must use the digest form. Tags `:latest` and `:local` are rejected.

Postgres `16.10-alpine` and Redis `7.4-alpine` are not rebuilt. The same workflow records the registry digest it pulled so staging does not keep floating tags.

Pull requests build and scan the same images and upload SBOMs. They do not push to GHCR and they do not deploy.

Trivy fails that image job when it reports a critical finding. The failed image is not pushed. The SBOM from the earlier step remains as an artifact. A red image scan is not a release. The current finding record and the unapplied MinIO risk-acceptance proposal are in `docs/operations/us113-vulnerability-review.md`.

## GitHub Environment `staging`

Create an environment named `staging` on this repository. Put secrets and variables there. Do not commit their values.

Secrets:

- `STAGING_HOST`
- `STAGING_SSH_USER`
- `STAGING_SSH_KEY`
- `STAGING_SSH_KNOWN_HOSTS`
- `POSTGRES_PASSWORD`
- `MINIO_ROOT_PASSWORD`
- `S3_SECRET_ACCESS_KEY`

Variables:

- `POSTGRES_USER`
- `POSTGRES_DB`
- `MINIO_ROOT_USER`
- `S3_ACCESS_KEY_ID`
- `S3_BUCKET`
- `S3_REGION`
- `S3_PUBLIC_ENDPOINT`
- `STAGING_BIND_IP`
- `STAGING_WEB_PORT`
- `STAGING_WEB_URL`
- `STAGING_API_URL`
- `STAGING_DEPLOY_PATH`
- `MEDIA_INSPECT_QUEUE`

`STAGING_BIND_IP` should be `127.0.0.1` unless a local reverse proxy is intentionally elsewhere. `S3_PUBLIC_ENDPOINT` is the browser-facing object-storage URL. `MEDIA_INSPECT_QUEUE` must not contain a colon. Passwords must be URL-safe because they are placed in `DATABASE_URL`.

Image digests are workflow outputs, not environment secrets.

## Host checklist

Provision this before expecting a deploy to succeed. This repository does not create the host.

1. A Linux host with Docker Engine and Docker Compose v2. CPU is enough. NVIDIA is optional and only used with `--profile gpu`.
2. A persistent disk for the Compose volumes `staging-postgres-data`, `staging-redis-data`, and `staging-minio-data`.
3. A non-root deploy user that can run Docker.
4. OpenSSH with a dedicated key. Record that key as `STAGING_SSH_KEY` and the host key as `STAGING_SSH_KNOWN_HOSTS`.
5. Firewall: do not publish PostgreSQL, Redis, or MinIO. The Compose file publishes only the web port, bound to `STAGING_BIND_IP`.
6. A reverse proxy or SSH tunnel from the operators to that web port. Point `STAGING_WEB_URL` and `STAGING_API_URL` at the URLs the smoke test can call. The API is on the Compose network at `http://api:3001` and is not published.
7. Clone this repository at `STAGING_DEPLOY_PATH`. The workflow copies `compose.staging.yaml`, `infra/`, and `staging.env` onto that path. It does not delete the directory.
8. Confirm `node`, `python3`, `curl`, and `sha256sum` exist on the host. The smoke script uses them.

## Deploy

Merging to `main` runs the supply-chain workflow. The deploy job uses the `staging` environment. If any name above is empty, the job prints `STAGING_DEPLOYMENT_BLOCKED` and exits. It does not invent a host.

When the names are present, the job copies the compose file and a mode-`600` env file, then runs `infra/scripts/staging-deploy.sh`. That script checks every image reference is `@sha256` pinned, pulls, and runs `docker compose up -d --no-build`. It does not run `docker compose down -v`.

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
