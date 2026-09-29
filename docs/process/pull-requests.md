# Pull requests

Work lands on `main` through a short-lived branch and a pull request. That practice is [ADR-007](../architecture/adr/007-trunk-based-development.md). This page is the path a change follows, and the checks [US-112](../roadmap/phases/phase-1-foundation.md#us-112---ci-pipeline-baseline-with-required-checks) runs on the way. The story [Definition of Done](../roadmap/README.md#definition-of-done-story-level) still applies in full, including the checklist in the [pull request template](../../.github/PULL_REQUEST_TEMPLATE.md).

## Branch

Cut the branch from the latest `main`. Keep it short-lived. Commit messages follow Conventional Commits.

## Open a pull request

Open the pull request against `main`. Fill in the template: summary, stories, the Definition of Done checklist, and the test plan. The template holds that checklist.

## Automated checks

Every pull request targeting `main` runs the [CI workflow](../../.github/workflows/ci.yml). The job name is `ci`, which is the GitHub status check context. The workflow calls the monorepo commands:

| Step         | Command                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| Roadmap      | `python3 tools/roadmap/build_roadmap.py --check`                        |
| Install      | `pnpm install --frozen-lockfile`                                        |
| Build        | `pnpm build`                                                            |
| Lint         | `pnpm lint` (ESLint, Prettier, dependency-cruiser, Ruff, import-linter) |
| Architecture | `pnpm architecture`                                                     |
| Typecheck    | `pnpm typecheck` (`tsc` and mypy)                                       |
| Test         | `pnpm test` (TypeScript `node:test` and the AI worker's pytest)         |

Node comes from `.nvmrc`. pnpm comes from `packageManager` in the root `package.json`. The AI worker stays on Python 3.11 through uv (`workers/ai-worker/.python-version` and `requires-python`). Python dependencies install with `uv sync --frozen`. The roadmap validator installs the same PyYAML pin the roadmap workflow uses (`pyyaml==6.0.1`).

`pnpm test` writes coverage for the tests that exist today:

- TypeScript packages and the architecture tests write `coverage/lcov.info`
- `workers/ai-worker` writes `coverage.xml`

The CI job uploads those files as the `coverage` artifact. A failing test fails `pnpm test` and fails the `ci` check. Coverage percentage gates belong to [US-116](../roadmap/phases/phase-1-foundation.md#us-116---test-frameworks-fixtures-and-integration-harness).

Unchanged packages are skipped from the Turborepo cache. CI restores that cache from GitHub Actions (`.turbo`) and also caches the pnpm store and the uv cache. Turborepo passes `UV_CACHE_DIR` through to tasks so `uv sync` writes into the directory `astral-sh/setup-uv` saves. A Vercel remote cache is optional: when the repository secrets `TURBO_TOKEN` and `TURBO_TEAM` are both set, the workflow turns it on. When they are absent, the GitHub Actions cache of `.turbo` is the Turborepo cache. Do not commit tokens.

Supply-chain scanners, image publish, and the staging deploy are [US-113](../roadmap/phases/phase-1-foundation.md#us-113---supply-chain-security-image-publishing-and-cd-to-staging). They are outside this workflow.

## Review and approval

GitHub must require one approving review before merge. Reviews are due within one working day.

The Definition of Done still requires a second approval for security-sensitive modules (auth, tool executor, sandbox, acquisition) once those modules exist. [CODEOWNERS](../../.github/CODEOWNERS) maps paths to module slugs. Those slugs are placeholders until GitHub teams exist, so the second approval stays a review practice from the Definition of Done.

## Up to date with main

The branch must contain the latest `main` before merge. Branch protection uses strict required status checks: update the branch, then wait for `ci` to finish on that revision.

## Merge

Merge only when `ci` is green, the required approval is present, and the branch is up to date with `main`. A red `ci` check blocks the merge once branch protection requires that check. Delete the branch after merge.

Repository administration has to record that gate on `main`:

- required status check: `ci`
- required approving reviews: 1
- require the branch to be up to date before merging (strict required status checks)

Applying those settings needs administration permission on the repository (Settings → Branches, or the branch protection API).
