# Bounded modules and ownership

This document is the normative module map for EditAgent. [Architecture overview](README.md) explains how the modules sit in the system. The lookup table at the bottom assigns every planned roadmap story to exactly one module.

Lane ownership in the roadmap (AI, MM, GEN, BE, FE, OPS) is the primary engineering lane. It is not the bounded module. A story can be implemented by one lane and still belong to exactly one module.

## Ownership rules

Apply these rules in order. The story lookup table is the result, and it is the source of truth when a story is read on its own.

1. **Capability.** If a story adds or changes one module's data, public interface, or user-facing behavior, that module owns the story.
2. **Governance.** If a story is a product or engineering agreement for the whole system (requirements, glossary, architecture baseline, initial cross-aggregate model, risk register, working agreements, repository structure, release, or whole-system documentation), **Projects** owns it. Projects is accountable for the agreement. It does not become the code owner of the other modules.
3. **Runtime.** If a story is about how the system is built, deployed, observed, or executed as a platform (CI/CD, composition environment, logging and health baseline, the shared test harness, end-to-end pipeline gates, performance budgets of the running system, deployment docs), **Jobs** owns it.

Every story matches exactly one row below. There is no shared owner and no "platform" module outside the twelve.

## Module responsibilities

Each module owns the responsibilities in its section and does not own the responsibilities in the other sections.

### Identity

Owns user accounts, credentials, sessions, and the roles Owner, Editor, Viewer, and Admin. Owns the allow or deny decision for an action on a protected resource. Owns the sign-in experience and the security-assurance suite that evidences access control.

Does not own project records, media bytes, or job execution.

**Public interface**

- `authenticate`
- `establishSession` / `revokeSession`
- `authorize(principal, action, resource)`
- Types: `UserId`, `Role`, `Session`

**Code home:** `packages/domain/src/modules/identity/`. HTTP adapters land in the API under a later Identity story (US-118).

### Projects

Owns the Project aggregate, membership records, and project settings: platform preset, target duration, and brand kit. Owns the project dashboard, project wizard, and project-level overview of runs and renders. Owns governance stories under rule 2.

Does not authenticate users and does not own timeline contents.

**Public interface**

- `createProject`, `getProject`, `updateProject`, `archiveProject`, `listProjects`
- `updateProjectSettings`
- `getBrandKit`, `saveBrandKit`
- Types: `ProjectId`, `Project`, `BrandKit`

**Code home:** `packages/domain/src/modules/projects/`.

### Media

Owns `MediaAsset` and `DerivedAsset`, upload sessions, object-storage keys for source media, container validation, technical metadata, proxies, extracted audio, thumbnails, and the player used to watch an asset.

Does not own perception results, the timeline, or the asset library of stock media and fonts.

**Public interface**

- `beginUpload`, `completeUpload`
- `inspectMedia`, `validateMedia`
- `createDerivedAssets` (proxy, audio, thumbnails)
- `getPlayback`
- Types: `MediaAssetId`, `MediaAsset`, `DerivedAsset`

**Code home:** `packages/domain/src/modules/media/`. Preparation runs in `workers/media-worker`. Byte adapters live in `packages/media-core` and behind `IObjectStorage`.

### Analysis

Owns perception results for one media asset: transcript, voice activity, fillers and repetitions, silence and loudness, scenes, faces, active speaker, and semantic visual descriptions. Owns the `MediaAnalysis` contract and analysis cache identity.

Does not decide which edit to apply and does not execute FFmpeg edits.

**Public interface**

- `startAnalysis`, `getAnalysis`
- `getTranscript`, `getSpeechSegments`, `getScenes`, `getFaces`
- Types: `AnalysisId`, `MediaAnalysis`

**Code home:** `packages/domain/src/modules/analysis/`. Model adapters run in `workers/ai-worker`.

### Editing

Owns `Timeline`, `Track`, `Clip`, placed effects, edit commands, and undo/redo history. Owns workflows whose result is a new timeline: one-click silence removal, pacing, beat-synchronized cuts, keyword emphasis, and the timeline UI.

Does not own the tool catalog and does not own perception ranges. It consumes them.

**Public interface**

- `getTimeline`, `applyCommand`, `undo`, `redo`, `restoreVersion`
- Types: `Timeline`, `Track`, `Clip`, `EditCommand`

**Code home:** `packages/domain/src/modules/editing/`.

### Tools

Owns the tool catalog, manifests, argument schemas, permission checks, execution timeouts, the safe FFmpeg command builder, and the concrete tools the agent calls (range removal, reframing, the caption tool, audio tools, generated filter chains). Owns the plugin-authoring guide for tools.

Does not own the timeline that a tool's command mutates, and does not own the Remotion component that a caption tool displays.

**Public interface**

- `registerTool`, `getTool`, `validateToolCall`, `executeTool`
- Types: `ToolManifest`, `ToolCall`, `ToolResult`

**Code home:** `packages/tool-sdk/` plus `packages/domain/src/modules/tools/`. FFmpeg execution is hosted by `workers/media-worker` through `packages/media-core`.

### Agent

Owns model selection, the versioned prompt registry, `AgentRun`, context building, the observe-plan-act loop, creativity policy, creative memory, conversational revision, and the decision to execute untrusted code. Owns the sandbox port and controlled dependency installation used by that decision. Owns agent-facing run views.

Does not own tool implementations, component artifacts, or perception models.

**Public interface**

- `startRun`, `step`, `cancelRun`, `getRun`, `listEvents`
- `renderPrompt`
- `selectModel`
- Types: `AgentRun`, `AgentEvent`, `PromptId`

**Code home:** `packages/domain/src/modules/agent/` and `workers/agent-worker/`.

### Rendering

Owns render requests, preview and final profiles, strategy selection, timeline-to-composition mapping, render cache, and in-browser preview of a render.

Does not own component authoring and does not own the job state machine that schedules a render.

**Public interface**

- `requestRender`, `getRender`
- `selectStrategy`
- Types: `RenderRequest`, `RenderProfile`, `RenderOutput`

**Code home:** `packages/domain/src/modules/rendering/` and `workers/render-worker/`.

### Assets

Owns the local asset registry, fonts as registered assets, semantic search, starter packs, music selection, B-roll asset choice, external asset providers, quarantine, and license checks for acquired media and packages.

Does not own the timeline placement command and does not own generated Remotion components.

**Public interface**

- `registerAsset`, `searchAssets`, `getAsset`
- `quarantineAcquisition`, `promoteAsset`
- Types: `AssetId`, `Asset`, `FontId`

**Code home:** `packages/domain/src/modules/assets/`.

### Components

Owns Remotion component manifests, built-in packs (motion graphics, transitions, overlays, captions, zoom and punch-in), layout metadata emitted by components, generated component provenance, component acquisition, and the component gallery.

Does not own the agent loop that asks for a component and does not own the render worker process.

**Public interface**

- `registerComponent`, `resolveComponent`
- `recordGeneratedComponent`
- Types: `ComponentId`, `ComponentManifest`

**Code home:** `packages/domain/src/modules/components/`.

### Critic

Owns quality checks, critiques, refinement requests, evaluation datasets, metric definitions, evaluation harnesses, visual regression of renders, and human acceptance studies.

Does not own the render pipeline and does not own the agent loop. It returns a critique that the Agent or Editing module may act on.

**Public interface**

- `reviewRender`, `requestRefinement`
- `recordEvaluation`
- Types: `Critique`, `QualityReport`

**Code home:** `packages/domain/src/modules/critic/`.

### Jobs

Owns the `Job` aggregate, the queue port, the job state machine, progress events, and platform runtime stories under rule 3: CI/CD, the composition environment, process health, worker resource limits, deployment verification, and platform performance budgets. Owns orchestration of a parallel analysis DAG as job composition.

Does not own the domain result a job produces. The producing module owns that result.

**Public interface**

- `enqueue`, `getJob`, `transition`
- `publishProgress`, `subscribeProgress`
- Types: `JobId`, `Job`, `JobStatus`

**Code home:** `packages/domain/src/modules/jobs/`.

## Boundaries that would otherwise be ambiguous

These sentences are normative. They exist so two modules cannot both claim the same responsibility.

- The authorization **decision** belongs to Identity. The project **membership record** belongs to Projects.
- Silence **ranges** belong to Analysis. The timeline **cut** belongs to Editing. The FFmpeg **tool** that removes a range belongs to Tools.
- The caption **component** belongs to Components. The caption **tool** belongs to Tools. The **transcript** belongs to Analysis.
- Finding B-roll belongs to Assets. Placing it on the timeline belongs to Editing. Frame and overlay components belong to Components.
- The font **registry** belongs to Assets. Font **selection policy** belongs to Agent.
- The brand kit belongs to Projects. Components and Rendering read it.
- The decision to run untrusted code, and the sandbox port, belong to Agent. The generated component artifact belongs to Components.
- `IObjectStorage` is a shared port. Media owns source-media keys, Assets owns library keys, and Rendering owns output keys. The adapter implementation belongs to infrastructure, not to a module.
- Jobs owns the job. The module that performs the work owns the result.

## Where code lives

| Path | Role |
|---|---|
| `packages/domain/src/kernel/` | Shared kernel. Time representation (ADR-008). Modules may import the kernel. The kernel imports no module. |
| `packages/domain/src/modules/<module>/` | Domain model of that module. A module imports the kernel only, never another module. |
| `apps/web/` | Presentation process. No module domain code. |
| `apps/api/` | Composition root and synchronous use cases for the modular monolith. |
| `workers/agent-worker/` | Agent process. |
| `workers/ai-worker/` | Analysis adapter process (Python). |
| `workers/media-worker/` | Media preparation and Tools execution process. |
| `workers/render-worker/` | Rendering process. |
| `packages/tool-sdk/` | Tools plugin surface. |
| `packages/media-core/` | Infrastructure adapters for FFprobe and FFmpeg. |
| `packages/schemas/` | JSON Schema contracts (ADR-003). |
| `packages/shared/` | Cross-cutting utilities outside the domain. |
| `infra/` | Deployment manifests. Runtime composition is a later story. |

Workers are processes, not modules. `workers/media-worker` hosts Media preparation and Tools execution without merging those modules: each module keeps its own folder and public interface.

## Story lookup

Rule values are `capability`, `governance`, or `runtime`, as defined above. The owning module column is the only owner.

| Story | Title | Owning module | Rule |
|---|---|---|---|
| US-101 | Software Requirements Specification with measurable NFRs | Projects | governance |
| US-102 | Use cases, user journeys and domain glossary | Projects | governance |
| US-103 | Architecture baseline, module boundaries and ADRs | Projects | governance |
| US-104 | Initial domain model and ER design | Projects | governance |
| US-105 | ASR and VAD feasibility spike | Analysis | capability |
| US-106 | Rendering feasibility spike (FFmpeg vs Remotion) | Rendering | capability |
| US-107 | LLM tool-calling feasibility spike | Agent | capability |
| US-108 | Risk register and threat model v0 | Projects | governance |
| US-109 | Product backlog, board and team working agreements | Projects | governance |
| US-110 | Evaluation dataset collection and metric definitions | Critic | capability |
| US-111 | Monorepo scaffold with enforced architecture rules | Projects | governance |
| US-112 | CI pipeline baseline with required checks | Jobs | runtime |
| US-113 | Supply-chain security, image publishing and CD to staging | Jobs | runtime |
| US-114 | Docker Compose environment with typed configuration | Jobs | runtime |
| US-115 | Structured logging, health checks and error handling baseline | Jobs | runtime |
| US-116 | Test frameworks, fixtures and integration harness | Jobs | runtime |
| US-117 | Walking-skeleton end-to-end test in CI | Jobs | runtime |
| US-118 | Secure authentication and project-level authorization | Identity | capability |
| US-119 | Sign-up, sign-in and session handling in the web app | Identity | capability |
| US-120 | Project CRUD API | Projects | capability |
| US-121 | Web application shell and project dashboard | Projects | capability |
| US-122 | Object storage port and direct upload | Media | capability |
| US-123 | Resumable large-file upload | Media | capability |
| US-124 | Upload and media details page | Media | capability |
| US-125 | Media library with thumbnails and proxy playback | Media | capability |
| US-126 | Media metadata extraction with FFprobe | Media | capability |
| US-127 | Media validation and hostile-file defense | Media | capability |
| US-128 | Proxy, audio extraction and thumbnail generation | Media | capability |
| US-129 | Job queue abstraction with job state machine | Jobs | capability |
| US-130 | Real-time job progress events | Jobs | capability |
| US-131 | Job progress and status UI | Jobs | capability |
| US-201 | Word-level transcription with Faster-Whisper | Analysis | capability |
| US-202 | Voice activity detection and speech segmentation | Analysis | capability |
| US-203 | Filler-word and repetition detection | Analysis | capability |
| US-204 | Silence, loudness, peak and energy analysis | Analysis | capability |
| US-205 | Speech, music and noise classification | Analysis | capability |
| US-206 | Shot and scene boundary detection | Analysis | capability |
| US-207 | Face detection and tracking | Analysis | capability |
| US-208 | Versioned MediaAnalysis JSON Schema with generated bindings | Analysis | capability |
| US-209 | Worker integration test harness and GPU test strategy | Analysis | capability |
| US-210 | Analysis orchestration and aggregation | Analysis | capability |
| US-211 | Frame-accurate video player component | Media | capability |
| US-212 | Synchronized transcript viewer | Analysis | capability |
| US-213 | Analysis overview panels | Analysis | capability |
| US-214 | Timeline domain model and invariants | Editing | capability |
| US-215 | Edit commands with undo, redo and replayable history | Editing | capability |
| US-216 | Remotion render worker | Rendering | capability |
| US-217 | Timeline to Remotion composition mapping | Rendering | capability |
| US-218 | FFmpeg render strategy behind IRenderStrategy | Rendering | capability |
| US-219 | Tool manifest, registry and schema validation | Tools | capability |
| US-220 | Safe FFmpeg command builder | Tools | capability |
| US-221 | Tool executor with permissions, timeouts and remote dispatch | Tools | capability |
| US-222 | Core FFmpeg editing tools | Tools | capability |
| US-223 | One-click silence removal workflow | Editing | capability |
| US-224 | Silence removal action and result download in the web app | Editing | capability |
| US-225 | End-to-end test of the silence removal workflow | Editing | capability |
| US-301 | LLM provider port with capability descriptors and adapters | Agent | capability |
| US-302 | Versioned prompt registry | Agent | capability |
| US-303 | AgentRun lifecycle, agent worker and run API | Agent | capability |
| US-304 | Agent context builder with token budgeting | Agent | capability |
| US-305 | Observe-plan-act loop with validated tool calling | Agent | capability |
| US-306 | Agent event stream and audit trail API | Agent | capability |
| US-307 | Highlight selection and semantic cutting | Agent | capability |
| US-308 | Short-form generation for platform presets | Agent | capability |
| US-309 | Range removal tool for silences, fillers and repetitions | Tools | capability |
| US-310 | Auto-reframing to target aspect ratio | Tools | capability |
| US-311 | Zoom and punch-in effects | Components | capability |
| US-312 | Word-synchronized caption component | Components | capability |
| US-313 | Caption tool with segmentation, readability rules and safe zones | Tools | capability |
| US-314 | Audio normalization, music and ducking tools | Tools | capability |
| US-315 | Preview and final render profiles with output validation | Rendering | capability |
| US-316 | New project wizard with prompt, platform and duration | Projects | capability |
| US-317 | Live agent run view with result player and download | Agent | capability |
| US-318 | Project runs and renders overview | Projects | capability |
| US-319 | Tool permission model and injection test suite | Tools | capability |
| US-320 | Evaluation harness v0 | Critic | capability |
| US-321 | MVP end-to-end test in CI | Jobs | runtime |
| US-401 | Component manifest and plugin registry | Components | capability |
| US-402 | Motion graphics pack v1 | Components | capability |
| US-403 | Transitions pack | Components | capability |
| US-404 | Overlay, background and B-roll frame components | Components | capability |
| US-405 | Layout metadata emission for quality checks | Components | capability |
| US-406 | Font registry with metadata and validation | Assets | capability |
| US-407 | Agent font selection with glyph coverage checks | Agent | capability |
| US-408 | Font library and project font picker UI | Assets | capability |
| US-409 | Project creative memory | Agent | capability |
| US-410 | Creativity level policy enforcement | Agent | capability |
| US-411 | Unified local asset registry with starter packs | Assets | capability |
| US-412 | Semantic asset search | Assets | capability |
| US-413 | Basic B-roll insertion | Assets | capability |
| US-414 | Music selection from the registry | Assets | capability |
| US-415 | Revision mode for incremental natural-language edits | Agent | capability |
| US-416 | AI chat panel in the editing workspace | Agent | capability |
| US-417 | Version history with undo, redo and restore | Editing | capability |
| US-418 | In-browser preview with the Remotion Player | Rendering | capability |
| US-419 | Deterministic render quality checks | Critic | capability |
| US-420 | Frame sampling and contact sheets | Critic | capability |
| US-421 | Automatic single refinement pass | Critic | capability |
| US-422 | Hardened, resource-limited worker containers | Jobs | capability |
| US-423 | Analysis caching by media fingerprint | Analysis | capability |
| US-424 | Active speaker detection | Analysis | capability |
| US-425 | Visual regression testing for components and renders | Critic | capability |
| US-426 | MVP evaluation report and human acceptance pilot | Critic | capability |
| US-501 | Sandbox runtime for untrusted code | Agent | capability |
| US-502 | Controlled dependency installation through a registry mirror | Agent | capability |
| US-503 | Component generation pipeline (generate, check, compile, test render) | Components | capability |
| US-504 | Self-repair loop with visual verification | Components | capability |
| US-505 | Generated component registry with provenance | Components | capability |
| US-506 | Generated FFmpeg filter chains | Tools | capability |
| US-507 | Internet asset providers with quarantine download | Assets | capability |
| US-508 | License and provenance validation | Assets | capability |
| US-509 | Media and package security validation | Assets | capability |
| US-510 | Component acquisition from package registries | Components | capability |
| US-511 | Multimodal visual critique | Critic | capability |
| US-512 | Caption, audio and editing quality checks v1 | Critic | capability |
| US-513 | Iterative refinement loop controller | Critic | capability |
| US-514 | Hook detection and narrative restructuring | Agent | capability |
| US-515 | Keyword emphasis | Editing | capability |
| US-516 | Beat detection and beat-synchronized cutting | Editing | capability |
| US-517 | Mood detection and music matching | Assets | capability |
| US-518 | Pacing control | Editing | capability |
| US-519 | Semantic visual understanding for clip and B-roll selection | Analysis | capability |
| US-520 | Full Autonomous creativity level with approval gates | Agent | capability |
| US-521 | Brand kit model and application | Projects | capability |
| US-522 | Brand kit management UI | Projects | capability |
| US-523 | Multi-track timeline view | Editing | capability |
| US-524 | Asset library UI | Assets | capability |
| US-525 | Generated components gallery with approval | Components | capability |
| US-526 | Dashboard overview | Projects | capability |
| US-527 | Advanced reference resolution in conversational edits | Agent | capability |
| US-528 | Direct timeline manipulation | Editing | capability |
| US-601 | Security test suite and ASVS review | Identity | capability |
| US-602 | Prompt-injection and agent safety red-team | Agent | capability |
| US-603 | Sandbox and resource-exhaustion red-team | Agent | capability |
| US-604 | GPU inference and model pooling | Analysis | capability |
| US-605 | Parallel analysis DAG | Jobs | capability |
| US-606 | Performance benchmark suite and budgets | Jobs | runtime |
| US-607 | Incremental rendering and render caching | Rendering | capability |
| US-608 | Metrics, distributed tracing, dashboards and error tracking | Jobs | capability |
| US-609 | Agent run inspector | Agent | capability |
| US-610 | Plugin-only extension proof | Tools | capability |
| US-611 | Bug bash and stabilization | Projects | governance |
| US-612 | Tool SDK, component and provider authoring guide | Tools | capability |
| US-613 | Full evaluation run with ablations | Critic | capability |
| US-614 | Human acceptance study | Critic | capability |
| US-615 | Scripted evaluation scenarios A-G | Critic | capability |
| US-616 | Architecture and developer documentation with required diagrams | Projects | governance |
| US-617 | User manual and API documentation | Projects | governance |
| US-618 | Security, testing and deployment documentation | Jobs | runtime |
| US-619 | Fresh deployment verification and bootstrap script | Jobs | runtime |
| US-620 | Release freeze v1.0-graduation | Projects | governance |
| US-621 | Graduation demo preparation and rehearsal | Projects | governance |
