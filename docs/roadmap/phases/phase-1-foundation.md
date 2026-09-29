<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# PH1 - Foundation and Walking Skeleton

| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |
|---|---|---|---|---|---|
| Sprint 1, Sprint 2 | Weeks 1-4 | v0.1 "Ingest" | mvp | 98 SP (31 stories) | M0 Architecture Baseline and Walking Skeleton, CP1 Technology Feasibility, M1 v0.1 Ingest |

[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | [Dependencies](../dependencies.md) | [Milestones](../milestones.md)

## 1. Objective

Turn the project vision into measurable requirements and an agreed architecture, then ship a deployable, CI/CD-verified modular-monolith skeleton in which authenticated users upload raw media that is validated, inspected, stored and prepared (proxy, audio, thumbnails) by asynchronous jobs. This replaces the original Phases 0, 1 and 2, and pulls the job queue (original Phase 14) and security/observability baselines (original Phases 15 and 18) forward because every later increment depends on them.

## 2. Epics

| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |
|---|---|---|---|---|---|
| [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline) Product Discovery and Architecture Baseline | Convert the vision into measurable requirements, an agreed architecture and a de-risked technology choice. | S1, S2 | 27 | None | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing) |
| [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience) Engineering Platform and Developer Experience | Provide a reproducible, automated build-test-deploy platform that enforces the architecture rules. | S1, S2 | 24 | [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core) | - |
| [EP-03](phase-1-foundation.md#ep-03---identity-and-project-management) Identity and Project Management | Let users securely sign in and organize work into projects. | S1, S2 | 13 | [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline) | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing) |
| [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core) Media Ingestion and Multimedia Core | Accept, validate, inspect, store and prepare raw media independently of any AI component. | S1, S2 | 24 | [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-03](phase-1-foundation.md#ep-03---identity-and-project-management), [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing) | - |
| [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing) Asynchronous Job Processing | Run every expensive operation asynchronously with observable, recoverable job states. | S2 | 10 | [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience) | [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-03](phase-1-foundation.md#ep-03---identity-and-project-management) |

## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria

Task tags: `TEST`, `DOC`, `CI/CD`, `SECURITY`, `INTEGRATION` mark testing, documentation, CI/CD, security and integration work that is built into the story itself. Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).

### EP-01 - Product Discovery and Architecture Baseline

**Epic goal:** Convert the vision into measurable requirements, an agreed architecture and a de-risked technology choice.

#### FT-01.1 - Requirements Specification

Functional and non-functional requirements, MVP boundary, user roles and target platforms.

##### US-101 - Software Requirements Specification with measurable NFRs

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 1 | Whole team | None | Parallel - can start on day 1 of the sprint |

**User story:** As the product owner (supervisor), I want a baselined SRS with measurable quality targets, so that scope, MVP boundary and acceptance can be verified objectively.

**Technical tasks**

- [ ] `US-101-T1` Run a requirements workshop and capture functional requirements as numbered FR-xxx items traced to use cases
- [ ] `US-101-T2` Define NFRs with thresholds - supported inputs (MP4, MOV, MKV, WebM; H.264, HEVC, VP9, AV1; AAC, Opus, PCM), max input 30 min / 4 GB for MVP, output H.264/AAC MP4 up to 1080p, processing-time targets, availability
- [ ] `US-101-T3` Specify target platform presets (TikTok, Instagram Reels, YouTube Shorts) with resolution, max duration, safe zones and loudness targets
- [ ] `US-101-T4` Define user roles (Owner, Editor, Viewer, Admin), security boundaries, deployment environment, hardware and storage strategy
- [ ] `US-101-T5` Document the MVP boundary (talking-head, podcast, educational footage) and the explicit out-of-scope list
- [ ] `US-101-T6` `DOC` Publish docs/requirements/srs.md and review it through a pull request with the whole team

**Acceptance criteria**

- [ ] AC1. Given the SRS, when any NFR is read, then it contains a measurable threshold and a verification method
- [ ] AC2. Given the MVP boundary section, when a feature is proposed, then it can be classified as MVP, advanced or out of scope without discussion
- [ ] AC3. The supervisor approves SRS v1.0 at the Sprint 1 review and the approval is recorded in the document history

##### US-102 - Use cases, user journeys and domain glossary

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | Whole team | None | Parallel - can start on day 1 of the sprint |

**User story:** As a team member, I want shared use cases and a ubiquitous-language glossary, so that code, tickets and documents use the same terms.

**Technical tasks**

- [ ] `US-102-T1` Draw the use case diagram (Creator, Admin, AI Agent as secondary actor, external asset providers)
- [ ] `US-102-T2` Write user journeys for evaluation scenarios A-G from the original plan
- [ ] `US-102-T3` Write the glossary (MediaAsset, Project, Timeline, Track, Clip, Effect, Tool, Component, AgentRun, Critique, BrandKit, CreativeMemory)
- [ ] `US-102-T4` `DOC` Commit diagrams as source (PlantUML or Mermaid) plus exported images under docs/architecture

**Acceptance criteria**

- [ ] AC1. Every scenario A-G maps to at least one use case and at least one future epic
- [ ] AC2. Glossary terms are used verbatim as domain class names in US-104

#### FT-01.2 - Architecture and Design Decisions

Clean Architecture modular monolith with workers, recorded as ADRs.

##### US-103 - Architecture baseline, module boundaries and ADRs

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 1 | Backend Engineer | None | Parallel - can start on day 1 of the sprint |

**User story:** As a developer, I want an agreed architecture with explicit module boundaries and recorded decisions, so that I can build my module without coupling to others.

**Technical tasks**

- [ ] `US-103-T1` Produce C4 context and container diagrams (web, api, agent-worker, ai-worker, media-worker, render-worker, Postgres, Redis, object storage)
- [ ] `US-103-T2` Define bounded modules (Identity, Projects, Media, Analysis, Editing, Tools, Agent, Rendering, Assets, Components, Critic, Jobs) and their public interfaces
- [ ] `US-103-T3` Define layer rules (presentation -> application -> domain; infrastructure implements domain ports) and the ports and adapters catalogue
- [ ] `US-103-T4` Write ADR-001 modular monolith plus workers, ADR-002 TypeScript for api/web/agent/render and Python for ai-worker, ADR-003 JSON Schema as cross-language contract
- [ ] `US-103-T5` Write ADR-004 Redis + BullMQ queue, ADR-005 Postgres + S3-compatible storage (MinIO), ADR-006 LLM provider abstraction, ADR-007 branching (trunk-based with short-lived branches), ADR-008 time representation as integer microseconds/frames
- [ ] `US-103-T6` `DOC` Publish docs/architecture/README.md with diagrams and an ADR index

**Acceptance criteria**

- [ ] AC1. Given any planned story, when its module is looked up, then exactly one owning module is identified
- [ ] AC2. All 8 ADRs are accepted by the team in a reviewed pull request
- [ ] AC3. The layer and module dependency rules are written in a form that US-111 can enforce automatically

##### US-104 - Initial domain model and ER design

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | Backend Engineer | [US-102](phase-1-foundation.md#us-102---use-cases-user-journeys-and-domain-glossary) | Sequential after US-102 (same sprint; contract-first stubs allowed) |

**User story:** As a backend engineer, I want an initial domain model and database design, so that persistence and APIs grow from a consistent foundation.

**Technical tasks**

- [ ] `US-104-T1` Model aggregates (User, Project, MediaAsset with Video/Audio/Image subtypes, DerivedAsset, Job) with invariants
- [ ] `US-104-T2` Draw the ER diagram with UUIDv7 keys, audit columns, soft delete and ownership
- [ ] `US-104-T3` Define the persistence approach (repository interfaces in domain, ORM mapping in infrastructure)
- [ ] `US-104-T4` `DOC` Commit the class and ER diagrams to docs/architecture/data-model.md

**Acceptance criteria**

- [ ] AC1. Every aggregate has one repository interface and no ORM types in the domain package
- [ ] AC2. The ER diagram covers every entity required by Sprint 1 and Sprint 2 stories

#### FT-01.3 - Technology Validation and Risk Management

Time-boxed spikes answer the riskiest feasibility questions before the team commits.

##### US-105 - ASR and VAD feasibility spike

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 1 | AI / Agent Engineer | None | Parallel - can start on day 1 of the sprint |

**User story:** As the AI engineer, I want benchmark numbers for Faster-Whisper and VAD on our hardware, so that the model size and hardware plan are chosen on evidence.

**Technical tasks**

- [ ] `US-105-T1` Benchmark Faster-Whisper small/medium/large-v3 (int8 and float16) on the reference GPU and on CPU for 10 minutes of English and Arabic speech
- [ ] `US-105-T2` Measure word-timestamp quality on 3 hand-aligned clips and Silero VAD segmentation quality
- [ ] `US-105-T3` Record memory usage, throughput and model licenses
- [ ] `US-105-T4` `DOC` Write the ASR section of docs/research/technology-evaluation.md with a go/no-go recommendation

**Acceptance criteria**

- [ ] AC1. The report states the default model, fallback model and hardware requirement with measured numbers
- [ ] AC2. Checkpoint CP1 ASR criterion is evaluated with a pass or fail result

##### US-106 - Rendering feasibility spike (FFmpeg vs Remotion)

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | Generative Video / Remotion Engineer | None | Parallel - can start on day 1 of the sprint |

**User story:** As the generative video engineer, I want render-time measurements for FFmpeg and Remotion, so that we choose the right render strategy for each kind of edit.

**Technical tasks**

- [ ] `US-106-T1` Render a 60-second 1080p 9:16 composition with video, captions and one animated title in Remotion and measure time and memory
- [ ] `US-106-T2` Render the equivalent cut-and-concat edit with FFmpeg only and compare
- [ ] `US-106-T3` Evaluate Remotion licensing for the team and headless Chromium requirements in containers
- [ ] `US-106-T4` `DOC` Record results and the hybrid render-strategy recommendation in the technology evaluation document

**Acceptance criteria**

- [ ] AC1. The report states render time per output second for both strategies on the reference machine
- [ ] AC2. Checkpoint CP1 rendering criterion is evaluated with a pass or fail result

##### US-107 - LLM tool-calling feasibility spike

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | AI / Agent Engineer | None | Parallel - can start on day 1 of the sprint |

**User story:** As the AI engineer, I want to measure how reliably candidate LLMs produce schema-valid tool calls, so that the agent design and default provider are chosen on evidence.

**Technical tasks**

- [ ] `US-107-T1` Define 10 scripted editing requests with a mock tool set (trim, add_caption, reframe)
- [ ] `US-107-T2` Run them against at least two hosted providers and one local model (vLLM or Ollama) with native tool calling
- [ ] `US-107-T3` Measure schema validity, latency, cost per run and context-window fit for a 10-minute transcript
- [ ] `US-107-T4` `DOC` Record results, costs and the default/fallback provider decision

**Acceptance criteria**

- [ ] AC1. Each candidate has a measured valid-call rate, median latency and estimated cost per agent run
- [ ] AC2. Checkpoint CP1 LLM criterion is evaluated with a pass or fail result

##### US-108 - Risk register and threat model v0

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | DevOps & QA (shared) | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) | Sequential after US-103 (same sprint; contract-first stubs allowed) |

**User story:** As the team, I want a living risk register and an initial threat model, so that technical, schedule and security risks are owned and mitigated early.

**Technical tasks**

- [ ] `US-108-T1` Create the risk register with probability, impact, owner, trigger and mitigation (GPU access, LLM cost, render time, scope creep, sandbox complexity, dataset licensing)
- [ ] `US-108-T2` Run a STRIDE session on the container diagram data flows (upload, workers, LLM calls, future sandbox and internet access)
- [ ] `US-108-T3` List the security controls required per phase and map them to stories
- [ ] `US-108-T4` `SECURITY` Record threats with IDs so that later security tests can reference them

**Acceptance criteria**

- [ ] AC1. Every high risk has an owner and a mitigation linked to a backlog item
- [ ] AC2. Every threat listed in the original plan (malicious code, packages, media, command injection, path traversal, resource exhaustion, prompt injection, shell access, dependency attacks) has at least one planned control

##### US-110 - Evaluation dataset collection and metric definitions

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | AI / Agent Engineer | [US-101](phase-1-foundation.md#us-101---software-requirements-specification-with-measurable-nfrs) | Parallel - can start on day 1 of the sprint |

**User story:** As the AI engineer, I want a licensed evaluation dataset with reference edits and metric definitions, so that every AI feature is measured against the same baseline from its first sprint.

**Technical tasks**

- [ ] `US-110-T1` Collect at least 12 videos across podcast, educational, talking head, interview, gaming and technical tutorial, with written consent or compatible licenses
- [ ] `US-110-T2` Produce human-edited reference reels for at least 6 videos and hand-labelled silence ranges and word alignments for 3 clips
- [ ] `US-110-T3` Define metrics (caption WER, caption sync error, silence removal accuracy, content retention, render success rate, editing time, human acceptance rate, manual corrections)
- [ ] `US-110-T4` Store media outside git (versioned bucket) with a manifest file in the repository
- [ ] `US-110-T5` `DOC` Document the dataset card and metric formulas in docs/evaluation

**Acceptance criteria**

- [ ] AC1. The manifest lists every file with category, license, duration and reference artifacts
- [ ] AC2. Every metric has a formula, a unit and the story that will first report it

#### FT-01.4 - Backlog and Ways of Working

Scrum cadence, board and team agreements.

##### US-109 - Product backlog, board and team working agreements

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 1 | Sprint 1 | Whole team | None | Parallel - can start on day 1 of the sprint |

**User story:** As the Scrum team, I want the backlog imported and our working agreements written down, so that planning, WIP limits and review rules are the same for everyone.

**Technical tasks**

- [ ] `US-109-T1` Import export/jira-import.csv into the tracker and configure the board (Backlog, Ready, In Progress, In Review, Done) with WIP limits
- [ ] `US-109-T2` Agree on the Definition of Ready, the Definition of Done, estimation scale and ceremony calendar
- [ ] `US-109-T3` Assign lane owners and review buddies for every lane
- [ ] `US-109-T4` `DOC` Commit docs/process/working-agreements.md

**Acceptance criteria**

- [ ] AC1. Sprint 1 and Sprint 2 stories are visible on the board with points and owners
- [ ] AC2. Working agreements are approved by every team member

### EP-02 - Engineering Platform and Developer Experience

**Epic goal:** Provide a reproducible, automated build-test-deploy platform that enforces the architecture rules.

#### FT-02.1 - Monorepo and Code Quality

##### US-111 - Monorepo scaffold with enforced architecture rules

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 1 | DevOps & QA (shared) | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) | Sequential after US-103 (same sprint; contract-first stubs allowed) |

**User story:** As a developer, I want a monorepo with consistent tooling and automatically enforced layer rules, so that code quality and Clean Architecture do not depend on memory.

**Technical tasks**

- [ ] `US-111-T1` Create pnpm workspaces with Turborepo - apps/web (Next.js), apps/api (NestJS), workers/agent-worker, workers/media-worker, workers/render-worker (Node), workers/ai-worker (Python 3.11 with uv)
- [ ] `US-111-T2` Create packages/domain, packages/schemas, packages/tool-sdk, packages/media-core, packages/shared plus infra/, tests/ and docs/
- [ ] `US-111-T3` Configure strict TypeScript, ESLint, Prettier, Ruff and mypy; add husky/lint-staged and pre-commit hooks; enforce Conventional Commits
- [ ] `US-111-T4` Enforce dependency rules with dependency-cruiser (TS) and import-linter (Python) so domain cannot import infrastructure or frameworks
- [ ] `US-111-T5` Add CODEOWNERS per module and a pull request template containing the DoD checklist
- [ ] `US-111-T6` `TEST` Add a deliberately violating fixture that proves the dependency rule fails the lint step

**Acceptance criteria**

- [ ] AC1. On a fresh clone, pnpm install, build and test succeed with one command each
- [ ] AC2. A commit with lint errors is rejected by the pre-commit hook
- [ ] AC3. An import from packages/domain to an infrastructure package fails the lint step

#### FT-02.2 - Continuous Integration and Delivery

##### US-112 - CI pipeline baseline with required checks

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 1 | DevOps & QA (shared) | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) | Sequential after US-111 (same sprint; contract-first stubs allowed) |

**User story:** As a developer, I want every pull request built and tested automatically, so that main is always releasable.

**Technical tasks**

- [ ] `US-112-T1` `CI/CD` GitHub Actions workflow running lint, type checks, TS and Python unit tests with coverage reports on every pull request
- [ ] `US-112-T2` `CI/CD` Turborepo remote/local caching so unchanged packages are skipped
- [ ] `US-112-T3` `CI/CD` Branch protection on main requiring green CI, one approval and an up-to-date branch
- [ ] `US-112-T4` `DOC` Document the pull request flow (PR, automated tests, review, approval, merge)

**Acceptance criteria**

- [ ] AC1. A failing unit test blocks the merge of a pull request
- [ ] AC2. CI completes in under 10 minutes for a typical change

##### US-113 - Supply-chain security, image publishing and CD to staging

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | DevOps & QA (shared) | [US-112](phase-1-foundation.md#us-112---ci-pipeline-baseline-with-required-checks), [US-114](phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration) | Parallel - can start on day 1 of the sprint |

**User story:** As the team, I want dependencies, secrets and images scanned and main deployed to staging automatically, so that security and integration problems surface on the day they are introduced.

**Technical tasks**

- [ ] `US-113-T1` `SECURITY` Add gitleaks secret scanning, npm audit/pip-audit or OSV-Scanner, and Trivy image scanning; fail on critical findings
- [ ] `US-113-T2` `CI/CD` Build and push versioned images to GHCR on merge to main; generate an SBOM with Syft
- [ ] `US-113-T3` `CI/CD` Deploy main to the staging host with Docker Compose and run a smoke test
- [ ] `US-113-T4` Configure Dependabot or Renovate with grouped weekly updates
- [ ] `US-113-T5` `DOC` Document the release and rollback procedure

**Acceptance criteria**

- [ ] AC1. A commit containing a fake secret fails CI
- [ ] AC2. Every merge to main produces tagged images, an SBOM and a staging deployment that passes the smoke test

#### FT-02.3 - Runtime Environment and Configuration

##### US-114 - Docker Compose environment with typed configuration

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 1 | DevOps & QA (shared) | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) | Sequential after US-111 (same sprint; contract-first stubs allowed) |

**User story:** As a developer, I want the full system to start with one command using validated configuration, so that "works on my machine" problems disappear.

**Technical tasks**

- [ ] `US-114-T1` Write Dockerfiles (multi-stage, non-root) for api, web and each worker, and a compose file with Postgres, Redis and MinIO plus healthchecks
- [ ] `US-114-T2` Add an optional GPU compose profile using the NVIDIA container runtime for ai-worker
- [ ] `US-114-T3` Implement typed configuration (zod for TS, pydantic-settings for Python) that fails fast on missing or invalid values; provide .env.example
- [ ] `US-114-T4` Add make targets (up, down, seed, test, logs) and a seed script
- [ ] `US-114-T5` `SECURITY` Ensure no secrets are baked into images and .env files are git-ignored
- [ ] `US-114-T6` `TEST` Add a startup test proving a missing required variable stops the service with a clear message

**Acceptance criteria**

- [ ] AC1. From a fresh clone, docker compose up brings all services to healthy in under 5 minutes excluding image download
- [ ] AC2. Starting the API without the database URL fails immediately with a readable error

##### US-115 - Structured logging, health checks and error handling baseline

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | DevOps & QA (shared) | [US-114](phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration) | Parallel - can start on day 1 of the sprint |

**User story:** As an operator, I want structured logs with correlation IDs and consistent error responses, so that any failure can be traced across the API, queue and workers.

**Technical tasks**

- [ ] `US-115-T1` Add pino (TS) and structlog (Python) JSON logging with request and job correlation IDs propagated through job payloads
- [ ] `US-115-T2` Add /health and /ready endpoints for every service
- [ ] `US-115-T3` Implement a global error filter returning RFC 7807 problem+json without leaking stack traces
- [ ] `US-115-T4` Initialize the OpenTelemetry SDK with a no-op exporter so tracing can be enabled later without code changes
- [ ] `US-115-T5` `TEST` Integration test asserting one correlation ID appears in API and worker logs for the same upload

**Acceptance criteria**

- [ ] AC1. A request ID sent by the web app appears in every log line produced by the resulting jobs
- [ ] AC2. Unhandled errors return problem+json with a trace ID and no internal details

#### FT-02.4 - Test Infrastructure

##### US-116 - Test frameworks, fixtures and integration harness

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | DevOps & QA (shared) | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) | Parallel - can start on day 1 of the sprint |

**User story:** As a developer, I want ready-to-use unit, integration and E2E frameworks with media fixtures, so that writing tests is the easiest path.

**Technical tasks**

- [ ] `US-116-T1` Configure Vitest (TS), pytest (Python) and Playwright (E2E) with shared conventions
- [ ] `US-116-T2` Add Testcontainers-based helpers for Postgres, Redis and MinIO
- [ ] `US-116-T3` Create tiny media fixtures (under 5 MB, Git LFS) - talking head, silence gaps, 2 speakers, variable frame rate, rotated phone video, corrupt file
- [ ] `US-116-T4` `CI/CD` Enforce coverage thresholds (domain packages at least 80 percent lines)
- [ ] `US-116-T5` `DOC` Write docs/testing/README.md explaining the test pyramid and where each kind of test lives

**Acceptance criteria**

- [ ] AC1. A sample integration test using Postgres, Redis and MinIO containers runs in CI
- [ ] AC2. Coverage below the threshold fails CI for domain packages

##### US-117 - Walking-skeleton end-to-end test in CI

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 2 | DevOps & QA (shared) | [US-116](phase-1-foundation.md#us-116---test-frameworks-fixtures-and-integration-harness), [US-126](phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe), [US-124](phase-1-foundation.md#us-124---upload-and-media-details-page) | Sequential after US-116 (same sprint; contract-first stubs allowed) |

**User story:** As the team, I want an automated end-to-end test of the upload flow, so that every change is proven against the full running system.

**Technical tasks**

- [ ] `US-117-T1` `TEST` Playwright test - log in, create project, upload fixture, wait for metadata, assert codec, resolution, fps and duration
- [ ] `US-117-T2` `CI/CD` Run the E2E suite against the compose stack in CI on every pull request touching apps or workers
- [ ] `US-117-T3` `CI/CD` Upload Playwright traces and service logs as CI artifacts on failure

**Acceptance criteria**

- [ ] AC1. The E2E test passes in CI and fails if the metadata job is broken
- [ ] AC2. Failure artifacts allow a developer to diagnose the failing step without rerunning locally

### EP-03 - Identity and Project Management

**Epic goal:** Let users securely sign in and organize work into projects.

#### FT-03.1 - Authentication and Authorization

##### US-118 - Secure authentication and project-level authorization

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 2 | Backend Engineer | [US-120](phase-1-foundation.md#us-120---project-crud-api) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to sign up and sign in securely and only see my projects, so that my footage stays private.

**Technical tasks**

- [ ] `US-118-T1` Implement registration and login with argon2id password hashing and email uniqueness
- [ ] `US-118-T2` Issue short-lived JWT access tokens and rotating refresh tokens in httpOnly, SameSite cookies
- [ ] `US-118-T3` Implement role-based authorization (Owner, Editor, Viewer, Admin) as an application-layer policy, not in controllers
- [ ] `US-118-T4` `SECURITY` Add rate limiting and lockout on auth endpoints, CSRF protection and secure headers
- [ ] `US-118-T5` `TEST` Unit tests for policies and integration tests proving a user cannot read another user's project or media

**Acceptance criteria**

- [ ] AC1. Given user A, when requesting user B's project or media by ID, then the API returns 404 without leaking existence
- [ ] AC2. Passwords are stored only as argon2id hashes; tokens expire and refresh correctly

##### US-119 - Sign-up, sign-in and session handling in the web app

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | Frontend Engineer | [US-118](phase-1-foundation.md#us-118---secure-authentication-and-project-level-authorization), [US-121](phase-1-foundation.md#us-121---web-application-shell-and-project-dashboard) | Sequential after US-118 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want simple sign-up and sign-in screens, so that I can start using EditAgent in under a minute.

**Technical tasks**

- [ ] `US-119-T1` Build sign-up, sign-in and sign-out screens with form validation
- [ ] `US-119-T2` Implement silent token refresh and redirect-to-login on expiry
- [ ] `US-119-T3` Protect application routes and show the current user in the shell
- [ ] `US-119-T4` `TEST` Playwright tests for sign-up, sign-in, expired session and logout

**Acceptance criteria**

- [ ] AC1. A new user can register and reach the dashboard in under one minute
- [ ] AC2. An expired session redirects to sign-in and returns the user to the original page afterwards

#### FT-03.2 - Projects

##### US-120 - Project CRUD API

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | Backend Engineer | [US-104](phase-1-foundation.md#us-104---initial-domain-model-and-er-design) | Sequential after US-104 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to create, rename, list and delete projects, so that each editing job has its own workspace.

**Technical tasks**

- [ ] `US-120-T1` Implement Project aggregate, repository interface and Postgres repository with migrations
- [ ] `US-120-T2` Implement application use cases (CreateProject, RenameProject, ListProjects, DeleteProject) and thin REST controllers
- [ ] `US-120-T3` Publish the OpenAPI specification from the API build
- [ ] `US-120-T4` `TEST` Unit tests for use cases with an in-memory repository; integration test against Postgres

**Acceptance criteria**

- [ ] AC1. Controllers contain no business logic; all rules live in use cases or the domain
- [ ] AC2. The OpenAPI document is generated automatically and matches the implemented endpoints

##### US-121 - Web application shell and project dashboard

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 1 | Frontend Engineer | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) | Sequential after US-111 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want a dashboard listing my projects, so that I can create a project and open it.

**Technical tasks**

- [ ] `US-121-T1` Scaffold the Next.js app shell with Tailwind and a component library (shadcn/ui) and a layout with navigation
- [ ] `US-121-T2` Generate a typed API client from the OpenAPI document
- [ ] `US-121-T3` Build project list, create and delete flows with empty and error states
- [ ] `US-121-T4` `TEST` Component tests for the project list and create dialog

**Acceptance criteria**

- [ ] AC1. The dashboard lists projects from the API and creates a new one without a page reload
- [ ] AC2. The API client is generated, not hand-written

### EP-04 - Media Ingestion and Multimedia Core

**Epic goal:** Accept, validate, inspect, store and prepare raw media independently of any AI component.

#### FT-04.1 - Upload and Storage

##### US-122 - Object storage port and direct upload

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 1 | Backend Engineer | [US-120](phase-1-foundation.md#us-120---project-crud-api) | Sequential after US-120 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to upload a video to my project, so that the system can work with my footage.

**Technical tasks**

- [ ] `US-122-T1` Define the IObjectStorage port in the domain and implement an S3-compatible adapter (MinIO locally)
- [ ] `US-122-T2` Implement presigned upload URLs and an upload-complete use case that creates a MediaAsset
- [ ] `US-122-T3` Store objects under server-generated content-addressed keys; never use user-supplied names in paths
- [ ] `US-122-T4` `SECURITY` Enforce maximum size and allowed MIME types at URL issuance
- [ ] `US-122-T5` `TEST` Integration test uploading a fixture to MinIO and creating the MediaAsset record

**Acceptance criteria**

- [ ] AC1. An uploaded file is stored in object storage and linked to its project
- [ ] AC2. A filename such as ../../etc/passwd is stored only as display metadata and never affects the storage key

##### US-123 - Resumable large-file upload

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 2 | Frontend Engineer | [US-122](phase-1-foundation.md#us-122---object-storage-port-and-direct-upload) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator with slow internet, I want large uploads to resume after interruptions, so that I do not restart a 2 GB upload.

**Technical tasks**

- [ ] `US-123-T1` Implement S3 multipart presigned uploads (or a tus endpoint) with per-part retry
- [ ] `US-123-T2` Persist upload state so a page reload resumes remaining parts
- [ ] `US-123-T3` Show accurate progress, speed and remaining time
- [ ] `US-123-T4` `TEST` E2E test that interrupts the network mid-upload and verifies completion after resume

**Acceptance criteria**

- [ ] AC1. Given a 1.5 GB file interrupted at 50 percent, when the connection returns, then only the remaining parts are uploaded
- [ ] AC2. A completed upload's checksum matches the source file

##### US-124 - Upload and media details page

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 1 | Frontend Engineer | [US-121](phase-1-foundation.md#us-121---web-application-shell-and-project-dashboard) | Sequential after US-121 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to drag and drop footage and see its technical details, so that I know the system understood my file.

**Technical tasks**

- [ ] `US-124-T1` Build a drag-and-drop upload area inside the project page
- [ ] `US-124-T2` Show a media details panel (container, codecs, resolution, frame rate, duration, audio streams)
- [ ] `US-124-T3` `TEST` Component test for the upload area and details rendering

**Acceptance criteria**

- [ ] AC1. After upload, the details panel shows values that match FFprobe output for the fixture
- [ ] AC2. Unsupported files show a readable error message

##### US-125 - Media library with thumbnails and proxy playback

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | Frontend Engineer | [US-128](phase-1-foundation.md#us-128---proxy-audio-extraction-and-thumbnail-generation), [US-124](phase-1-foundation.md#us-124---upload-and-media-details-page) | Sequential after US-128 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want a media library with thumbnails and smooth playback, so that I can review my footage in the browser.

**Technical tasks**

- [ ] `US-125-T1` Build a media grid with poster thumbnails, duration badges and processing status
- [ ] `US-125-T2` Play the 540p proxy with hover-scrub sprites
- [ ] `US-125-T3` Handle processing, failed and ready states
- [ ] `US-125-T4` `TEST` Component and E2E tests for the library states

**Acceptance criteria**

- [ ] AC1. A processed video plays its proxy in the browser without downloading the original
- [ ] AC2. Failed media show the failure reason from the validation job

#### FT-04.2 - Media Inspection and Validation

##### US-126 - Media metadata extraction with FFprobe

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 1 | Multimedia Engineer | [US-111](phase-1-foundation.md#us-111---monorepo-scaffold-with-enforced-architecture-rules) | Sequential after US-111 (same sprint; contract-first stubs allowed) |

**User story:** As the system, I want accurate technical metadata for every uploaded file, so that later processing decisions are correct.

**Technical tasks**

- [ ] `US-126-T1` Define the IMediaProbe port in packages/media-core and an FFprobe adapter using argument arrays, never shell strings
- [ ] `US-126-T2` Map output to VideoAsset, AudioAsset and ImageAsset (codec, resolution, rotation, frame rate, variable frame rate flag, duration, color space, audio channels and sample rate)
- [ ] `US-126-T3` Persist metadata and expose it through the media API
- [ ] `US-126-T4` `TEST` Unit tests with recorded FFprobe JSON for every fixture including rotated and variable-frame-rate video

**Acceptance criteria**

- [ ] AC1. Metadata for every fixture matches the expected values, including rotation-corrected resolution
- [ ] AC2. FFprobe runs with a timeout and failures are reported, not thrown as unhandled errors

##### US-127 - Media validation and hostile-file defense

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 2 | Multimedia Engineer | [US-126](phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe), [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) | Sequential after US-129 (same sprint; contract-first stubs allowed) |

**User story:** As the platform, I want every upload validated before processing, so that corrupt or malicious media cannot crash or compromise workers.

**Technical tasks**

- [ ] `US-127-T1` Validate by magic bytes and probed container/codec against an allow-list, not by file extension
- [ ] `US-127-T2` Enforce limits on duration, resolution, stream count, file size and bitrate from configuration
- [ ] `US-127-T3` `SECURITY` Restrict FFmpeg/FFprobe protocols (protocol_whitelist file,pipe) to block SSRF via playlists and remote references
- [ ] `US-127-T4` `SECURITY` Run probe and a short decode test under CPU, memory and time limits
- [ ] `US-127-T5` Record structured rejection reasons for the user
- [ ] `US-127-T6` `TEST` Hostile fixture suite - truncated file, disguised extension, huge resolution header, HLS playlist with remote URLs, zero-length file

**Acceptance criteria**

- [ ] AC1. Every hostile fixture is rejected with a specific reason and no worker crash
- [ ] AC2. A playlist referencing an external URL causes no outbound network request

##### US-128 - Proxy, audio extraction and thumbnail generation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 2 | Multimedia Engineer | [US-126](phase-1-foundation.md#us-126---media-metadata-extraction-with-ffprobe), [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) | Sequential after US-129 (same sprint; contract-first stubs allowed) |

**User story:** As the system, I want lightweight derived media for every upload, so that analysis and preview are fast.

**Technical tasks**

- [ ] `US-128-T1` Generate a 540p constant-frame-rate H.264 proxy with a short keyframe interval for scrubbing
- [ ] `US-128-T2` Extract 16 kHz mono WAV for ASR and a full-quality audio stream for mixing
- [ ] `US-128-T3` Generate poster thumbnails and hover-scrub sprite sheets
- [ ] `US-128-T4` Store outputs as DerivedAsset records linked to the source with the generating parameters
- [ ] `US-128-T5` `TEST` Integration tests verifying duration parity (within one frame) between source, proxy and audio

**Acceptance criteria**

- [ ] AC1. Proxy and audio durations match the source within one frame
- [ ] AC2. Re-running the job for the same source and parameters reuses existing outputs

### EP-05 - Asynchronous Job Processing

**Epic goal:** Run every expensive operation asynchronously with observable, recoverable job states.

#### FT-05.1 - Job Queue and Worker Runtime

##### US-129 - Job queue abstraction with job state machine

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 2 | Backend Engineer | [US-114](phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration) | Parallel - can start on day 1 of the sprint |

**User story:** As the platform, I want a queue abstraction with explicit job states, retries and cancellation, so that long media operations never block API requests.

**Technical tasks**

- [ ] `US-129-T1` Define the IJobQueue port and Job aggregate with states Queued, Running, Completed, Failed, Retrying and Cancelled and legal transitions
- [ ] `US-129-T2` Implement the BullMQ adapter for Node workers and the bullmq Python client adapter for ai-worker with a shared JSON Schema job envelope
- [ ] `US-129-T3` Add retries with exponential backoff, idempotency keys, per-job timeouts, dead-letter handling and cancellation
- [ ] `US-129-T4` Persist job history in Postgres for audit and UI
- [ ] `US-129-T5` `TEST` Contract tests proving TS producers and Python consumers agree on the envelope; state-machine unit tests

**Acceptance criteria**

- [ ] AC1. Illegal state transitions are rejected by the domain model
- [ ] AC2. A job cancelled while running stops within 5 seconds and ends in Cancelled
- [ ] AC3. A transient failure retries with backoff and ends in Completed; a permanent failure ends in Failed with a reason

##### US-130 - Real-time job progress events

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 2 | Generative Video / Remotion Engineer | [US-129](phase-1-foundation.md#us-129---job-queue-abstraction-with-job-state-machine) | Sequential after US-129 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to see live progress for processing jobs, so that I know what the system is doing.

**Technical tasks**

- [ ] `US-130-T1` Publish job progress and state-change domain events through Redis pub/sub (Observer pattern)
- [ ] `US-130-T2` Expose an authenticated Server-Sent Events endpoint per project
- [ ] `US-130-T3` Throttle progress events and include job type, percentage and stage
- [ ] `US-130-T4` `TEST` Integration test asserting ordered events for a sample job

**Acceptance criteria**

- [ ] AC1. Progress updates reach a subscribed client within one second of the worker reporting them
- [ ] AC2. A user receives events only for projects they can access

##### US-131 - Job progress and status UI

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 2 | Frontend Engineer | [US-130](phase-1-foundation.md#us-130---real-time-job-progress-events) | Sequential after US-130 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want progress bars and status badges on my media, so that I can wait with confidence or retry failures.

**Technical tasks**

- [ ] `US-131-T1` Subscribe to the SSE stream and update media cards in real time
- [ ] `US-131-T2` Show stage names, percentage and error messages with a retry action
- [ ] `US-131-T3` `TEST` Component tests with a mocked event stream

**Acceptance criteria**

- [ ] AC1. Progress updates without page reload
- [ ] AC2. Failed jobs show the reason and a retry button that re-enqueues the job

## 7. Dependencies

### Phase-level

- No upstream phase; this phase starts the project.
- External - reference GPU machine (or cloud GPU budget) and at least one LLM provider API key must be available by the start of Sprint 1 for the spikes (US-105, US-107).
- External - supervisor availability for SRS sign-off at the Sprint 1 review.
- Internal - US-129 (job queue) is the integration point for every worker built in later phases; it is on the critical path.
- Unblocks [PH2](phase-2-perception-editing-core.md) Perception Engine and Editing Core.

### Cross-phase story dependencies (inputs from earlier phases)

None.

### Same-sprint sequencing (everything else in a sprint runs in parallel)

- Sprint 1: US-102 -> US-104 Initial domain model and ER design
- Sprint 1: US-103 -> US-108 Risk register and threat model v0
- Sprint 1: US-103 -> US-111 Monorepo scaffold with enforced architecture rules
- Sprint 1: US-111 -> US-112 CI pipeline baseline with required checks
- Sprint 1: US-111 -> US-114 Docker Compose environment with typed configuration
- Sprint 2: US-116 -> US-117 Walking-skeleton end-to-end test in CI
- Sprint 2: US-118 -> US-119 Sign-up, sign-in and session handling in the web app
- Sprint 1: US-104 -> US-120 Project CRUD API
- Sprint 1: US-111 -> US-121 Web application shell and project dashboard
- Sprint 1: US-120 -> US-122 Object storage port and direct upload
- Sprint 1: US-121 -> US-124 Upload and media details page
- Sprint 2: US-128 -> US-125 Media library with thumbnails and proxy playback
- Sprint 1: US-111 -> US-126 Media metadata extraction with FFprobe
- Sprint 2: US-129 -> US-127 Media validation and hostile-file defense
- Sprint 2: US-129 -> US-128 Proxy, audio extraction and thumbnail generation
- Sprint 2: US-129 -> US-130 Real-time job progress events
- Sprint 2: US-130 -> US-131 Job progress and status UI

## 8. Sprint allocation

| Sprint | Sprint goal | Stories | SP | AI | MM | GEN | BE | FE | OPS | ALL |
|---|---|---|---|---|---|---|---|---|---|---|
| [Sprint 1](../sprints.md#sprint-1) | Baseline requirements and architecture, and prove every layer end-to-end with a walking skeleton that stores an uploaded video and shows its FFprobe metadata. | US-101, US-102, US-103, US-104, US-105, US-106, US-107, US-108, US-109, US-111, US-112, US-114, US-120, US-121, US-122, US-124, US-126 | 50 | 5 | 3 | 2 | 12 | 5 | 15 | 8 |
| [Sprint 2](../sprints.md#sprint-2) | Make ingestion production-grade - authenticated users upload large files resumably, and asynchronous jobs validate, proxy and thumbnail the media with live progress. | US-110, US-113, US-115, US-116, US-117, US-118, US-119, US-123, US-125, US-127, US-128, US-129, US-130, US-131 | 48 | 3 | 10 | 3 | 10 | 11 | 11 | 0 |

## 9. Deliverables

- Software Requirements Specification v1.0, use case diagram, user journeys and glossary
- C4 architecture diagrams, ADR set, domain model and ER diagram
- Technology evaluation report and risk register with threat model v0
- Product backlog in the team tracker (imported from export/jira-import.csv)
- Monorepo with lint, format, type checks, pre-commit hooks and architecture dependency rules
- CI pipeline (tests, coverage, scanning, SBOM, image build) and CD to staging
- Docker Compose environment with typed configuration
- Authentication, projects, resumable upload, media validation, proxy/audio/thumbnail generation
- Job queue with the full job state machine and live progress in the web app
- Evaluation dataset of licensed videos

## 10. Definition of Done

The phase is done when all of the following hold (in addition to the story-level DoD for every story):

- [ ] SRS v1.0 and ADRs merged to main via reviewed pull requests and signed off by the supervisor
- [ ] A new developer can clone the repository and reach a running system with one documented command in under 30 minutes
- [ ] CI runs lint, type checks, unit and integration tests, dependency/secret/image scanning and blocks merges on failure
- [ ] main is continuously deployed to staging and the v0.1 release is tagged
- [ ] Upload, validation, proxy and thumbnail flows are covered by unit, integration and one E2E test
- [ ] Hostile-input tests (malformed containers, disguised extensions, oversized files, path traversal names) pass
- [ ] Logs carry a correlation ID from HTTP request through the queue to the worker
- [ ] Domain packages have no imports from infrastructure frameworks (enforced by lint rule)

### Milestone exit criteria

**M0 - Architecture Baseline and Walking Skeleton** (end of Sprint 1)

- [ ] SRS v1.0 and MVP boundary signed off by the supervisor
- [ ] ADRs accepted for architecture style, languages, contracts, queue, storage, LLM abstraction and branching
- [ ] Walking skeleton upload-to-metadata flow works from a fresh clone and CI is required on main

**CP1 - Technology Feasibility** (end of Sprint 1)

- [ ] Faster-Whisper transcribes 10 minutes of speech in at most 3 minutes on the reference GPU, or a CPU-viable model is selected
- [ ] Remotion renders 60 seconds of 1080p with captions in at most 5 minutes on the reference machine
- [ ] The chosen LLM returns schema-valid tool calls for at least 9 of 10 scripted editing requests

**M1 - v0.1 Ingest** (end of Sprint 2)

- [ ] Authenticated resumable upload, validation, proxy and thumbnail jobs work on staging
- [ ] Every job exposes Queued, Running, Completed, Failed, Retrying and Cancelled states
- [ ] CD deploys main to staging automatically
