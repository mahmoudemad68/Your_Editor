<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# PH5 - Advanced Autonomy - Self-Expanding and Creative Editor

| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |
|---|---|---|---|---|---|
| Sprint 9, Sprint 10 | Weeks 17-20 | v0.95-beta "Feature Freeze" | advanced | 104 SP (23 stories, 5 stretch) | CP5 Sandbox Security Gate, M5 Feature Freeze - v0.95-beta |

[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | [Dependencies](../dependencies.md) | [Milestones](../milestones.md)

## 1. Objective

Move from an agent that executes editing commands to one that behaves like an autonomous editor. It safely extends its own environment - it generates new Remotion components, acquires missing assets and components from the internet through a license and security pipeline, and executes all untrusted code only in a sandbox. It critiques its renders with a multimodal critic and refines iteratively, and it makes editorial decisions (hook detection, narrative restructuring, keyword emphasis, beat-aware cutting, pacing). The workspace gains brand kits, a timeline view and Full Autonomous mode. Covers original Phases 9, 10, 11, 12 and the advanced parts of 8, 13 and 15.

## 2. Epics

| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |
|---|---|---|---|---|---|
| [EP-24](phase-5-advanced-autonomy.md#ep-24---secure-execution-sandbox) Secure Execution Sandbox | Execute any untrusted code (generated or downloaded) in an isolated, resource-limited environment with no host or network access. | S9 | 13 | [EP-23](phase-4-mvp-complete.md#ep-23---platform-hardening-and-pipeline-maturity) | [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement) |
| [EP-25](phase-5-advanced-autonomy.md#ep-25---autonomous-component-generation) Autonomous Component Generation | Let the agent create new visual capabilities when none exist, safely and reproducibly. | S9, S10 | 16 | [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system), [EP-24](phase-5-advanced-autonomy.md#ep-24---secure-execution-sandbox), [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0) | [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement) |
| [EP-26](phase-5-advanced-autonomy.md#ep-26---external-resource-acquisition) External Resource Acquisition | Search the internet for missing assets and components and integrate them only after license and security validation. | S9, S10 | 18 | [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-24](phase-5-advanced-autonomy.md#ep-24---secure-execution-sandbox), [EP-25](phase-5-advanced-autonomy.md#ep-25---autonomous-component-generation) | [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement), [EP-29](phase-5-advanced-autonomy.md#ep-29---workspace-and-brand-experience) |
| [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement) AI Critic and Self-Refinement | Evaluate renders like a human editor and iterate until quality stops improving. | S9, S10 | 13 | [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0), [EP-13](phase-3-agent-mvp-alpha.md#ep-13---llm-provider-layer) | [EP-24](phase-5-advanced-autonomy.md#ep-24---secure-execution-sandbox), [EP-25](phase-5-advanced-autonomy.md#ep-25---autonomous-component-generation), [EP-26](phase-5-advanced-autonomy.md#ep-26---external-resource-acquisition), [EP-28](phase-5-advanced-autonomy.md#ep-28---creative-intelligence), [EP-29](phase-5-advanced-autonomy.md#ep-29---workspace-and-brand-experience) |
| [EP-28](phase-5-advanced-autonomy.md#ep-28---creative-intelligence) Creative Intelligence | Make semantic and creative editorial decisions rather than only low-level processing. | S9, S10 | 22 | [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop), [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system), [EP-19](phase-4-mvp-complete.md#ep-19---fonts-and-design-system), [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0), [EP-25](phase-5-advanced-autonomy.md#ep-25---autonomous-component-generation), [EP-26](phase-5-advanced-autonomy.md#ep-26---external-resource-acquisition) | [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement), [EP-29](phase-5-advanced-autonomy.md#ep-29---workspace-and-brand-experience) |
| [EP-29](phase-5-advanced-autonomy.md#ep-29---workspace-and-brand-experience) Workspace and Brand Experience | Complete the editing workspace and brand management for daily use. | S9, S10 | 22 | [EP-19](phase-4-mvp-complete.md#ep-19---fonts-and-design-system), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview), [EP-16](phase-3-agent-mvp-alpha.md#ep-16---mvp-web-experience), [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-25](phase-5-advanced-autonomy.md#ep-25---autonomous-component-generation) | [EP-26](phase-5-advanced-autonomy.md#ep-26---external-resource-acquisition), [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement), [EP-28](phase-5-advanced-autonomy.md#ep-28---creative-intelligence) |

## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria

Task tags: `TEST`, `DOC`, `CI/CD`, `SECURITY`, `INTEGRATION` mark testing, documentation, CI/CD, security and integration work that is built into the story itself. Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).

### EP-24 - Secure Execution Sandbox

**Epic goal:** Execute any untrusted code (generated or downloaded) in an isolated, resource-limited environment with no host or network access.

#### FT-24.1 - Sandbox Runtime

##### US-501 - Sandbox runtime for untrusted code

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 8 | Sprint 9 | DevOps & QA (shared) | [US-422](phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want all generated and third-party code to run in a disposable sandbox, so that malicious or broken code can never reach the host, data or network.

**Technical tasks**

- [ ] `US-501-T1` Define the ISandbox port (run command, mount inputs read-only, collect outputs, limits) and a Docker adapter using rootless containers with the gVisor runsc runtime
- [ ] `US-501-T2` `SECURITY` Enforce no network by default, CPU, memory, pid, disk and wall-clock limits, read-only root, dropped capabilities and a fresh filesystem per execution
- [ ] `US-501-T3` Provide a pre-built sandbox image with Node, the Remotion toolchain and headless Chromium
- [ ] `US-501-T4` `SECURITY` Escape test suite - host file access, Docker socket access, metadata endpoint access, fork and memory bombs, infinite loops
- [ ] `US-501-T5` `CI/CD` Run the sandbox security suite on every change to sandbox code and nightly
- [ ] `US-501-T6` `DOC` Document the sandbox threat model and limits

**Acceptance criteria**

- [ ] AC1. Every escape and exhaustion test fails safely and is reported, with the host unaffected
- [ ] AC2. Outputs are only available through the declared output directory
- [ ] AC3. A sandbox run leaves no residual container or files after completion

#### FT-24.2 - Controlled Dependency Installation

##### US-502 - Controlled dependency installation through a registry mirror

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 9 | Backend Engineer | [US-501](phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code) | Sequential after US-501 (same sprint; contract-first stubs allowed) |

**User story:** As the platform, I want packages installed only inside the sandbox from a controlled mirror with pinned integrity, so that dependency attacks are blocked.

**Technical tasks**

- [ ] `US-502-T1` Run a Verdaccio mirror as the only reachable registry from the install sandbox
- [ ] `US-502-T2` `SECURITY` Install with lockfiles, integrity hashes and install scripts disabled; pin exact versions
- [ ] `US-502-T3` Cache approved packages by hash for reuse
- [ ] `US-502-T4` `TEST` Tests proving a package with an install script does not execute it and a tampered tarball is rejected

**Acceptance criteria**

- [ ] AC1. Installation cannot reach any host except the mirror
- [ ] AC2. A hash mismatch aborts installation

### EP-25 - Autonomous Component Generation

**Epic goal:** Let the agent create new visual capabilities when none exist, safely and reproducibly.

#### FT-25.1 - Generation Pipeline

##### US-503 - Component generation pipeline (generate, check, compile, test render)

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 8 | Sprint 9 | Generative Video / Remotion Engineer | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry), [US-501](phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code) | Sequential after US-501 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to ask for an effect such as "a holographic glitch title" and have the AI build it, so that I am not limited to the built-in library.

**Technical tasks**

- [ ] `US-503-T1` Add a create_component tool - the LLM writes a TSX component from a strict template (zod props schema, frame-driven animation, allowed libraries react, remotion, @remotion/*, three)
- [ ] `US-503-T2` `SECURITY` Static analysis with an AST allow-list - no network, eval, Function, process, filesystem, dynamic import or timers; seeded randomness only
- [ ] `US-503-T3` Compile and bundle inside the sandbox, then test-render sample frames and a short clip inside the sandbox
- [ ] `US-503-T4` Develop against the ISandbox port so work proceeds in parallel with US-501
- [ ] `US-503-T5` `TEST` Tests with safe and deliberately malicious generated code

**Acceptance criteria**

- [ ] AC1. A request for a holographic glitch title produces a component that renders in the sandbox and is used in the edit
- [ ] AC2. Code containing banned APIs is rejected before compilation

##### US-504 - Self-repair loop with visual verification

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 10 | Generative Video / Remotion Engineer | [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets), [US-503](phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want to fix my generated component when it fails to compile, crashes or looks wrong, so that generated capabilities become reliable.

**Technical tasks**

- [ ] `US-504-T1` Feed compiler errors, runtime errors and rendered frames back to the model with the original specification
- [ ] `US-504-T2` Ask the vision model to compare rendered frames with the requested effect and return structured defects
- [ ] `US-504-T3` Limit attempts (default 3) and record each attempt in the audit trail
- [ ] `US-504-T4` `TEST` Tests with a component that initially fails to compile and is repaired

**Acceptance criteria**

- [ ] AC1. At least 70 percent of the generation test prompts produce a passing component within 3 attempts
- [ ] AC2. Every attempt, error and fix is visible in the audit trail

#### FT-25.2 - Generated Component Registry

##### US-505 - Generated component registry with provenance

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Backend Engineer | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry), [US-503](phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want successful generated components saved with previews and tests, so that I can reuse them in later projects.

**Technical tasks**

- [ ] `US-505-T1` Store name, version, dependencies, props schema, preview (GIF or MP4 and thumbnail), test results and creation source (prompt, model, prompt version)
- [ ] `US-505-T2` Register approved components in the component registry with trust level generated
- [ ] `US-505-T3` `TEST` Tests for versioning and reuse across projects

**Acceptance criteria**

- [ ] AC1. A generated component can be reused in another project without regeneration
- [ ] AC2. Every generated component shows its creation prompt and model

##### US-506 - Generated FFmpeg filter chains

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P3 - Stretch | 5 | Stretch | Multimedia Engineer | [US-220](phase-2-perception-editing-core.md#us-220---safe-ffmpeg-command-builder), [US-501](phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code) | Stretch backlog |

**User story:** As the agent, I want to compose new FFmpeg filter chains for effects that no tool provides, so that low-level video effects can also be created on demand.

**Technical tasks**

- [ ] `US-506-T1` Let the model propose filter graphs as structured data validated against an allow-list of filters and parameter ranges
- [ ] `US-506-T2` Execute in the sandbox on a short sample and inspect output frames
- [ ] `US-506-T3` `TEST` Tests rejecting disallowed filters and protocols

**Acceptance criteria**

- [ ] AC1. Only allow-listed filters can be used
- [ ] AC2. The generated effect is stored as a reusable tool manifest

### EP-26 - External Resource Acquisition

**Epic goal:** Search the internet for missing assets and components and integrate them only after license and security validation.

#### FT-26.1 - Asset Providers

##### US-507 - Internet asset providers with quarantine download

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 9 | Backend Engineer | [US-411](phase-4-mvp-complete.md#us-411---unified-local-asset-registry-with-starter-packs) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want to search stock providers when the local library has no match, so that I can still find suitable B-roll, music and sound effects.

**Technical tasks**

- [ ] `US-507-T1` Implement IAssetProvider adapters for stock video/image and sound providers with normalized results including license
- [ ] `US-507-T2` Apply the search hierarchy local, then internet, then generation (Chain of Responsibility)
- [ ] `US-507-T3` Download candidates into a quarantine bucket, never directly into the library
- [ ] `US-507-T4` `SECURITY` Egress only to allow-listed provider domains through a proxy
- [ ] `US-507-T5` `TEST` Contract tests with recorded provider responses

**Acceptance criteria**

- [ ] AC1. When local search has no match, internet results are returned with license data
- [ ] AC2. Downloaded files stay in quarantine until validation passes

#### FT-26.2 - Validation Pipeline

##### US-508 - License and provenance validation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Backend Engineer | [US-507](phase-5-advanced-autonomy.md#us-507---internet-asset-providers-with-quarantine-download) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want the AI to use only assets I am allowed to publish, so that my videos are legally safe.

**Technical tasks**

- [ ] `US-508-T1` Define a license allow-list policy (CC0, provider licenses, CC-BY with attribution) and block unknown licenses
- [ ] `US-508-T2` Record provenance (source URL, author, license, retrieval date, hash) and generate a credits list per project
- [ ] `US-508-T3` `TEST` Tests for allowed, attribution-required and blocked licenses

**Acceptance criteria**

- [ ] AC1. Assets with unknown or disallowed licenses are never promoted from quarantine
- [ ] AC2. Projects using attribution-required assets list credits automatically

##### US-509 - Media and package security validation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 10 | DevOps & QA (shared) | [US-502](phase-5-advanced-autonomy.md#us-502---controlled-dependency-installation-through-a-registry-mirror), [US-507](phase-5-advanced-autonomy.md#us-507---internet-asset-providers-with-quarantine-download) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want every downloaded file and package scanned and sanitized, so that malware and vulnerable dependencies cannot enter the system.

**Technical tasks**

- [ ] `US-509-T1` `SECURITY` Scan downloads with ClamAV and re-encode media through the validation pipeline to strip hostile structures and metadata
- [ ] `US-509-T2` `SECURITY` Check packages for known vulnerabilities (OSV), typosquatting, age, download counts, maintainer changes and install scripts
- [ ] `US-509-T3` `SECURITY` Verify hashes and signatures where available and record results
- [ ] `US-509-T4` `TEST` Tests with the EICAR file, a known-vulnerable package version and a typosquatted name

**Acceptance criteria**

- [ ] AC1. EICAR, the vulnerable version and the typosquat are all rejected with reasons
- [ ] AC2. Validation results are stored with the asset or package record

#### FT-26.3 - External Component Acquisition

##### US-510 - Component acquisition from package registries

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 10 | Generative Video / Remotion Engineer | [US-502](phase-5-advanced-autonomy.md#us-502---controlled-dependency-installation-through-a-registry-mirror), [US-505](phase-5-advanced-autonomy.md#us-505---generated-component-registry-with-provenance), [US-509](phase-5-advanced-autonomy.md#us-509---media-and-package-security-validation) | Sequential after US-505, US-509 (same sprint; contract-first stubs allowed) |

**User story:** As the agent, I want to find, validate, install and test an external component when I need one that does not exist locally, so that I can expand my toolbox safely (Scenario D).

**Technical tasks**

- [ ] `US-510-T1` Search the registry for Remotion or React animation packages matching the need and rank candidates
- [ ] `US-510-T2` Run license, reputation and vulnerability checks, then install in the sandbox from the mirror
- [ ] `US-510-T3` Generate an adapter component with a props schema wrapping the package and test-render it in the sandbox
- [ ] `US-510-T4` Register it with trust level external and record the full acquisition trail
- [ ] `US-510-T5` `TEST` Scenario test with a small known-good package and a rejected one
- [ ] `US-510-T6` `DOC` Write the acquisition pipeline guide (search, validation stages, trust levels, approval)

**Acceptance criteria**

- [ ] AC1. The Scenario D flow (need, search, validate, sandbox install, test render, register, use) completes on staging
- [ ] AC2. A package failing any check is never installed

### EP-27 - AI Critic and Self-Refinement

**Epic goal:** Evaluate renders like a human editor and iterate until quality stops improving.

#### FT-27.1 - Multimodal Critique

##### US-511 - Multimodal visual critique

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 10 | AI / Agent Engineer | [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters), [US-419](phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks), [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want a vision model to review contact sheets and key frames against an editing rubric, so that composition problems that rules cannot catch are found.

**Technical tasks**

- [ ] `US-511-T1` Define the critic rubric (composition, cropping, face obstruction, object overlap, text legibility, visual consistency) as a versioned prompt
- [ ] `US-511-T2` Send contact sheets with layout metadata to IVisionModel and parse structured issues into the QualityReport
- [ ] `US-511-T3` Compute a weighted quality score combining deterministic and model findings
- [ ] `US-511-T4` `TEST` Evaluation on renders with labelled defects (precision and recall per issue type)

**Acceptance criteria**

- [ ] AC1. Critic precision is at least 0.7 on labelled defects
- [ ] AC2. Model findings and deterministic findings appear in one QualityReport

##### US-512 - Caption, audio and editing quality checks v1

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 9 | Multimedia Engineer | [US-419](phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks) | Parallel - can start on day 1 of the sprint |

**User story:** As the critic, I want checks for spelling, contrast, abrupt audio cuts, pacing, dead air and jump cuts, so that the review covers caption, audio and editing quality.

**Technical tasks**

- [ ] `US-512-T1` Caption checks - spelling against transcript and dictionary per language, contrast ratio against sampled background, line length and position
- [ ] `US-512-T2` Audio checks - clipping, abrupt level changes at cuts, speech clarity estimate, background noise level
- [ ] `US-512-T3` Editing checks - average shot length, dead air, jump cuts without cover, continuity at cut points
- [ ] `US-512-T4` `TEST` Fixture tests with injected defects for each check

**Acceptance criteria**

- [ ] AC1. Each injected defect is reported with type, severity and time range
- [ ] AC2. Every check has a configurable threshold documented in the critic guide

#### FT-27.2 - Iterative Refinement

##### US-513 - Iterative refinement loop controller

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | AI / Agent Engineer | [US-421](phase-4-mvp-complete.md#us-421---automatic-single-refinement-pass), [US-511](phase-5-advanced-autonomy.md#us-511---multimodal-visual-critique) | Sequential after US-511 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want the AI to render, critique, fix and re-render until the result is good, so that I get the best version without manual review cycles (Scenario F).

**Technical tasks**

- [ ] `US-513-T1` Generalize the single pass into a loop with a maximum iteration count, minimum score improvement and cost limit
- [ ] `US-513-T2` Prevent regressions - reject fixes that introduce new higher-severity issues and roll back
- [ ] `US-513-T3` Record every iteration's report, fixes and score in the audit trail
- [ ] `US-513-T4` `TEST` Tests for improvement, plateau stop, regression rollback and limit enforcement
- [ ] `US-513-T5` `DOC` Write the critic guide (checks, thresholds, rubric, scoring and loop limits)

**Acceptance criteria**

- [ ] AC1. The loop stops when the score stops improving or limits are reached, whichever comes first
- [ ] AC2. A fix that makes the score worse is rolled back

### EP-28 - Creative Intelligence

**Epic goal:** Make semantic and creative editorial decisions rather than only low-level processing.

#### FT-28.1 - Narrative Structure

##### US-514 - Hook detection and narrative restructuring

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 8 | Sprint 9 | AI / Agent Engineer | [US-307](phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want the AI to open with the strongest hook and structure the video as Hook, Context, Value and Payoff, so that viewers keep watching.

**Technical tasks**

- [ ] `US-514-T1` Score hook candidates using LLM judgment, prosodic energy and keyword salience
- [ ] `US-514-T2` Classify segments into Hook, Context, Value and Payoff roles
- [ ] `US-514-T3` Allow non-chronological ordering with coherence checks (no dangling references such as "as I said")
- [ ] `US-514-T4` `TEST` Evaluation against human-edited references and a coherence test set

**Acceptance criteria**

- [ ] AC1. The chosen hook matches a human-selected hook in at least 50 percent of evaluation videos
- [ ] AC2. Restructured edits pass the coherence checks

#### FT-28.2 - Emphasis, Rhythm and Pacing

##### US-515 - Keyword emphasis

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Multimedia Engineer | [US-402](phase-4-mvp-complete.md#us-402---motion-graphics-pack-v1), [US-409](phase-4-mvp-complete.md#us-409---project-creative-memory) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want important words emphasized with animated text and zooms, so that key messages stand out.

**Technical tasks**

- [ ] `US-515-T1` Select keywords using the LLM plus term salience and respect a maximum emphasis density
- [ ] `US-515-T2` Apply KeywordPop and zoom consistently with creative memory (font role, intensity)
- [ ] `US-515-T3` `TEST` Tests for density limits and consistency

**Acceptance criteria**

- [ ] AC1. Emphasis density never exceeds the configured maximum per 10 seconds
- [ ] AC2. Emphasis style is identical across the video

##### US-516 - Beat detection and beat-synchronized cutting

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 9 | Multimedia Engineer | [US-414](phase-4-mvp-complete.md#us-414---music-selection-from-the-registry) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want cuts and transitions to land on the music beat, so that the edit feels rhythmic.

**Technical tasks**

- [ ] `US-516-T1` Detect tempo, beats and downbeats (librosa or madmom) and store them with music assets
- [ ] `US-516-T2` Snap cut and transition times to nearby beats within a tolerance that never cuts inside a word
- [ ] `US-516-T3` `TEST` Tests measuring cut-to-beat offset on fixtures

**Acceptance criteria**

- [ ] AC1. At least 80 percent of eligible cuts fall within 60 ms of a beat
- [ ] AC2. No snapped cut truncates a word

##### US-517 - Mood detection and music matching

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P2 - Could (advanced) | 3 | Stretch | Multimedia Engineer | [US-414](phase-4-mvp-complete.md#us-414---music-selection-from-the-registry) | Stretch backlog |

**User story:** As a creator, I want music chosen to match the emotional tone of my content, so that the soundtrack supports the message.

**Technical tasks**

- [ ] `US-517-T1` Estimate mood from transcript sentiment and vocal energy per section
- [ ] `US-517-T2` Match music by mood tags, BPM and energy curve
- [ ] `US-517-T3` `TEST` Tests on labelled mood clips

**Acceptance criteria**

- [ ] AC1. Mood labels agree with human labels on at least 70 percent of sections
- [ ] AC2. Music selection uses the detected mood when the prompt does not specify one

##### US-518 - Pacing control

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Multimedia Engineer | [US-307](phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting), [US-516](phase-5-advanced-autonomy.md#us-516---beat-detection-and-beat-synchronized-cutting) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to ask for faster or calmer editing in specific parts, so that the rhythm matches my intent (for example "make it faster after the hook").

**Technical tasks**

- [ ] `US-518-T1` Define pacing parameters per section (target shot length, pause tolerance, zoom frequency)
- [ ] `US-518-T2` Expose set_pacing as a tool usable in initial runs and revisions
- [ ] `US-518-T3` `TEST` Tests measuring average shot length before and after a pacing change

**Acceptance criteria**

- [ ] AC1. Requesting faster pacing reduces the average shot length of the targeted section by at least 20 percent
- [ ] AC2. Pacing changes affect only the targeted section

##### US-519 - Semantic visual understanding for clip and B-roll selection

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P2 - Could (advanced) | 5 | Stretch | AI / Agent Engineer | [US-413](phase-4-mvp-complete.md#us-413---basic-b-roll-insertion), [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) | Stretch backlog |

**User story:** As the agent, I want captions of what is visible in each shot, so that I select clips and B-roll by visual meaning as well as by words.

**Technical tasks**

- [ ] `US-519-T1` Caption keyframes with a vision model and add object detection (YOLO) results to MediaAnalysis
- [ ] `US-519-T2` Use visual captions in highlight scoring and B-roll matching
- [ ] `US-519-T3` `TEST` Tests comparing selection quality with and without visual captions

**Acceptance criteria**

- [ ] AC1. Visual captions are stored in MediaAnalysis with provenance
- [ ] AC2. B-roll relevance improves on the labelled query set

#### FT-28.3 - Full Autonomous Mode

##### US-520 - Full Autonomous creativity level with approval gates

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | AI / Agent Engineer | [US-410](phase-4-mvp-complete.md#us-410---creativity-level-policy-enforcement), [US-503](phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render), [US-507](phase-5-advanced-autonomy.md#us-507---internet-asset-providers-with-quarantine-download) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want a Full Autonomous mode where the AI may restructure, search, acquire and generate on its own, so that I can hand over the whole edit while keeping control of risky actions.

**Technical tasks**

- [ ] `US-520-T1` Extend the creativity policy with acquisition and generation capabilities and a budget per run
- [ ] `US-520-T2` Add optional approval gates (install external package, spend above budget) that pause the run for user confirmation
- [ ] `US-520-T3` `TEST` Tests proving gates pause the run and that lower levels cannot use Full Autonomous tools

**Acceptance criteria**

- [ ] AC1. In Full Autonomous mode the agent can acquire and generate components within budget
- [ ] AC2. With approval gates enabled, no external package is installed without user confirmation

### EP-29 - Workspace and Brand Experience

**Epic goal:** Complete the editing workspace and brand management for daily use.

#### FT-29.1 - Brand Kits

##### US-521 - Brand kit model and application

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 10 | Backend Engineer | [US-406](phase-4-mvp-complete.md#us-406---font-registry-with-metadata-and-validation), [US-409](phase-4-mvp-complete.md#us-409---project-creative-memory) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator with a brand, I want to define fonts, logo, colors, caption style and watermark once, so that every video matches my visual identity.

**Technical tasks**

- [ ] `US-521-T1` Model BrandKit (fonts per role, logo, palette, caption style, lower-third style, watermark, intro and outro) and attach it to projects
- [ ] `US-521-T2` Seed creative memory from the brand kit and pass brand tokens to components
- [ ] `US-521-T3` `SECURITY` Validate uploaded logos through the media validation pipeline
- [ ] `US-521-T4` `TEST` Tests proving brand tokens reach components and memory

**Acceptance criteria**

- [ ] AC1. A project with a brand kit uses its fonts, colors and watermark in the render
- [ ] AC2. Changing the brand kit updates new versions, not existing ones

##### US-522 - Brand kit management UI

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Frontend Engineer | [US-521](phase-5-advanced-autonomy.md#us-521---brand-kit-model-and-application) | Sequential after US-521 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to create and edit brand kits visually, so that I can set up my identity without technical knowledge.

**Technical tasks**

- [ ] `US-522-T1` Build brand kit editor with live preview of captions and lower thirds
- [ ] `US-522-T2` Select a brand kit in the new-project wizard
- [ ] `US-522-T3` `TEST` Component tests for editing and selection

**Acceptance criteria**

- [ ] AC1. The live preview reflects brand changes immediately
- [ ] AC2. Brand kits are selectable when creating a project

#### FT-29.2 - Editing Workspace

##### US-523 - Multi-track timeline view

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 9 | Frontend Engineer | [US-417](phase-4-mvp-complete.md#us-417---version-history-with-undo-redo-and-restore), [US-418](phase-4-mvp-complete.md#us-418---in-browser-preview-with-the-remotion-player) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to see the edit as tracks and clips, select elements and delete or undo them, so that I understand and control what the AI did.

**Technical tasks**

- [ ] `US-523-T1` Render video, overlay, graphics, caption and audio tracks with zoom and scrub synced to the preview
- [ ] `US-523-T2` Select clips to see properties and delete through commands; undo and redo buttons
- [ ] `US-523-T3` `TEST` Component tests and an E2E selection and delete scenario

**Acceptance criteria**

- [ ] AC1. The timeline reflects the current project version exactly
- [ ] AC2. Deleting a clip creates a command that can be undone

##### US-524 - Asset library UI

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 9 | Frontend Engineer | [US-412](phase-4-mvp-complete.md#us-412---semantic-asset-search) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to browse, search and upload assets with their licenses, so that I can curate what the AI may use.

**Technical tasks**

- [ ] `US-524-T1` Build asset browser with category filters, semantic search and license badges
- [ ] `US-524-T2` Allow upload with license entry and disable assets for AI use
- [ ] `US-524-T3` `TEST` Component tests for search and upload

**Acceptance criteria**

- [ ] AC1. Search results match the API semantic search
- [ ] AC2. Assets without a license cannot be enabled for AI use

##### US-525 - Generated components gallery with approval

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Frontend Engineer | [US-505](phase-5-advanced-autonomy.md#us-505---generated-component-registry-with-provenance) | Sequential after US-505 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to review generated and acquired components with previews and approve or reject them, so that I control what enters my library.

**Technical tasks**

- [ ] `US-525-T1` List generated and external components with preview, source, trust level and validation results
- [ ] `US-525-T2` Approve, reject or disable components
- [ ] `US-525-T3` `TEST` Component tests for approval states

**Acceptance criteria**

- [ ] AC1. Rejected components cannot be used by the agent
- [ ] AC2. Each component shows its provenance and validation report

##### US-526 - Dashboard overview

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 10 | Frontend Engineer | [US-318](phase-3-agent-mvp-alpha.md#us-318---project-runs-and-renders-overview) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want a dashboard with projects, recent renders, assets, fonts, brand kits and generated components, so that I can reach everything from one place.

**Technical tasks**

- [ ] `US-526-T1` Add a dashboard summary endpoint returning counts and recent items in one request
- [ ] `US-526-T2` Build dashboard sections with recent items and quick actions
- [ ] `US-526-T3` `TEST` Component and E2E navigation tests

**Acceptance criteria**

- [ ] AC1. Every section links to its management page
- [ ] AC2. The dashboard loads in under 2 seconds with 100 projects

##### US-527 - Advanced reference resolution in conversational edits

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P2 - Could (advanced) | 3 | Stretch | AI / Agent Engineer | [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) | Stretch backlog |

**User story:** As a creator, I want requests like "replace the B-roll at second 21" or "the part after the hook" understood precisely, so that complex revisions work first time.

**Technical tasks**

- [ ] `US-527-T1` Resolve structural references (hook, sections, nth caption) and relative time expressions
- [ ] `US-527-T2` Ask a clarifying question when a reference is ambiguous
- [ ] `US-527-T3` `TEST` Extended utterance test set

**Acceptance criteria**

- [ ] AC1. At least 90 percent of the extended utterance set resolves to the correct elements
- [ ] AC2. Ambiguous requests trigger one clarifying question instead of a guess

##### US-528 - Direct timeline manipulation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P3 - Stretch | 5 | Stretch | Frontend Engineer | [US-523](phase-5-advanced-autonomy.md#us-523---multi-track-timeline-view) | Stretch backlog |

**User story:** As a creator, I want to drag, trim and move clips on the timeline, so that I can fine-tune the AI edit by hand.

**Technical tasks**

- [ ] `US-528-T1` Implement drag, trim handles and snapping, all emitting commands
- [ ] `US-528-T2` Show conflicts when a manual edit invalidates AI-placed captions or B-roll and offer re-alignment
- [ ] `US-528-T3` `TEST` E2E tests for drag and trim with undo

**Acceptance criteria**

- [ ] AC1. Every manual edit is undoable and appears in version history
- [ ] AC2. Manual edits and AI revisions can be interleaved

## 7. Dependencies

### Phase-level

- Depends on [PH4](phase-4-mvp-complete.md) MVP Completion - Generative Editing, Design System and Interactive Workspace.
- Checkpoint CP5 (sandbox gate, US-501) must pass before generated or downloaded code runs anywhere except developer machines.
- US-503 is developed against the ISandbox port from day 1 and integrates with the real sandbox when US-501 merges (Dependency Inversion keeps the chain parallel).
- External - API keys for stock providers (for example Pexels, Pixabay, Freesound) and a package-registry mirror (Verdaccio) on staging.
- Multimodal critique (US-511) needs a vision-capable provider through IVisionModel (US-301).
- Unblocks [PH6](phase-6-hardening-release.md) Hardening, Evaluation and Graduation Release.

### Cross-phase story dependencies (inputs from earlier phases)

| Story | Needs | From phase | Ready by |
|---|---|---|---|
| [US-501](phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code) Sandbox runtime for untrusted code | [US-422](phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) Hardened, resource-limited worker containers | PH4 | Sprint 8 |
| [US-503](phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render) Component generation pipeline (generate, check, compile, test render) | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) Component manifest and plugin registry | PH4 | Sprint 7 |
| [US-504](phase-5-advanced-autonomy.md#us-504---self-repair-loop-with-visual-verification) Self-repair loop with visual verification | [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) Frame sampling and contact sheets | PH4 | Sprint 8 |
| [US-505](phase-5-advanced-autonomy.md#us-505---generated-component-registry-with-provenance) Generated component registry with provenance | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) Component manifest and plugin registry | PH4 | Sprint 7 |
| [US-506](phase-5-advanced-autonomy.md#us-506---generated-ffmpeg-filter-chains) Generated FFmpeg filter chains | [US-220](phase-2-perception-editing-core.md#us-220---safe-ffmpeg-command-builder) Safe FFmpeg command builder | PH2 | Sprint 3 |
| [US-507](phase-5-advanced-autonomy.md#us-507---internet-asset-providers-with-quarantine-download) Internet asset providers with quarantine download | [US-411](phase-4-mvp-complete.md#us-411---unified-local-asset-registry-with-starter-packs) Unified local asset registry with starter packs | PH4 | Sprint 7 |
| [US-511](phase-5-advanced-autonomy.md#us-511---multimodal-visual-critique) Multimodal visual critique | [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters) LLM provider port with capability descriptors and adapters | PH3 | Sprint 5 |
| [US-511](phase-5-advanced-autonomy.md#us-511---multimodal-visual-critique) Multimodal visual critique | [US-419](phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks) Deterministic render quality checks | PH4 | Sprint 8 |
| [US-511](phase-5-advanced-autonomy.md#us-511---multimodal-visual-critique) Multimodal visual critique | [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) Frame sampling and contact sheets | PH4 | Sprint 8 |
| [US-512](phase-5-advanced-autonomy.md#us-512---caption-audio-and-editing-quality-checks-v1) Caption, audio and editing quality checks v1 | [US-419](phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks) Deterministic render quality checks | PH4 | Sprint 8 |
| [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) Iterative refinement loop controller | [US-421](phase-4-mvp-complete.md#us-421---automatic-single-refinement-pass) Automatic single refinement pass | PH4 | Sprint 8 |
| [US-514](phase-5-advanced-autonomy.md#us-514---hook-detection-and-narrative-restructuring) Hook detection and narrative restructuring | [US-307](phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting) Highlight selection and semantic cutting | PH3 | Sprint 6 |
| [US-515](phase-5-advanced-autonomy.md#us-515---keyword-emphasis) Keyword emphasis | [US-402](phase-4-mvp-complete.md#us-402---motion-graphics-pack-v1) Motion graphics pack v1 | PH4 | Sprint 7 |
| [US-515](phase-5-advanced-autonomy.md#us-515---keyword-emphasis) Keyword emphasis | [US-409](phase-4-mvp-complete.md#us-409---project-creative-memory) Project creative memory | PH4 | Sprint 7 |
| [US-516](phase-5-advanced-autonomy.md#us-516---beat-detection-and-beat-synchronized-cutting) Beat detection and beat-synchronized cutting | [US-414](phase-4-mvp-complete.md#us-414---music-selection-from-the-registry) Music selection from the registry | PH4 | Sprint 8 |
| [US-517](phase-5-advanced-autonomy.md#us-517---mood-detection-and-music-matching) Mood detection and music matching | [US-414](phase-4-mvp-complete.md#us-414---music-selection-from-the-registry) Music selection from the registry | PH4 | Sprint 8 |
| [US-518](phase-5-advanced-autonomy.md#us-518---pacing-control) Pacing control | [US-307](phase-3-agent-mvp-alpha.md#us-307---highlight-selection-and-semantic-cutting) Highlight selection and semantic cutting | PH3 | Sprint 6 |
| [US-519](phase-5-advanced-autonomy.md#us-519---semantic-visual-understanding-for-clip-and-b-roll-selection) Semantic visual understanding for clip and B-roll selection | [US-413](phase-4-mvp-complete.md#us-413---basic-b-roll-insertion) Basic B-roll insertion | PH4 | Sprint 8 |
| [US-519](phase-5-advanced-autonomy.md#us-519---semantic-visual-understanding-for-clip-and-b-roll-selection) Semantic visual understanding for clip and B-roll selection | [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) Frame sampling and contact sheets | PH4 | Sprint 8 |
| [US-520](phase-5-advanced-autonomy.md#us-520---full-autonomous-creativity-level-with-approval-gates) Full Autonomous creativity level with approval gates | [US-410](phase-4-mvp-complete.md#us-410---creativity-level-policy-enforcement) Creativity level policy enforcement | PH4 | Sprint 7 |
| [US-521](phase-5-advanced-autonomy.md#us-521---brand-kit-model-and-application) Brand kit model and application | [US-406](phase-4-mvp-complete.md#us-406---font-registry-with-metadata-and-validation) Font registry with metadata and validation | PH4 | Sprint 7 |
| [US-521](phase-5-advanced-autonomy.md#us-521---brand-kit-model-and-application) Brand kit model and application | [US-409](phase-4-mvp-complete.md#us-409---project-creative-memory) Project creative memory | PH4 | Sprint 7 |
| [US-523](phase-5-advanced-autonomy.md#us-523---multi-track-timeline-view) Multi-track timeline view | [US-417](phase-4-mvp-complete.md#us-417---version-history-with-undo-redo-and-restore) Version history with undo, redo and restore | PH4 | Sprint 8 |
| [US-523](phase-5-advanced-autonomy.md#us-523---multi-track-timeline-view) Multi-track timeline view | [US-418](phase-4-mvp-complete.md#us-418---in-browser-preview-with-the-remotion-player) In-browser preview with the Remotion Player | PH4 | Sprint 7 |
| [US-524](phase-5-advanced-autonomy.md#us-524---asset-library-ui) Asset library UI | [US-412](phase-4-mvp-complete.md#us-412---semantic-asset-search) Semantic asset search | PH4 | Sprint 8 |
| [US-526](phase-5-advanced-autonomy.md#us-526---dashboard-overview) Dashboard overview | [US-318](phase-3-agent-mvp-alpha.md#us-318---project-runs-and-renders-overview) Project runs and renders overview | PH3 | Sprint 6 |
| [US-527](phase-5-advanced-autonomy.md#us-527---advanced-reference-resolution-in-conversational-edits) Advanced reference resolution in conversational edits | [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) Revision mode for incremental natural-language edits | PH4 | Sprint 8 |

### Same-sprint sequencing (everything else in a sprint runs in parallel)

- Sprint 9: US-501 -> US-502 Controlled dependency installation through a registry mirror
- Sprint 9: US-501 -> US-503 Component generation pipeline (generate, check, compile, test render)
- Sprint 10: US-505, US-509 -> US-510 Component acquisition from package registries
- Sprint 10: US-511 -> US-513 Iterative refinement loop controller
- Sprint 10: US-521 -> US-522 Brand kit management UI
- Sprint 10: US-505 -> US-525 Generated components gallery with approval

## 8. Sprint allocation

| Sprint | Sprint goal | Stories | SP | AI | MM | GEN | BE | FE | OPS | ALL |
|---|---|---|---|---|---|---|---|---|---|---|
| [Sprint 9](../sprints.md#sprint-9) | Enable Level-3 capabilities safely - sandboxed execution, AI-generated Remotion components, internet asset providers, narrative restructuring and beat-aware cutting - and add the timeline view. | US-501, US-502, US-503, US-507, US-512, US-514, US-516, US-523, US-524 | 52 | 8 | 10 | 8 | 10 | 8 | 8 | 0 |
| [Sprint 10](../sprints.md#sprint-10) | Add the multimodal critic with iterative refinement, component acquisition from package registries with full validation, self-repairing code generation, brand kits and Full Autonomous mode. | US-504, US-505, US-508, US-509, US-510, US-511, US-513, US-515, US-518, US-520, US-521, US-522, US-525, US-526 | 52 | 11 | 6 | 10 | 11 | 9 | 5 | 0 |

Stretch backlog (pulled in only if capacity allows): US-506, US-517, US-519, US-527, US-528

## 9. Deliverables

- Sandbox runtime (rootless containers with gVisor, no network, resource limits) and controlled dependency installation
- Component generation pipeline with static analysis, sandboxed compile and test render, self-repair and generated component registry
- Internet asset providers, license and provenance validation, media and package security validation
- External component acquisition from package registries with sandbox install and test render
- Multimodal visual critique, caption/audio/editing checks v1 and an iterative refinement controller
- Hook detection, narrative restructuring, keyword emphasis, beat-synchronized cutting and pacing control
- Full Autonomous creativity level with approval gates
- Brand kits, timeline view, asset library, generated components gallery and dashboard

## 10. Definition of Done

The phase is done when all of the following hold (in addition to the story-level DoD for every story):

- [ ] Checkpoint CP5 passed and the sandbox security suite runs in CI
- [ ] Milestone M5 met - all scheduled stories merged and v0.95-beta tagged; everything else moved to the stretch backlog
- [ ] No generated or downloaded code executes outside the sandbox (verified by tests that attempt it)
- [ ] Every externally acquired asset or package has recorded license, source, hash and validation results
- [ ] Scenarios A-G each succeed at least once on staging, with audit trails stored
- [ ] Refinement loop improves the quality score on at least 60 percent of evaluation videos and never exceeds its iteration limit
- [ ] Documentation updated for the sandbox, acquisition pipeline, generated components and critic

### Milestone exit criteria

**CP5 - Sandbox Security Gate** (end of Sprint 9)

- [ ] Sandbox escape, network egress and resource-exhaustion suites pass
- [ ] Generated or downloaded code cannot run outside the sandbox (verified by tests, not convention)

**M5 - Feature Freeze - v0.95-beta** (end of Sprint 10)

- [ ] All scheduled P0-P2 stories merged; remaining work moved to the stretch backlog
- [ ] Scenarios A-G each succeed at least once on staging
- [ ] Critic refinement loop improves the quality score on at least 60 percent of evaluation videos
