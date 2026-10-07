# Testing EditAgent

Run commands from the repository root with the pinned Node/pnpm/Python toolchain.
`pnpm install --frozen-lockfile` installs dependencies. `pnpm check` retains all
accepted Node, Python, integration and harness-browser regressions.

## Unit tests

New/refactored TypeScript domain tests use Vitest with explicit imports and
`*.test.ts` alongside the behavior. Shared config: `tools/test/vitest.config.mts`.
Use deterministic IDs/clocks, small fixtures, and observable behavior assertions.
The domain suite is migrated without removing its assertions. Other working
`node:test` suites remain: migrate them gradually when changing their tests,
rather than rewriting hundreds of tests. Production domain imports remain free
of frameworks/infrastructure.

```sh
pnpm test:unit
pnpm --filter @editagent/domain exec vitest run --config ../../tools/test/vitest.config.mts src/modules/jobs/job.test.ts
pnpm test:coverage
```

The **sole authoritative percentage gate** is Vitest/V8 domain coverage: all
`src/**/*.ts` production files, including unimported code, excluding only tests
and declarations; **lines >=80%**. LCOV and JSON summary go to
`packages/domain/coverage/`. CI's `pnpm test` executes this gate; report-existence
checks for the other packages remain supplemental. The isolated
`domain-coverage-gate.test.mjs` runs this same config against temporary low-covered
code and requires exit 1, then deletes it. Never add exclusions to inflate coverage.

Python keeps `workers/ai-worker/tests/test_*.py`, worker-local fixtures/conftest,
pytest + pytest-cov and coverage.xml. Use explicit fixture teardown and seeded
inputs; integration tests can use the registered `integration` marker. Avoid
network or wall-clock dependence in unit tests. No Python percentage gate is
required by this story.

```sh
pnpm --filter @editagent/ai-worker test
(cd workers/ai-worker && uv run pytest tests/test_config.py)
```

## Integration tests

`tests/integration/support/containers.mjs` provides reusable PostgreSQL, Redis
and **actual MinIO** helpers. Services use digest/commit-pinned images, random
host ports, test-scoped credentials, and real readiness. The combined sample
creates/reads PostgreSQL data, SET/GETs Redis and PUT/HEAD/GETs a MinIO object.
Concurrent startup, cleanup of partial failures and `finally` teardown isolate
runs. Docker absence fails explicitly both locally and in CI; there is no silent
skip. To work without Docker, choose unit commands instead of claiming integration
coverage. Bound timeouts; end clients, streams and containers on every outcome.

```sh
pnpm test:integration
pnpm test:services pnpm --filter @editagent/media-worker test
node --test tests/integration/domain-coverage-gate.test.mjs
```

The convenience `test:services` wrapper is for tests compatible with MinIO.
SeaweedFS-specific S3 contract tests deliberately require product storage; run
the full `pnpm check` against the Compose services as CI does. Do not substitute
MinIO and weaken those storage assertions.

MinIO community is archived and the upstream image/download distribution is
unavailable. The helper builds the final release from checksum-verified source
(commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`) with the pinned Go base,
then runs a non-root scratch container. The first build is slower; subsequent
runs reuse that local image. It is test-only, never product object storage.
Managed-cloud builds accept an optional BuildKit CA secret; TLS stays enabled.

## Fixtures

Canonical inputs: [tests/fixtures/media](../../tests/fixtures/media/README.md).
Six synthetic files below 5 MB, manifest with hashes/metadata, reproducible FFmpeg
source. `git lfs pull` checks out binaries; `pnpm test:fixtures` rejects pointer
text and verifies hashes/FFprobe metadata. CI enables LFS on checkout. Do not
regenerate on each test run or scatter copies under individual applications.

## Browser tests

**Harness E2E** (`apps/web/e2e`) is fast, controlled testing of sessions,
upload interruption, job/retry UI, Redis continuity recovery and SSE shutdown.
Its test-owned servers/controls are appropriate for those isolated cases and
must not be presented as real-stack upload proof.

```sh
pnpm test:e2e
pnpm --filter @editagent/web exec playwright test --config tests/playwright.config.ts e2e/job-transport-recovery.spec.ts
```

Playwright uses Chromium, one worker and explicit semantic waits. Use role/label
selectors, deterministic metadata predicates and bounded timeouts; no arbitrary
sleep for processing readiness. Never mock metadata in the walking skeleton.
Authenticate through normal UI/session boundaries. Abort streams and remove
fixture resources in teardown. Traces are retained on failure, screenshots only
on failure, result metadata always available under the configured test-results.
Do not attach credentials or authorization headers to logs. Trace files contain
browser activity: restrict artifact access/retention and sanitize exported evidence.

**Full-stack walking skeleton** is separate US-117 coverage of actual Compose
web/API/PostgreSQL/Redis/SeaweedFS/media-worker and real FFprobe processing.
Its primary flow uses no test-control API or database insertion. It complements,
and never replaces, the harness suite.

```sh
pnpm test:walking-skeleton
pnpm test:walking-skeleton --verify-failure  # stopped worker negative proof + healthy flow
# Only when the current production images are already built:
pnpm test:walking-skeleton --skip-build --verify-failure
```

The runner uses a disposable `walking-skeleton` Compose project and removes only
its volumes, preserving historical product volumes. It starts from `down -v`,
validates config, builds the actual runtime images, starts storage through the
accepted firewall installer, creates the test bucket/CORS policy, and waits for
health. It starts no AI/GPU/transcription models. Authentication is real
UI signup/signout/login; Project creation/upload are UI-only. The fixture has
exact h264, 320×180, 25/1 fps, 2000000 µs expectations. Metadata must arrive through
actual media-worker/FFprobe. No derivative completion is required. The optional
negative proof stops media-worker, requires the same metadata assertion to fail
within eight seconds, preserves failure evidence, restores the worker and reruns
healthy. A zero exit or a different failure stage invalidates the proof. The checker parses
execution errors only; source text and attachments cannot satisfy the expected
metadata assertion. Its regression also rejects a captured real authentication
error and accepts a captured real metadata timeout.

Docker and storage-firewall root/sudo privileges are prerequisites. Existing
storage subnet conflicts fail clearly: stop the other stack or remove its empty
network first. Hosts without the required IPv6 firewall backend fail closed; use the dedicated
GitHub-hosted job or a supported local Docker host for the real-stack proof. Managed-cloud image builds batch equivalent source COPYs
and supply build-only CA/proxy trust to fit VFS storage; ordinary hosts/CI use
unmodified production Dockerfiles. TLS is never disabled.

The dedicated `Walking skeleton E2E` workflow runs for PR changes in apps,
workers, packages, infra, tests, tools/test, compose files, package/lock/workspace
files, TS configs, LFS attributes or the workflow itself. Concurrency cancels
superseded PR runs. Standard/GPU configs remain validated; the test is CPU-only.
CI reuses Chrome from the recorded runner toolchain; hosts without it use a
bounded download fallback. The exact browser version is printed in the job log.
A 15-minute safety timeout allows runner setup; target full-job duration is ten
minutes. Both expected-negative and healthy evidence are uploaded.

Failure output: `.local/walking-skeleton-artifacts/`: retained trace, failure
screenshot, result metadata, browser console/status summary, Compose status,
service logs and safe durable Job status diagnostics. Before upload the sanitizer
redacts cookies/authorization/CSRF, passwords, request bodies, JWTs, URL credentials
and signed query strings, including ZIP resources and embedded JSON/base64
attachments. Ephemeral generated passwords live outside the artifact tree in a
0600 file, are redacted, then deleted. Screenshots show masked password inputs.
The sanitizer has an executable regression test. Artifact retention is seven
days; names include the workflow run ID. Startup/test failures still collect
logs, preserve nonzero exit and always run `down -v --remove-orphans`.

## CI and debugging

Fast CI runs frozen installation, LFS integrity, build/lint/architecture/typecheck,
all tests (including Testcontainers and the domain gate), coverage artifacts and
existing harness E2E. Run one test as shown above before broad checks. Coverage
files reside in each package's coverage directory; Playwright traces can be
opened with `pnpm --filter @editagent/web exec playwright show-trace <trace.zip>`.
Always preserve the failing exit code while collecting evidence and cleaning up.

The test-only MinIO image uses the final archived upstream release and checked-in
`tests/integration/support/minio.go.mod` / `minio.go.sum` with patched dependencies.
Builds use `-mod=readonly`; lockfile content automatically changes the image cache tag
and the mandatory `image test-minio` SBOM/Trivy scan. The initial upstream binary
had 4 Critical and 35 HIGH findings; the patched binary has zero of both. These
are test-only dependency fixes, separate from accepted production image debt.

PostgreSQL and Redis helpers build the accepted `infra/postgres/Dockerfile` and
`infra/redis/Dockerfile`, including their existing gosu/OpenSSL patches; directly
running the upstream base images would reintroduce 1 Critical/21 HIGH PostgreSQL
rows and 4 HIGH Redis rows. Their test image tags hash the Dockerfile/support
inputs. These same runtime builds are already required in supply-chain CI. No
security ignores or production runtime changes are used to repair those findings.
The shared Vitest config also participates in Turbo's global cache key, so a
coverage/configuration edit cannot reuse an older domain gate result.
