# Release and rollback

US-113/115 closes gaps on accepted main `d8dedfa2416a7c1bb199fe2047899aed58e7f97b`. PR #18 is superseded; its MinIO/object-ingress/staging assumptions are not used. See [source gap analysis](gap-analysis.md).

## PR, main and images

PRs run tests, Gitleaks, production/dev Node audit, Python audit, Syft and Trivy. Missing/failed scans and unresolved Critical findings fail closed. Existing HIGH debt is reported without new suppression or acceptance. The synthetic temporary-Git canary proves Gitleaks returns nonzero; it is never added to project history.

Only `push` to accepted `main` may publish. Main scan/publication concurrency is keyed by commit so another merge does not cancel or replace its image build. Staging updates are serialized separately; GitHub may replace a superseded pending deployment, so the Owner can rerun the accepted main run for a retained SHA when needed. `workflow_dispatch`, ordinary/fork PRs and other branches cannot publish or deploy. The publishing job has `contents: read`, `packages: write`; scans have no registry-write permission. `GITHUB_TOKEN` authenticates GHCR. The exact scanned tar-loaded images are pushed without rebuilding:

```
ghcr.io/<lowercase-owner>/<lowercase-repository>-<service>:sha-<40-character-commit>
ghcr.io/<lowercase-owner>/<lowercase-repository>-<service>:main
```

Services: api, web, media-worker, render-worker, agent-worker, ai-worker, seaweedfs, postgres, redis. `test-minio` is scanned but never published as a product. A SHA tag that already refers to a different image config is rejected. The mutable `main` alias is for discovery; deployment uses `image@sha256:digest` only.

The 90-day `release-<SHA>` artifact contains `release.json`, per-image records, SPDX JSON SBOMs and a release bundle. Each record binds Git SHA, tag, registry digest, scanned image ID, SBOM filename and SHA-256. Assembly requires exactly nine services with matching commit and valid SBOM hashes. Download and retain known-good release bundles outside Actions retention for long-term rollback. GHCR tags/images and the release store must not be pruned while referenced by current/previous releases.

## Owner authorization and staging prerequisites

**No live deployment is authorized by this implementation task.** Live staging AC2 evidence remains pending explicit Owner authorization. The default deployment guard is disabled: `STAGING_CD_ENABLED` must be set to `true` by the Owner, and the `staging` GitHub Environment must have required human reviewers and prevent self-review. The job verifies those protection rules before SSH. Missing protection fails closed. The Coding Agent attempted to configure this Environment but GitHub returned HTTP 403 (environment administration is not granted to the integration); the Owner must complete this setup. Configure environment branch restrictions to `main` and choose a reviewer who can approve a deployment initiated by another actor. Do not enable CD until these controls and the host are ready.

Environment secrets: `STAGING_HOST`, `STAGING_USER`, `STAGING_PATH`, `STAGING_SSH_KEY`, `STAGING_KNOWN_HOSTS`. Use a verified host-key entry; StrictHostKeyChecking is never disabled. The workflow passes its read-only packages `GITHUB_TOKEN` to the remote Docker login via stdin, using an ephemeral Docker config, deleted on exit. No permanent registry PAT is required for automatic deployment. Manual rollback needs Owner-provisioned read-only package access if images are absent locally.

Provision a dedicated Linux amd64 Docker/Compose host (Compose supports `!reset`/`!override`), Python 3.11, OpenSSL, iptables/nft/nsenter and the existing SeaweedFS firewall prerequisites. The deployment account needs Docker and narrowly scoped passwordless sudo for the accepted isolation/secret-install scripts. It must not share this fixed storage subnet/container layout with development stacks.

Create `<STAGING_PATH>/shared/runtime.env`, mode 0600. Syntax is literal `UPPERCASE_KEY=value` or JSON-quoted strings; no shell expansion, interpolation or multiline values. Required: `POSTGRES_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `AUTH_JWT_SECRET` (32+ characters), `AUTH_TRUSTED_ORIGINS` (HTTPS), `S3_PUBLIC_ENDPOINT` (HTTPS), `SEAWEED_SECRET_DIR` (persistent absolute path). Set appropriate `POSTGRES_USER`, `POSTGRES_DB`, `S3_BUCKET`, `S3_REGION`, trusted proxy configuration and host S3 port too. Development secrets are rejected. These values are never bundled/uploaded.

TLS ingress/reverse proxy for web and S3 is provisioned by the Owner; published host ports stay loopback-only. The existing Master/Volume/Filer TLS/JWT configuration, pinned subnet, startup nonce acknowledgement and host/container firewalls remain authoritative. Deployment does not substitute MinIO, remove volumes or open internal storage ports.

Before enabling CD, replace any development-only Docker boot hook that rebuilds source with an Owner-installed service/drop-in that runs `infra/scripts/staging-boot.sh <STAGING_PATH>` after Docker starts. That hook resumes the recorded current immutable release through the same firewall-first path, using already-pulled images rather than requiring a persistent registry credential. Keep these deployed images in the host cache; boot fails closed if an image is missing. Preserve dependency ordering and run it as the authorized operator/root; validate reboot separately on the actual host. This implementation does not claim a staging reboot was executed.

## Deployment, smoke and failure

The workflow uploads the accepted bundle under `releases/<SHA>`, takes a host lock, validates image/SBOM identity and runtime settings, pulls immutable images, then uses existing SeaweedFS secret/network/firewall scripts before any storage listener starts. It performs `docker compose up --no-build --wait`, provisions the bucket through existing authenticated SigV4 bootstrap, then starts application services. Nothing is rebuilt on the host. GitHub staging concurrency and the host lock prevent simultaneous updates.

Smoke checks all 12 required Compose containers are running/healthy, every container's immutable image/config ID and revision match the release, and HTTP `/health` + `/ready` for all six application services. Dependency 503, missing/unhealthy container and wrong image/SHA fail. Each command/probe has a timeout; retry windows are bounded. Successful smoke atomically updates `current`, `previous` and `deployed.json`. A failed smoke leaves the current known-good release record intact; containers may have partially updated. Inspect safe `failed-compose-status.json` and deliberately roll back. Credentials, arbitrary container environment and raw exception text are not printed. Database schema rollback is not automated; check backward compatibility/backups before switching releases.

## Rollback

After explicit Owner authorization, use the prior retained bundle and recorded digests, not an old source rebuild:

```sh
python3 /srv/editagent/current/infra/scripts/staging_release.py rollback \
  --root /srv/editagent --dry-run
# Review exact previous release.json, SBOM hashes and digest set first.
python3 /srv/editagent/current/infra/scripts/staging_release.py rollback \
  --root /srv/editagent
```

Alternatively select `--release-dir /srv/editagent/releases/<known-good-SHA>`. The same validation, lock, digest-based pull, firewall sequencing and smoke apply. Registry credentials, if required, use `--registry-user USER` and stdin; never command arguments. The previous pointer changes only after successful smoke and preserves the old deployment on same-release retries. `deployed.json` identifies the exact deployed commit and image set.

Safe implementation proofs:

```sh
python3 tests/integration/support/release-regressions.py
node --test tests/integration/release-observability.test.mjs
PATH=/path/to/pinned/scanners:$PATH python3 infra/scripts/secret-canary.py
pnpm test:walking-skeleton --verify-failure
```

Dry runs use temporary release stores and fake command transports; no SSH/staging/GHCR push occurs. Walking-skeleton smoke is explicitly a disposable local-test subset and makes no published-image/deployment claim. Real production publication begins only after accepted main; live staging/rollback/reboot remain Owner-authorized operations.

## Observability contract

`x-request-id` is an opaque correlation identifier, not a credential. IDs match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; invalid/missing values are replaced. Browser SessionClient and upload adapter generate IDs; BFF preserves valid ones, API echoes/binds them, PostgreSQL Job payload/BullMQ envelope retains them and lifecycle logs use them. The real walking skeleton checks the browser-generated upload completion ID against API logs, durable Job and all worker lines for that Job.

TS Pino/AI structlog output JSON with service, level/message and request/job correlation. Application logging accepts operational metadata, not arbitrary error/request/credential objects. Request paths exclude queries. JobEvent v1 and queue semantics are unchanged. Unrelated startup logs do not fabricate Job IDs. Expected HTTP errors keep existing status/contract; unexpected server errors return safe `application/problem+json`, including `traceId` equal to the request correlation ID, not a fabricated exported span ID. OpenTelemetry initializes idempotently without network export.

| Service       | Liveness     | Readiness   | Dependency probe            | Compose check |
| ------------- | ------------ | ----------- | --------------------------- | ------------- |
| API           | :3001/health | :3001/ready | PostgreSQL + Redis          | /ready        |
| web           | :3000/health | :3000/ready | API /ready, bounded 2s      | /ready        |
| media-worker  | :3200/health | :3200/ready | PostgreSQL + Redis          | /ready        |
| render-worker | :3200/health | :3200/ready | Scaffold: true after config | /ready        |
| agent-worker  | :3200/health | :3200/ready | Scaffold: true after config | /ready        |
| ai-worker     | :3200/health | :3200/ready | PostgreSQL + Redis          | /ready        |

Liveness stays 200 during dependency failure. Readiness 503 reports inability to accept useful work. SeaweedFS/Postgres/Redis retain their accepted native probes; they do not expose application RFC7807 routes. GPU AI uses the same health/readiness behavior and is not required for staging CPU deployment.
