# Tests

Cross-package checks live here. Package unit tests live next to the code they cover.

`architecture/` holds the dependency-rule tests. The fixtures under `architecture/fixtures/` violate the rules in [docs/architecture/layer-rules.md](../docs/architecture/layer-rules.md) on purpose. They are excluded from the production dependency-cruiser run and from the AI worker's import-linter config. The tests execute the checkers against those fixtures and fail if a violation is accepted.

`pnpm test` writes coverage while it runs. TypeScript tests emit `coverage/lcov.info`. The AI worker emits `workers/ai-worker/coverage.xml`. A failing test fails the command. Percentage thresholds are left to US-116.
