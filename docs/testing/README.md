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
node --test tests/integration/domain-coverage-gate.test.mjs
```

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
and never replaces, the harness suite. The follow-on US-117 commit adds its
runner, dedicated PR workflow and failure diagnostics.

## CI and debugging

Fast CI runs frozen installation, LFS integrity, build/lint/architecture/typecheck,
all tests (including Testcontainers and the domain gate), coverage artifacts and
existing harness E2E. Run one test as shown above before broad checks. Coverage
files reside in each package's coverage directory; Playwright traces can be
opened with `pnpm --filter @editagent/web exec playwright show-trace <trace.zip>`.
Always preserve the failing exit code while collecting evidence and cleaning up.
