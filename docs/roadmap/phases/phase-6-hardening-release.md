<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# PH6 - Hardening, Evaluation and Graduation Release

| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |
|---|---|---|---|---|---|
| Sprint 11, Sprint 12 | Weeks 21-24 | v1.0-graduation | release | 80 SP (21 stories) | CP6 Security and Performance Gate, M6 Release Candidate - v1.0-rc1, M7 v1.0-graduation Release and Demo |

[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | [Dependencies](../dependencies.md) | [Milestones](../milestones.md)

## 1. Objective

Turn the feature-complete beta into a secure, fast, observable and well-documented release, prove the architecture's extensibility, evaluate the system scientifically against human edits, and deliver the graduation demo from a fresh deployment. No new features are started in this phase - only hardening, measurement, documentation and release work. Covers original Phases 15 (hardening), 16, 17, 18, 19, 20 and 21. Security, testing, documentation and CI/CD also run in every earlier sprint; this phase finishes and verifies them.

## 2. Epics

| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |
|---|---|---|---|---|---|
| [EP-30](phase-6-hardening-release.md#ep-30---security-hardening) Security Hardening | Verify the security-by-design controls built throughout the project and close remaining gaps. | S11 | 11 | [EP-17](phase-3-agent-mvp-alpha.md#ep-17---agent-safety-and-evaluation), [EP-24](phase-5-advanced-autonomy.md#ep-24---secure-execution-sandbox), [EP-26](phase-5-advanced-autonomy.md#ep-26---external-resource-acquisition), [EP-03](phase-1-foundation.md#ep-03---identity-and-project-management), [EP-23](phase-4-mvp-complete.md#ep-23---platform-hardening-and-pipeline-maturity), [EP-28](phase-5-advanced-autonomy.md#ep-28---creative-intelligence) | [EP-31](phase-6-hardening-release.md#ep-31---performance-optimization), [EP-32](phase-6-hardening-release.md#ep-32---observability-and-debugging), [EP-33](phase-6-hardening-release.md#ep-33---extensibility-proof-and-stabilization) |
| [EP-31](phase-6-hardening-release.md#ep-31---performance-optimization) Performance Optimization | Meet processing-time budgets and avoid repeated work. | S11 | 16 | [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis), [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine), [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-08](phase-2-perception-editing-core.md#ep-08---visual-understanding), [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools), [EP-17](phase-3-agent-mvp-alpha.md#ep-17---agent-safety-and-evaluation), [EP-23](phase-4-mvp-complete.md#ep-23---platform-hardening-and-pipeline-maturity) | [EP-30](phase-6-hardening-release.md#ep-30---security-hardening), [EP-32](phase-6-hardening-release.md#ep-32---observability-and-debugging), [EP-33](phase-6-hardening-release.md#ep-33---extensibility-proof-and-stabilization) |
| [EP-32](phase-6-hardening-release.md#ep-32---observability-and-debugging) Observability and Debugging | Make every job, model call and agent decision measurable and explainable. | S11 | 10 | [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop), [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement) | [EP-30](phase-6-hardening-release.md#ep-30---security-hardening), [EP-31](phase-6-hardening-release.md#ep-31---performance-optimization), [EP-33](phase-6-hardening-release.md#ep-33---extensibility-proof-and-stabilization) |
| [EP-33](phase-6-hardening-release.md#ep-33---extensibility-proof-and-stabilization) Extensibility Proof and Stabilization | Demonstrate that new models, tools, components and providers plug in without refactoring, and stabilize the release. | S11 | 11 | [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-13](phase-3-agent-mvp-alpha.md#ep-13---llm-provider-layer), [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system) | [EP-30](phase-6-hardening-release.md#ep-30---security-hardening), [EP-31](phase-6-hardening-release.md#ep-31---performance-optimization), [EP-32](phase-6-hardening-release.md#ep-32---observability-and-debugging) |
| [EP-34](phase-6-hardening-release.md#ep-34---evaluation-and-research-contribution) Evaluation and Research Contribution | Measure the system against human editing and support the academic contribution with evidence. | S12 | 13 | [EP-17](phase-3-agent-mvp-alpha.md#ep-17---agent-safety-and-evaluation), [EP-27](phase-5-advanced-autonomy.md#ep-27---ai-critic-and-self-refinement), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview), [EP-25](phase-5-advanced-autonomy.md#ep-25---autonomous-component-generation), [EP-26](phase-5-advanced-autonomy.md#ep-26---external-resource-acquisition) | [EP-35](phase-6-hardening-release.md#ep-35---documentation) |
| [EP-35](phase-6-hardening-release.md#ep-35---documentation) Documentation | Deliver complete, accurate documentation for users, developers, operators and examiners. | S12 | 11 | [EP-33](phase-6-hardening-release.md#ep-33---extensibility-proof-and-stabilization), [EP-01](phase-1-foundation.md#ep-01---product-discovery-and-architecture-baseline), [EP-29](phase-5-advanced-autonomy.md#ep-29---workspace-and-brand-experience), [EP-30](phase-6-hardening-release.md#ep-30---security-hardening), [EP-31](phase-6-hardening-release.md#ep-31---performance-optimization) | [EP-34](phase-6-hardening-release.md#ep-34---evaluation-and-research-contribution) |
| [EP-36](phase-6-hardening-release.md#ep-36---release-and-graduation-demo) Release and Graduation Demo | Freeze a reproducible release and deliver a confident graduation demonstration. | S12 | 8 | [EP-34](phase-6-hardening-release.md#ep-34---evaluation-and-research-contribution), [EP-35](phase-6-hardening-release.md#ep-35---documentation), [EP-33](phase-6-hardening-release.md#ep-33---extensibility-proof-and-stabilization) | - |

## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria

Task tags: `TEST`, `DOC`, `CI/CD`, `SECURITY`, `INTEGRATION` mark testing, documentation, CI/CD, security and integration work that is built into the story itself. Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).

### EP-30 - Security Hardening

**Epic goal:** Verify the security-by-design controls built throughout the project and close remaining gaps.

#### FT-30.1 - Application Security Verification

##### US-601 - Security test suite and ASVS review

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 11 | DevOps & QA (shared) | [US-118](phase-1-foundation.md#us-118---secure-authentication-and-project-level-authorization), [US-422](phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want the application verified against OWASP ASVS and attacked by automated tests, so that no known class of vulnerability ships in the release.

**Technical tasks**

- [ ] `US-601-T1` `SECURITY` Complete the OWASP ASVS level 1 checklist with evidence per requirement
- [ ] `US-601-T2` `SECURITY` Automated tests for broken access control, IDOR across projects, SSRF (media URLs, asset URLs), path traversal fuzzing, upload abuse and rate limits
- [ ] `US-601-T3` `SECURITY` Run an OWASP ZAP baseline scan against staging in CI
- [ ] `US-601-T4` `CI/CD` Make critical and high findings from code, dependency and image scans release-blocking
- [ ] `US-601-T5` `DOC` Record findings, fixes and accepted risks in the security report

**Acceptance criteria**

- [ ] AC1. All ASVS level 1 items are passed or have a documented, accepted exception
- [ ] AC2. The ZAP baseline reports no high-risk alerts

##### US-602 - Prompt-injection and agent safety red-team

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 11 | AI / Agent Engineer | [US-319](phase-3-agent-mvp-alpha.md#us-319---tool-permission-model-and-injection-test-suite), [US-520](phase-5-advanced-autonomy.md#us-520---full-autonomous-creativity-level-with-approval-gates) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want the agent attacked with adversarial content, so that we know it cannot be steered into harmful or unauthorized actions.

**Technical tasks**

- [ ] `US-602-T1` `SECURITY` Build adversarial cases - instructions spoken in footage, malicious asset metadata and package READMEs, poisoned search results, requests to exfiltrate data
- [ ] `US-602-T2` `SECURITY` Run them in every creativity level including Full Autonomous and record outcomes
- [ ] `US-602-T3` `TEST` Add all cases to the regression suite

**Acceptance criteria**

- [ ] AC1. No case results in an unauthorized tool call, data exfiltration or sandbox bypass
- [ ] AC2. All cases run in nightly CI

##### US-603 - Sandbox and resource-exhaustion red-team

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 11 | DevOps & QA (shared) | [US-501](phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code), [US-509](phase-5-advanced-autonomy.md#us-509---media-and-package-security-validation) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want generated and acquired code attacked on purpose, so that the sandbox is proven, not assumed.

**Technical tasks**

- [ ] `US-603-T1` `SECURITY` Attempt escapes via generated components (host paths, environment variables, network, Chromium flags)
- [ ] `US-603-T2` `SECURITY` Attempt resource exhaustion via renders (huge canvases, infinite animation loops, memory growth)
- [ ] `US-603-T3` `TEST` Add successful and failed attempts to the sandbox suite

**Acceptance criteria**

- [ ] AC1. Every attempt is contained and reported
- [ ] AC2. Limits terminate runaway renders within the configured time

### EP-31 - Performance Optimization

**Epic goal:** Meet processing-time budgets and avoid repeated work.

#### FT-31.1 - Inference and Analysis Performance

##### US-604 - GPU inference and model pooling

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 11 | AI / Agent Engineer | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper), [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) | Parallel - can start on day 1 of the sprint |

**User story:** As the platform, I want models loaded once and reused on the GPU, so that analysis is fast and GPU memory is used efficiently.

**Technical tasks**

- [ ] `US-604-T1` Keep warm model pools per worker with configurable concurrency and batch frame inference
- [ ] `US-604-T2` Add GPU memory guards and graceful CPU fallback
- [ ] `US-604-T3` `TEST` Benchmark before and after on the reference GPU

**Acceptance criteria**

- [ ] AC1. Transcription plus face tracking of a 10-minute video is at least 30 percent faster than the Sprint 10 baseline
- [ ] AC2. No out-of-memory crash under 2 concurrent jobs

##### US-605 - Parallel analysis DAG

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 11 | Backend Engineer | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation), [US-423](phase-4-mvp-complete.md#us-423---analysis-caching-by-media-fingerprint) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want independent analyses to run in parallel, so that I can start editing sooner.

**Technical tasks**

- [ ] `US-605-T1` Model analysis as a DAG (probe, then proxy and audio, then transcription, VAD, audio, shots and faces in parallel, then aggregate) using queue flows
- [ ] `US-605-T2` Aggregate progress and support partial results for early agent planning
- [ ] `US-605-T3` `TEST` Integration tests for ordering, parallelism and failure isolation

**Acceptance criteria**

- [ ] AC1. Total analysis wall time is at most the longest branch plus 10 percent
- [ ] AC2. One failing branch does not block the others

##### US-606 - Performance benchmark suite and budgets

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 11 | Multimedia Engineer | [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0) | Parallel - can start on day 1 of the sprint |

**User story:** As the team, I want automated end-to-end performance benchmarks with budgets, so that regressions are caught before release.

**Technical tasks**

- [ ] `US-606-T1` `TEST` Benchmark upload-to-reel for 2, 10 and 30 minute sources on the reference GPU, recording per-stage timings
- [ ] `US-606-T2` `CI/CD` Run nightly and fail when a budget is exceeded by more than 10 percent
- [ ] `US-606-T3` `DOC` Publish budgets and results in the performance report

**Acceptance criteria**

- [ ] AC1. A 10-minute source becomes a 45-second reel in at most 15 minutes at p95
- [ ] AC2. Budget violations fail the nightly job with the slow stage named

#### FT-31.2 - Rendering Performance

##### US-607 - Incremental rendering and render caching

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 11 | Generative Video / Remotion Engineer | [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want small revisions to render quickly, so that conversational editing feels interactive.

**Technical tasks**

- [ ] `US-607-T1` Split renders into segments, hash each segment's inputs and reuse unchanged segments
- [ ] `US-607-T2` Render changed segments in parallel and concatenate without re-encoding where possible
- [ ] `US-607-T3` `TEST` Tests proving unchanged segments are reused and output is identical to a full render

**Acceptance criteria**

- [ ] AC1. Changing one caption re-renders only affected segments
- [ ] AC2. A single-caption revision of a 45-second reel renders at least 3 times faster than a full render

### EP-32 - Observability and Debugging

**Epic goal:** Make every job, model call and agent decision measurable and explainable.

#### FT-32.1 - Metrics, Tracing and Error Tracking

##### US-608 - Metrics, distributed tracing, dashboards and error tracking

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 11 | Backend Engineer | [US-115](phase-1-foundation.md#us-115---structured-logging-health-checks-and-error-handling-baseline), [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) | Parallel - can start on day 1 of the sprint |

**User story:** As an operator, I want dashboards and traces for jobs, GPU, tokens and errors, so that I can find bottlenecks and failures quickly.

**Technical tasks**

- [ ] `US-608-T1` Enable OpenTelemetry traces across api, queue and workers with trace context in job payloads
- [ ] `US-608-T2` Export Prometheus metrics (job durations and states, queue depth, render time, GPU utilization via DCGM exporter, tokens and cost per run)
- [ ] `US-608-T3` Provision Grafana dashboards and alerts as code; add Sentry error tracking for web, api and workers
- [ ] `US-608-T4` `TEST` Test that one agent run produces a single connected trace

**Acceptance criteria**

- [ ] AC1. One trace shows the full path from the API request to every worker job of a run
- [ ] AC2. Dashboards show tokens, cost, GPU usage and job states for the last 24 hours

#### FT-32.2 - Agent Run Inspector

##### US-609 - Agent run inspector

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 11 | Frontend Engineer | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api), [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) | Parallel - can start on day 1 of the sprint |

**User story:** As a developer and researcher, I want a visual timeline of every agent decision, tool call, critique and render in a run, so that behaviour can be debugged and analysed academically.

**Technical tasks**

- [ ] `US-609-T1` Show steps with rationale, tool inputs and outputs, timings, tokens, cost and errors
- [ ] `US-609-T2` Show critique iterations with quality scores and linked renders
- [ ] `US-609-T3` Export a run as JSON for the evaluation chapter
- [ ] `US-609-T4` `TEST` Component tests with recorded runs

**Acceptance criteria**

- [ ] AC1. Every step of a recorded run is visible and linked to its tool execution record
- [ ] AC2. Exported runs load back into the inspector

### EP-33 - Extensibility Proof and Stabilization

**Epic goal:** Demonstrate that new models, tools, components and providers plug in without refactoring, and stabilize the release.

#### FT-33.1 - Extensibility Proof

##### US-610 - Plugin-only extension proof

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 11 | Generative Video / Remotion Engineer | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation), [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters), [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) | Parallel - can start on day 1 of the sprint |

**User story:** As an architect, I want to add a new editing tool, a new LLM provider and a new component without modifying core modules, so that the Open/Closed design is demonstrated with evidence.

**Technical tasks**

- [ ] `US-610-T1` Add a sample tool (for example color_grade with a LUT), a sample LLM provider adapter and a sample component as separate plugin packages
- [ ] `US-610-T2` `CI/CD` Add a CI check proving the change touched only plugin packages and configuration
- [ ] `US-610-T3` `TEST` Run the provider conformance suite and tool and component contract tests on the new plugins

**Acceptance criteria**

- [ ] AC1. All three extensions work end-to-end and the diff contains no changes in core packages
- [ ] AC2. The CI path check fails when a core package is modified in an extension-only change

##### US-612 - Tool SDK, component and provider authoring guide

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 11 | Generative Video / Remotion Engineer | [US-610](phase-6-hardening-release.md#us-610---plugin-only-extension-proof) | Sequential after US-610 (same sprint; contract-first stubs allowed) |

**User story:** As a future contributor, I want a step-by-step guide for adding tools, components, analyzers and LLM providers, so that the platform can keep growing after graduation.

**Technical tasks**

- [ ] `US-612-T1` `DOC` Write guides with the US-610 examples as worked tutorials
- [ ] `US-612-T2` `DOC` Document manifests, schemas, permissions, testing requirements and review checklist
- [ ] `US-612-T3` `TEST` Have a team member follow the guide to add a trivial tool and record friction

**Acceptance criteria**

- [ ] AC1. A team member unfamiliar with the SDK adds a tool using only the guide
- [ ] AC2. The guide covers tools, components, analyzers and LLM providers

#### FT-33.2 - Stabilization

##### US-611 - Bug bash and stabilization

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 11 | Whole team | None | Parallel - can start on day 1 of the sprint |

**User story:** As the team, I want a structured bug bash and fix period, so that the release candidate is stable.

**Technical tasks**

- [ ] `US-611-T1` Run a half-day bug bash on staging covering all scenarios and personas
- [ ] `US-611-T2` Triage daily by severity and fix all P0 and P1 defects
- [ ] `US-611-T3` `TEST` Add a regression test for every fixed defect
- [ ] `US-611-T4` `CI/CD` Tag v1.0-rc1 when the exit criteria are met

**Acceptance criteria**

- [ ] AC1. Zero open P0 or P1 defects at the Sprint 11 review
- [ ] AC2. Every fixed defect has a regression test

### EP-34 - Evaluation and Research Contribution

**Epic goal:** Measure the system against human editing and support the academic contribution with evidence.

#### FT-34.1 - Quantitative and Human Evaluation

##### US-613 - Full evaluation run with ablations

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 12 | AI / Agent Engineer | [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0), [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) | Parallel - can start on day 1 of the sprint |

**User story:** As a researcher, I want complete metrics and ablation studies, so that the thesis can show which components contribute to quality.

**Technical tasks**

- [ ] `US-613-T1` Run the harness on the full dataset for all creativity levels
- [ ] `US-613-T2` Ablations - without critic, without creative intelligence, with different LLM providers
- [ ] `US-613-T3` Compute all metrics (caption WER and sync, silence removal accuracy, content retention, render success, editing time, manual corrections)
- [ ] `US-613-T4` `DOC` Publish the evaluation report with tables and charts

**Acceptance criteria**

- [ ] AC1. Every metric from the evaluation plan is reported per video category
- [ ] AC2. Ablation results show the effect of the critic loop with confidence intervals

##### US-614 - Human acceptance study

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 12 | Frontend Engineer | [US-613](phase-6-hardening-release.md#us-613---full-evaluation-run-with-ablations) | Sequential after US-613 (same sprint; contract-first stubs allowed) |

**User story:** As a researcher, I want blind comparisons between AI and human edits, so that human acceptance is measured credibly.

**Technical tasks**

- [ ] `US-614-T1` Build a simple blind rating page (A/B order randomized, rating scale, comments)
- [ ] `US-614-T2` Recruit at least 5 raters and collect ratings for at least 6 video pairs
- [ ] `US-614-T3` `DOC` Analyse acceptance rate and add results to the evaluation report

**Acceptance criteria**

- [ ] AC1. Each video pair has ratings from at least 5 raters
- [ ] AC2. Human acceptance rate and inter-rater agreement are reported

#### FT-34.2 - Evaluation Scenarios

##### US-615 - Scripted evaluation scenarios A-G

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 12 | Multimedia Engineer | [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits), [US-503](phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render), [US-510](phase-5-advanced-autonomy.md#us-510---component-acquisition-from-package-registries), [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) | Parallel - can start on day 1 of the sprint |

**User story:** As the examination committee, I want each graduation scenario reproducible on demand, so that the capabilities can be verified live.

**Technical tasks**

- [ ] `US-615-T1` Script scenarios A (podcast to 45-second Reel), B (educational to Short), C (custom animation), D (missing component acquisition), E (self-generated capability), F (self-detected fix), G (natural-language modification)
- [ ] `US-615-T2` Prepare fixtures, prompts and expected checks for each scenario
- [ ] `US-615-T3` `TEST` Run all scenarios nightly on staging in the final two weeks and record videos of successful runs

**Acceptance criteria**

- [ ] AC1. Each scenario passes 3 consecutive nightly runs
- [ ] AC2. A recorded successful run exists for every scenario

### EP-35 - Documentation

**Epic goal:** Deliver complete, accurate documentation for users, developers, operators and examiners.

#### FT-35.1 - Technical and User Documentation

##### US-616 - Architecture and developer documentation with required diagrams

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 12 | Backend Engineer | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs), [US-612](phase-6-hardening-release.md#us-612---tool-sdk-component-and-provider-authoring-guide) | Parallel - can start on day 1 of the sprint |

**User story:** As a developer or examiner, I want complete architecture documentation, so that the system can be understood, maintained and assessed.

**Technical tasks**

- [ ] `US-616-T1` `DOC` Finalize system architecture, C4, sequence diagrams (agent run, render, acquisition, refinement), class diagram, ER diagram, deployment diagram and agent workflow diagram
- [ ] `US-616-T2` `DOC` Finalize the developer guide, agent documentation and ADR index
- [ ] `US-616-T3` `TEST` Verify diagrams against the code (module list, entities, services) in a review checklist

**Acceptance criteria**

- [ ] AC1. Every diagram listed in the original plan exists as source and image
- [ ] AC2. Diagrams match the implemented modules and entities

##### US-617 - User manual and API documentation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 12 | Frontend Engineer | [US-526](phase-5-advanced-autonomy.md#us-526---dashboard-overview) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator or integrator, I want a user manual and published API documentation, so that I can use and integrate EditAgent without help.

**Technical tasks**

- [ ] `US-617-T1` `DOC` Write the user manual with screenshots for every main flow
- [ ] `US-617-T2` `DOC` Publish the generated OpenAPI documentation with examples
- [ ] `US-617-T3` `TEST` Have one person outside the team complete a task using only the manual

**Acceptance criteria**

- [ ] AC1. An outside user completes upload, prompt, revision and export using only the manual
- [ ] AC2. Every public endpoint has a description and example

##### US-618 - Security, testing and deployment documentation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 12 | DevOps & QA (shared) | [US-601](phase-6-hardening-release.md#us-601---security-test-suite-and-asvs-review), [US-606](phase-6-hardening-release.md#us-606---performance-benchmark-suite-and-budgets) | Parallel - can start on day 1 of the sprint |

**User story:** As an operator or examiner, I want security, testing and deployment documents, so that the system can be deployed safely and its quality evidence reviewed.

**Technical tasks**

- [ ] `US-618-T1` `DOC` Security documentation - threat model, controls, sandbox, red-team results
- [ ] `US-618-T2` `DOC` Testing documentation - strategy, coverage, suites and results
- [ ] `US-618-T3` `DOC` Installation and deployment guides for local, staging and demo environments

**Acceptance criteria**

- [ ] AC1. Every threat in the register maps to documented controls and tests
- [ ] AC2. The deployment guide is validated by US-619

### EP-36 - Release and Graduation Demo

**Epic goal:** Freeze a reproducible release and deliver a confident graduation demonstration.

#### FT-36.1 - Release

##### US-619 - Fresh deployment verification and bootstrap script

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 12 | DevOps & QA (shared) | [US-618](phase-6-hardening-release.md#us-618---security-testing-and-deployment-documentation) | Sequential after US-618 (same sprint; contract-first stubs allowed) |

**User story:** As an examiner, I want the system deployable from a clean machine with documented steps only, so that nothing depends on hidden developer setup.

**Technical tasks**

- [ ] `US-619-T1` Write a bootstrap script (checks prerequisites, downloads models, configures environment, starts services, seeds demo data)
- [ ] `US-619-T2` `TEST` Perform a clean-machine deployment and run scenario A
- [ ] `US-619-T3` `DOC` Fix every gap found in the installation guide

**Acceptance criteria**

- [ ] AC1. A clean machine reaches a working system using only the README and bootstrap script
- [ ] AC2. Scenario A passes on the fresh deployment

##### US-620 - Release freeze v1.0-graduation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 2 | Sprint 12 | Whole team | [US-611](phase-6-hardening-release.md#us-611---bug-bash-and-stabilization), [US-619](phase-6-hardening-release.md#us-619---fresh-deployment-verification-and-bootstrap-script) | Sequential after US-619 (same sprint; contract-first stubs allowed) |

**User story:** As the team, I want a tagged, reproducible release, so that the graduation version is stable and verifiable.

**Technical tasks**

- [ ] `US-620-T1` `CI/CD` Tag v1.0-graduation, publish images pinned by digest, SBOM and release notes
- [ ] `US-620-T2` Freeze main except for release-blocking fixes
- [ ] `US-620-T3` `TEST` Re-run all suites on the tag

**Acceptance criteria**

- [ ] AC1. The release can be rebuilt from the tag with identical image digests for pinned dependencies
- [ ] AC2. All suites are green on the tag

#### FT-36.2 - Graduation Demo

##### US-621 - Graduation demo preparation and rehearsal

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 12 | Whole team | [US-615](phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g), [US-620](phase-6-hardening-release.md#us-620---release-freeze-v10-graduation) | Sequential after US-615, US-620 (same sprint; contract-first stubs allowed) |

**User story:** As the team, I want a rehearsed demo showing raw footage to final video with custom capability creation and self-correction, so that the contribution is clear to the committee.

**Technical tasks**

- [ ] `US-621-T1` Script the demo flow (raw footage, prompt, understanding, autonomous editing, custom effect, AI review, automatic correction, final video)
- [ ] `US-621-T2` Prepare side-by-side before and after comparisons and recorded backups of every scenario
- [ ] `US-621-T3` Rehearse twice on the demo environment and fix issues found

**Acceptance criteria**

- [ ] AC1. Two full rehearsals complete within the time slot
- [ ] AC2. A backup recording exists for every live step

## 7. Dependencies

### Phase-level

- Depends on [PH5](phase-5-advanced-autonomy.md) Advanced Autonomy - Self-Expanding and Creative Editor.
- Feature freeze (M5) is a precondition; any feature request becomes a stretch item or post-graduation backlog item.
- Evaluation (US-613, US-614) needs the dataset (US-110) and harness (US-320) plus human raters booked before Sprint 12.
- External - a clean machine or VM identical to the demo environment for US-619, and the demo venue's network and GPU constraints confirmed.
- Sprint 12 is intentionally planned below velocity to absorb release defects and thesis writing.

### Cross-phase story dependencies (inputs from earlier phases)

| Story | Needs | From phase | Ready by |
|---|---|---|---|
| [US-601](phase-6-hardening-release.md#us-601---security-test-suite-and-asvs-review) Security test suite and ASVS review | [US-118](phase-1-foundation.md#us-118---secure-authentication-and-project-level-authorization) Secure authentication and project-level authorization | PH1 | Sprint 2 |
| [US-601](phase-6-hardening-release.md#us-601---security-test-suite-and-asvs-review) Security test suite and ASVS review | [US-422](phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) Hardened, resource-limited worker containers | PH4 | Sprint 8 |
| [US-602](phase-6-hardening-release.md#us-602---prompt-injection-and-agent-safety-red-team) Prompt-injection and agent safety red-team | [US-319](phase-3-agent-mvp-alpha.md#us-319---tool-permission-model-and-injection-test-suite) Tool permission model and injection test suite | PH3 | Sprint 5 |
| [US-602](phase-6-hardening-release.md#us-602---prompt-injection-and-agent-safety-red-team) Prompt-injection and agent safety red-team | [US-520](phase-5-advanced-autonomy.md#us-520---full-autonomous-creativity-level-with-approval-gates) Full Autonomous creativity level with approval gates | PH5 | Sprint 10 |
| [US-603](phase-6-hardening-release.md#us-603---sandbox-and-resource-exhaustion-red-team) Sandbox and resource-exhaustion red-team | [US-501](phase-5-advanced-autonomy.md#us-501---sandbox-runtime-for-untrusted-code) Sandbox runtime for untrusted code | PH5 | Sprint 9 |
| [US-603](phase-6-hardening-release.md#us-603---sandbox-and-resource-exhaustion-red-team) Sandbox and resource-exhaustion red-team | [US-509](phase-5-advanced-autonomy.md#us-509---media-and-package-security-validation) Media and package security validation | PH5 | Sprint 10 |
| [US-604](phase-6-hardening-release.md#us-604---gpu-inference-and-model-pooling) GPU inference and model pooling | [US-201](phase-2-perception-editing-core.md#us-201---word-level-transcription-with-faster-whisper) Word-level transcription with Faster-Whisper | PH2 | Sprint 3 |
| [US-604](phase-6-hardening-release.md#us-604---gpu-inference-and-model-pooling) GPU inference and model pooling | [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) Face detection and tracking | PH2 | Sprint 4 |
| [US-605](phase-6-hardening-release.md#us-605---parallel-analysis-dag) Parallel analysis DAG | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation) Analysis orchestration and aggregation | PH2 | Sprint 3 |
| [US-605](phase-6-hardening-release.md#us-605---parallel-analysis-dag) Parallel analysis DAG | [US-423](phase-4-mvp-complete.md#us-423---analysis-caching-by-media-fingerprint) Analysis caching by media fingerprint | PH4 | Sprint 7 |
| [US-606](phase-6-hardening-release.md#us-606---performance-benchmark-suite-and-budgets) Performance benchmark suite and budgets | [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0) Evaluation harness v0 | PH3 | Sprint 6 |
| [US-607](phase-6-hardening-release.md#us-607---incremental-rendering-and-render-caching) Incremental rendering and render caching | [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) Preview and final render profiles with output validation | PH3 | Sprint 6 |
| [US-608](phase-6-hardening-release.md#us-608---metrics-distributed-tracing-dashboards-and-error-tracking) Metrics, distributed tracing, dashboards and error tracking | [US-115](phase-1-foundation.md#us-115---structured-logging-health-checks-and-error-handling-baseline) Structured logging, health checks and error handling baseline | PH1 | Sprint 2 |
| [US-608](phase-6-hardening-release.md#us-608---metrics-distributed-tracing-dashboards-and-error-tracking) Metrics, distributed tracing, dashboards and error tracking | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) Agent event stream and audit trail API | PH3 | Sprint 6 |
| [US-609](phase-6-hardening-release.md#us-609---agent-run-inspector) Agent run inspector | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) Agent event stream and audit trail API | PH3 | Sprint 6 |
| [US-609](phase-6-hardening-release.md#us-609---agent-run-inspector) Agent run inspector | [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) Iterative refinement loop controller | PH5 | Sprint 10 |
| [US-610](phase-6-hardening-release.md#us-610---plugin-only-extension-proof) Plugin-only extension proof | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | PH2 | Sprint 4 |
| [US-610](phase-6-hardening-release.md#us-610---plugin-only-extension-proof) Plugin-only extension proof | [US-301](phase-3-agent-mvp-alpha.md#us-301---llm-provider-port-with-capability-descriptors-and-adapters) LLM provider port with capability descriptors and adapters | PH3 | Sprint 5 |
| [US-610](phase-6-hardening-release.md#us-610---plugin-only-extension-proof) Plugin-only extension proof | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) Component manifest and plugin registry | PH4 | Sprint 7 |
| [US-613](phase-6-hardening-release.md#us-613---full-evaluation-run-with-ablations) Full evaluation run with ablations | [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0) Evaluation harness v0 | PH3 | Sprint 6 |
| [US-613](phase-6-hardening-release.md#us-613---full-evaluation-run-with-ablations) Full evaluation run with ablations | [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) Iterative refinement loop controller | PH5 | Sprint 10 |
| [US-615](phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g) Scripted evaluation scenarios A-G | [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) Revision mode for incremental natural-language edits | PH4 | Sprint 8 |
| [US-615](phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g) Scripted evaluation scenarios A-G | [US-503](phase-5-advanced-autonomy.md#us-503---component-generation-pipeline-generate-check-compile-test-render) Component generation pipeline (generate, check, compile, test render) | PH5 | Sprint 9 |
| [US-615](phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g) Scripted evaluation scenarios A-G | [US-510](phase-5-advanced-autonomy.md#us-510---component-acquisition-from-package-registries) Component acquisition from package registries | PH5 | Sprint 10 |
| [US-615](phase-6-hardening-release.md#us-615---scripted-evaluation-scenarios-a-g) Scripted evaluation scenarios A-G | [US-513](phase-5-advanced-autonomy.md#us-513---iterative-refinement-loop-controller) Iterative refinement loop controller | PH5 | Sprint 10 |
| [US-616](phase-6-hardening-release.md#us-616---architecture-and-developer-documentation-with-required-diagrams) Architecture and developer documentation with required diagrams | [US-103](phase-1-foundation.md#us-103---architecture-baseline-module-boundaries-and-adrs) Architecture baseline, module boundaries and ADRs | PH1 | Sprint 1 |
| [US-617](phase-6-hardening-release.md#us-617---user-manual-and-api-documentation) User manual and API documentation | [US-526](phase-5-advanced-autonomy.md#us-526---dashboard-overview) Dashboard overview | PH5 | Sprint 10 |

### Same-sprint sequencing (everything else in a sprint runs in parallel)

- Sprint 11: US-610 -> US-612 Tool SDK, component and provider authoring guide
- Sprint 12: US-613 -> US-614 Human acceptance study
- Sprint 12: US-618 -> US-619 Fresh deployment verification and bootstrap script
- Sprint 12: US-619 -> US-620 Release freeze v1.0-graduation
- Sprint 12: US-615, US-620 -> US-621 Graduation demo preparation and rehearsal

## 8. Sprint allocation

| Sprint | Sprint goal | Stories | SP | AI | MM | GEN | BE | FE | OPS | ALL |
|---|---|---|---|---|---|---|---|---|---|---|
| [Sprint 11](../sprints.md#sprint-11) | Harden security, performance and observability, prove extensibility with a plugin-only addition, and stabilize the release candidate. | US-601, US-602, US-603, US-604, US-605, US-606, US-607, US-608, US-609, US-610, US-612, US-611 | 48 | 6 | 3 | 11 | 10 | 5 | 8 | 5 |
| [Sprint 12](../sprints.md#sprint-12) | Evaluate the system scientifically, finish documentation, freeze v1.0-graduation, verify a fresh deployment and rehearse the graduation demo. | US-613, US-614, US-615, US-616, US-617, US-618, US-619, US-620, US-621 | 32 | 5 | 5 | 0 | 5 | 6 | 6 | 5 |

## 9. Deliverables

- Security test suite, ASVS checklist, red-team reports for prompt injection and sandbox, and fixed findings
- GPU model pooling, parallel analysis DAG, incremental rendering and performance benchmarks with budgets
- Metrics, tracing, dashboards, error tracking and the agent run inspector
- Extensibility proof (new tool, LLM provider and component added as plugins only) and authoring guide
- Full evaluation report with ablations and human acceptance study
- Scripted scenarios A-G with recorded runs
- Architecture, developer, API, Tool SDK, agent, security, testing and deployment documentation, user manual and all required diagrams
- Fresh-deployment bootstrap, v1.0-graduation tag with release notes and SBOM, rehearsed demo

## 10. Definition of Done

The phase is done when all of the following hold (in addition to the story-level DoD for every story):

- [ ] Checkpoint CP6 and milestones M6 and M7 met
- [ ] Zero open critical or high security findings; zero open P0 or P1 defects
- [ ] Performance budgets hold in the nightly benchmark for 3 consecutive nights
- [ ] Every required document and diagram from the original plan exists, is reviewed and is linked from the README
- [ ] A person outside the team deploys the system from the README on a clean machine without help
- [ ] v1.0-graduation images are pinned by digest and the release is reproducible from the tag
- [ ] The graduation demo runs live end-to-end with a recorded backup of every scenario

### Milestone exit criteria

**CP6 - Security and Performance Gate** (end of Sprint 11)

- [ ] No open critical or high vulnerabilities in code, dependencies or images
- [ ] Prompt-injection and sandbox red-team findings fixed or formally accepted
- [ ] A 10-minute source becomes a 45-second reel in at most 15 minutes (p95) on the reference GPU

**M6 - Release Candidate - v1.0-rc1** (end of Sprint 11)

- [ ] No open P0/P1 defects; E2E, integration and evaluation suites green
- [ ] Dashboards and agent run inspector available on staging

**M7 - v1.0-graduation Release and Demo** (end of Sprint 12)

- [ ] Fresh deployment from a clean machine succeeds using only documented steps
- [ ] Evaluation report, documentation set and diagrams complete
- [ ] v1.0-graduation tagged; demo rehearsed twice with recorded backups
