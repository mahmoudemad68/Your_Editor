# EditAgent

A general-purpose autonomous multimodal AI video editor: upload raw footage, describe the result in natural language,
and an AI agent perceives, plans, edits, renders, critiques and refines the video using a programmable, sandboxed
multimedia toolset (FFmpeg, Remotion, Faster-Whisper, computer vision and pluggable LLM providers).

## Execution roadmap

The 24-week graduation plan is organized as an Agile/Scrum backlog in [docs/roadmap](docs/roadmap/README.md):
6 phases, 12 two-week sprints, epics, features, user stories with acceptance criteria, technical tasks, dependencies,
milestones and ready-to-import CSV files for Jira, Linear and GitHub Projects.

## Architecture

The architecture baseline (US-103) lives in [docs/architecture](docs/architecture/README.md): module boundaries,
C4 diagrams, layer rules, the ports catalogue, and ADR-001 through ADR-008. The project team / product owner
accepted those ADRs on 2026-09-29 through PR #2.

## Prerequisites

- Node.js 22.23.2 (see `.nvmrc`). `package.json` `engines` accepts `>=22.14.0 <23` and `engine-strict` rejects anything outside that range. The pin stops a major-only selector from choosing 22.0–22.13.
- pnpm 10.33 (see `packageManager` in `package.json`). Enable it with Corepack:
  `corepack enable && corepack prepare pnpm@10.33.3 --activate`
- [uv](https://docs.astral.sh/uv/) for the Python AI worker. uv installs CPython 3.11 from `workers/ai-worker/.python-version`.
- Python 3 is already required for the roadmap validator (`python3 tools/roadmap/build_roadmap.py --check`)

TypeScript is pinned to 6.0.3 because current `typescript-eslint` does not yet accept TypeScript 7.

## Fresh clone

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

`pnpm build` also runs `uv sync --frozen` in `workers/ai-worker`, which creates that package's virtual environment
and installs Ruff, mypy, pytest, pytest-cov, and import-linter. Run the Python tools through the package scripts (`pnpm --filter @editagent/ai-worker test`) or from that directory with `uv run`.

`pnpm test` writes coverage reports (`coverage/lcov.info` for TypeScript, `workers/ai-worker/coverage.xml` for the AI worker) and fails if a report is missing. It does not enforce a coverage percentage.

One aggregate check:

```bash
pnpm check
```

That runs the roadmap validator, then build, lint, typecheck, and test.

## Commands

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `pnpm install`      | Install TypeScript workspace dependencies and set up Git hooks |
| `pnpm build`        | Build every app, package, and worker                           |
| `pnpm test`         | Unit tests, architecture-rule tests, and coverage reports      |
| `pnpm lint`         | ESLint, Prettier, dependency-cruiser, Ruff, and import-linter  |
| `pnpm typecheck`    | `tsc --noEmit` and mypy                                        |
| `pnpm architecture` | dependency-cruiser and the AI worker's import-linter contracts |
| `pnpm check`        | Roadmap validator plus build, lint, typecheck, and test        |

Architecture checks read compiled workspace packages, so run `pnpm build` before `pnpm lint` on a fresh tree. `pnpm check` does that for you. The web typecheck also reads route types that `next build` writes, so build before `pnpm typecheck` as well.

Git hooks (Husky) run lint-staged on commit and Conventional Commits on the commit message. A staged TypeScript file that fails ESLint is rejected. The invalid architecture fixtures are not part of that path; `pnpm test` proves those fixtures are rejected.

## Python worker

```bash
cd workers/ai-worker
uv sync --frozen
uv run pytest  # writes coverage.xml
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run lint-imports
uv run python -m editagent_ai_worker
```

The package does not install ASR, VAD, or model libraries. Those arrive with later analysis stories.

## Repository structure

```text
apps/web                 Next.js presentation
apps/api                 NestJS API bootstrap
workers/agent-worker     Node worker scaffold
workers/media-worker     Node worker scaffold
workers/render-worker    Node worker scaffold
workers/ai-worker        Python 3.11 worker scaffold
packages/domain          Framework-free domain kernel and module boundaries
packages/schemas         JSON Schema contracts
packages/tool-sdk        Tools package marker
packages/media-core      FFmpeg adapter package marker
packages/shared          Cross-cutting utilities
infra/                   Deployment home (Compose is a later story)
tests/architecture       Dependency-rule tests and violating fixtures
docs/architecture        Architecture baseline and ADRs
docs/roadmap             Agile backlog
tools/architecture       dependency-cruiser rule set
tools/roadmap            Roadmap generator
tools/test               Node test coverage runner
```

## What this scaffold does not include

Pull requests that target `main` run the checks in [docs/process/pull-requests.md](docs/process/pull-requests.md).

Project CRUD, the web dashboard, authentication, Docker Compose, Redis, BullMQ, PostgreSQL, MinIO, LLM providers, FFmpeg, and Remotion are later Sprint 1 stories. The directories exist so those stories have a place to land. They are not implemented here.
