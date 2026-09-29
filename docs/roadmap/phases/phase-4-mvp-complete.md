<!-- GENERATED FILE - do not edit by hand. Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->

# PH4 - MVP Completion - Generative Editing, Design System and Interactive Workspace

| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |
|---|---|---|---|---|---|
| Sprint 7, Sprint 8 | Weeks 13-16 | v0.9-mvp "MVP Complete" | mvp | 101 SP (25 stories, 1 stretch) | CP4 Render Budget, M4 MVP Complete - v0.9-mvp |

[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | [Dependencies](../dependencies.md) | [Milestones](../milestones.md)

## 1. Objective

Close the MVP boundary. Motion graphics come from a plugin-based Remotion component library, visual output is consistent through a font registry, creative memory and creativity levels, background music and basic B-roll come from a unified local asset registry with semantic search, and the agent reviews its own render with deterministic checks and one automatic refinement pass. Users preview edits in the browser and modify an existing project through natural language, producing new versions instead of re-editing from zero. Workers are hardened with resource limits. Covers the MVP parts of original Phases 7, 8, 9, 11, 13, 15, 17 and 31.

## 2. Epics

| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |
|---|---|---|---|---|---|
| [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system) Remotion Component Library and Plugin System | Give the agent a growing, schema-described library of motion graphics that can be extended without changing the agent. | S7, S8 | 16 | [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine), [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools) | [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview) |
| [EP-19](phase-4-mvp-complete.md#ep-19---fonts-and-design-system) Fonts and Design System | Keep typography and style consistent, script-aware and under user control. | S7 | 19 | [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-12](phase-2-perception-editing-core.md#ep-12---editing-tool-sdk-and-media-operations), [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop) | [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview), [EP-23](phase-4-mvp-complete.md#ep-23---platform-hardening-and-pipeline-maturity) |
| [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll) Asset Registry and Basic B-roll | Provide licensed, searchable assets so the agent can add music, sound and B-roll safely. | S7, S8 | 18 | [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine), [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools) | [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system), [EP-19](phase-4-mvp-complete.md#ep-19---fonts-and-design-system), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview), [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0) |
| [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview) Conversational Editing and Preview | Let users refine an existing edit through natural language and preview it instantly. | S7, S8 | 18 | [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop), [EP-16](phase-3-agent-mvp-alpha.md#ep-16---mvp-web-experience), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis), [EP-10](phase-2-perception-editing-core.md#ep-10---editing-project-model), [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine) | [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system), [EP-19](phase-4-mvp-complete.md#ep-19---fonts-and-design-system), [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0), [EP-23](phase-4-mvp-complete.md#ep-23---platform-hardening-and-pipeline-maturity) |
| [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0) Basic Self-Review (Critic v0) | Let the agent detect objective problems in its own render and fix them once automatically. | S8 | 11 | [EP-15](phase-3-agent-mvp-alpha.md#ep-15---core-editing-tools), [EP-18](phase-4-mvp-complete.md#ep-18---remotion-component-library-and-plugin-system), [EP-14](phase-3-agent-mvp-alpha.md#ep-14---agent-orchestrator-and-decision-loop) | [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview) |
| [EP-23](phase-4-mvp-complete.md#ep-23---platform-hardening-and-pipeline-maturity) Platform Hardening and Pipeline Maturity | Make workers safe under hostile input and the pipeline efficient before advanced features add risk. | S7, S8 | 19 | [EP-05](phase-1-foundation.md#ep-05---asynchronous-job-processing), [EP-02](phase-1-foundation.md#ep-02---engineering-platform-and-developer-experience), [EP-04](phase-1-foundation.md#ep-04---media-ingestion-and-multimedia-core), [EP-06](phase-2-perception-editing-core.md#ep-06---speech-understanding), [EP-08](phase-2-perception-editing-core.md#ep-08---visual-understanding), [EP-09](phase-2-perception-editing-core.md#ep-09---unified-media-analysis), [EP-11](phase-2-perception-editing-core.md#ep-11---rendering-engine), [EP-17](phase-3-agent-mvp-alpha.md#ep-17---agent-safety-and-evaluation), [EP-20](phase-4-mvp-complete.md#ep-20---asset-registry-and-basic-b-roll), [EP-22](phase-4-mvp-complete.md#ep-22---basic-self-review-critic-v0) | [EP-19](phase-4-mvp-complete.md#ep-19---fonts-and-design-system), [EP-21](phase-4-mvp-complete.md#ep-21---conversational-editing-and-preview) |

## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria

Task tags: `TEST`, `DOC`, `CI/CD`, `SECURITY`, `INTEGRATION` mark testing, documentation, CI/CD, security and integration work that is built into the story itself. Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).

### EP-18 - Remotion Component Library and Plugin System

**Epic goal:** Give the agent a growing, schema-described library of motion graphics that can be extended without changing the agent.

#### FT-18.1 - Component Plugin Architecture

##### US-401 - Component manifest and plugin registry

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 7 | Generative Video / Remotion Engineer | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping), [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) | Parallel - can start on day 1 of the sprint |

**User story:** As an agent developer, I want every visual component described by a manifest and loaded as a plugin, so that new components are usable by the agent without modifying it.

**Technical tasks**

- [ ] `US-401-T1` Define ComponentManifest (name, version, category, props JSON Schema from zod, duration policy, supported aspect ratios, required fonts, capability tags, source builtin/external/generated, trust level, preview)
- [ ] `US-401-T2` Implement the ComponentRegistry and a Factory that instantiates components by name and version for the Remotion strategy
- [ ] `US-401-T3` Expose add_component and list_components as SDK tools with props validation
- [ ] `US-401-T4` Package built-in components as plugins discovered at startup
- [ ] `US-401-T5` `TEST` Test plugin registered in tests proves no core change is needed
- [ ] `US-401-T6` `DOC` Document the component authoring contract

**Acceptance criteria**

- [ ] AC1. A new component package with a valid manifest appears in list_components and renders with no change to agent, registry or strategy code
- [ ] AC2. Invalid props are rejected before rendering with the failing field named

#### FT-18.2 - Built-in Motion Graphics

##### US-402 - Motion graphics pack v1

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 7 | Generative Video / Remotion Engineer | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) | Sequential after US-401 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want animated keywords, lower thirds, callouts, progress bars and title animations, so that my videos look professionally produced.

**Technical tasks**

- [ ] `US-402-T1` Implement AnimatedText/KeywordPop, LowerThird, Callout (arrow and box), ProgressBar and TitleAnimation components
- [ ] `US-402-T2` Make every animation deterministic from the frame number (no wall-clock time or unseeded randomness)
- [ ] `US-402-T3` Accept brand tokens (fonts, colors) through props
- [ ] `US-402-T4` Add a preview gallery page rendering each component with sample props
- [ ] `US-402-T5` `TEST` Visual regression snapshots for each component in 9:16 and 16:9

**Acceptance criteria**

- [ ] AC1. Each component renders identically on repeated renders (deterministic)
- [ ] AC2. Each component supports at least 9:16 and 16:9 layouts

##### US-403 - Transitions pack

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 8 | Generative Video / Remotion Engineer | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want basic transitions between clips, so that cuts can be smoothed or emphasized when appropriate.

**Technical tasks**

- [ ] `US-403-T1` Implement crossfade, dip to black or white, slide and zoom-through transitions as transition plugins
- [ ] `US-403-T2` Expose add_transition with duration limits relative to clip lengths
- [ ] `US-403-T3` `TEST` Visual snapshot tests at transition midpoints

**Acceptance criteria**

- [ ] AC1. Transitions never extend beyond the adjoining clips
- [ ] AC2. Transition duration and type are recorded on the timeline

##### US-404 - Overlay, background and B-roll frame components

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P2 - Could (advanced) | 3 | Stretch | Generative Video / Remotion Engineer | [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) | Stretch backlog |

**User story:** As the agent, I want picture-in-picture, split-screen and animated background components, so that B-roll and multi-source layouts look polished.

**Technical tasks**

- [ ] `US-404-T1` Implement PictureInPicture, SplitScreen and AnimatedBackground components with props schemas
- [ ] `US-404-T2` Teach the B-roll skill to choose between full-frame cutaway and picture-in-picture
- [ ] `US-404-T3` `TEST` Visual snapshot tests for each layout

**Acceptance criteria**

- [ ] AC1. Each component renders in 9:16 and 16:9 with correct safe zones
- [ ] AC2. Components register through the plugin registry only

##### US-405 - Layout metadata emission for quality checks

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 8 | Generative Video / Remotion Engineer | [US-312](phase-3-agent-mvp-alpha.md#us-312---word-synchronized-caption-component), [US-402](phase-4-mvp-complete.md#us-402---motion-graphics-pack-v1) | Parallel - can start on day 1 of the sprint |

**User story:** As the critic, I want every rendered component to report the screen regions it occupies, so that text overflow, safe-zone violations and face obstruction can be checked automatically.

**Technical tasks**

- [ ] `US-405-T1` Compute bounding boxes of text and graphics per keyframe and emit them as layout metadata alongside the render
- [ ] `US-405-T2` Include measured text width versus container width to detect overflow
- [ ] `US-405-T3` `TEST` Tests with deliberately overflowing text and out-of-safe-zone placement

**Acceptance criteria**

- [ ] AC1. Layout metadata exists for every caption and component instance in a render
- [ ] AC2. The overflowing-text fixture is flagged by the metadata

### EP-19 - Fonts and Design System

**Epic goal:** Keep typography and style consistent, script-aware and under user control.

#### FT-19.1 - Font Management

##### US-406 - Font registry with metadata and validation

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 7 | Backend Engineer | [US-122](phase-1-foundation.md#us-122---object-storage-port-and-direct-upload) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to upload fonts and have their capabilities detected, so that the AI only uses fonts that support my language and style.

**Technical tasks**

- [ ] `US-406-T1` Accept TTF, OTF and WOFF2 uploads; sanitize with OpenType Sanitizer and reject malformed fonts
- [ ] `US-406-T2` Extract family, weights, styles, supported scripts (cmap coverage including Arabic), and license field; allow category tags (modern, clean, educational)
- [ ] `US-406-T3` Bundle default fonts (Cairo, Inter, Montserrat, Noto Sans Arabic as fallback)
- [ ] `US-406-T4` Serve fonts to the render worker and preview through signed URLs
- [ ] `US-406-T5` `TEST` Tests for metadata extraction, Arabic detection and malformed font rejection

**Acceptance criteria**

- [ ] AC1. Cairo is detected as supportsArabic with weights 400-900
- [ ] AC2. A malformed font is rejected and never reaches the renderer

##### US-407 - Agent font selection with glyph coverage checks

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 7 | AI / Agent Engineer | [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting), [US-406](phase-4-mvp-complete.md#us-406---font-registry-with-metadata-and-validation) | Sequential after US-406 (same sprint; contract-first stubs allowed) |

**User story:** As the agent, I want to choose fonts per role (captions, titles, keywords, metadata) from the project's allowed fonts, so that typography is readable and on-brand.

**Technical tasks**

- [ ] `US-407-T1` Add allowed fonts and roles to the agent context and a set_font_role tool
- [ ] `US-407-T2` Check glyph coverage of every text against the chosen font before rendering and apply the fallback chain
- [ ] `US-407-T3` `TEST` Tests for Arabic captions with an English-only font (fallback applied) and role assignment

**Acceptance criteria**

- [ ] AC1. No render contains missing-glyph boxes for supported scripts
- [ ] AC2. Arabic captions use an Arabic-capable font when one is allowed

##### US-408 - Font library and project font picker UI

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 7 | Frontend Engineer | [US-406](phase-4-mvp-complete.md#us-406---font-registry-with-metadata-and-validation) | Sequential after US-406 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to manage fonts and choose which ones the AI may use in a project, so that the result matches my taste.

**Technical tasks**

- [ ] `US-408-T1` Build the font library with previews in Latin and Arabic sample text
- [ ] `US-408-T2` Add project font selection with checkboxes and role hints
- [ ] `US-408-T3` `TEST` Component tests for upload, preview and selection

**Acceptance criteria**

- [ ] AC1. Only selected fonts are passed to the agent
- [ ] AC2. Font previews render the real font file

#### FT-19.2 - Creative Memory and Creativity Levels

##### US-409 - Project creative memory

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 7 | AI / Agent Engineer | [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want the AI to remember and reuse its style decisions across the whole project, so that sections do not look inconsistent.

**Technical tasks**

- [ ] `US-409-T1` Define the CreativeMemory schema (editing style, fonts per role, caption style, colors, zoom intensity, music volume, transition style, pacing, aspect ratio, user preferences)
- [ ] `US-409-T2` Write decisions to memory through a dedicated tool and include memory in every context
- [ ] `US-409-T3` Validate new tool calls against memory (for example zoom intensity within tolerance) and warn the agent on deviations
- [ ] `US-409-T4` Update memory when the user changes style through chat or settings
- [ ] `US-409-T5` `TEST` Tests proving consistent caption style and zoom intensity across a long edit

**Acceptance criteria**

- [ ] AC1. Given a 3-section edit, caption style and zoom intensity are identical across sections unless the user asks otherwise
- [ ] AC2. Memory is persisted with the project version

##### US-410 - Creativity level policy enforcement

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 7 | AI / Agent Engineer | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation), [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to choose Conservative, Balanced or Creative, so that the AI only takes the amount of creative freedom I allow.

**Technical tasks**

- [ ] `US-410-T1` Define a CreativityPolicy mapping each level to allowed tool capabilities, component categories and asset sources
- [ ] `US-410-T2` Filter tools and components in the registry for the run, and reject disallowed calls in the executor
- [ ] `US-410-T3` Add level-specific prompt variants in the prompt registry
- [ ] `US-410-T4` `TEST` Tests that Conservative runs cannot add motion graphics or B-roll

**Acceptance criteria**

- [ ] AC1. A Conservative run only uses cleanup, cut, caption and audio tools
- [ ] AC2. Disallowed tool calls are rejected by the executor, not only discouraged in the prompt

### EP-20 - Asset Registry and Basic B-roll

**Epic goal:** Provide licensed, searchable assets so the agent can add music, sound and B-roll safely.

#### FT-20.1 - Unified Asset Registry

##### US-411 - Unified local asset registry with starter packs

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 7 | Backend Engineer | [US-122](phase-1-foundation.md#us-122---object-storage-port-and-direct-upload) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want one registry for music, sound effects, B-roll, images, icons, LUTs and templates with licenses, so that I can find and legally use assets.

**Technical tasks**

- [ ] `US-411-T1` Model Asset with category, tags, technical metadata, license (SPDX or named license, attribution text), source, content hash and trust level
- [ ] `US-411-T2` Define the IAssetProvider port with a LocalAssetProvider implementation (internet providers plug in later)
- [ ] `US-411-T3` Import starter packs (at least 15 music tracks with mood and BPM, 20 SFX, 50 B-roll clips, icon set)
- [ ] `US-411-T4` `TEST` Tests for import, deduplication by hash and license filtering

**Acceptance criteria**

- [ ] AC1. Every asset has a license and source; assets without a license cannot be imported
- [ ] AC2. A second import of the same file is deduplicated

##### US-412 - Semantic asset search

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 8 | Backend Engineer | [US-411](phase-4-mvp-complete.md#us-411---unified-local-asset-registry-with-starter-packs) | Parallel - can start on day 1 of the sprint |

**User story:** As the agent, I want to search assets by meaning, so that I find relevant B-roll and music for what is being said.

**Technical tasks**

- [ ] `US-412-T1` Compute text embeddings for tags and descriptions and CLIP embeddings for visual assets; store in pgvector
- [ ] `US-412-T2` Implement search_assets with query, category, orientation, duration and license filters
- [ ] `US-412-T3` `TEST` Relevance tests on a labelled query set (top-5 precision)

**Acceptance criteria**

- [ ] AC1. Top-5 precision is at least 0.6 on the labelled query set
- [ ] AC2. Filters are always applied (for example no landscape clips for a 9:16 search when strict orientation is requested)

#### FT-20.2 - Asset Usage in Edits

##### US-413 - Basic B-roll insertion

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 8 | Generative Video / Remotion Engineer | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping), [US-412](phase-4-mvp-complete.md#us-412---semantic-asset-search) | Sequential after US-412 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want relevant B-roll inserted where it supports what I say, so that the video is more engaging.

**Technical tasks**

- [ ] `US-413-T1` Identify B-roll opportunities from transcript topics and keywords
- [ ] `US-413-T2` Search assets, choose clips and place them on the overlay track with duration rules (2-4 seconds) and Ken Burns for images
- [ ] `US-413-T3` Avoid covering the hook and face-critical moments; respect creativity level
- [ ] `US-413-T4` `TEST` Scenario tests with recorded cassettes; visual check that the hook is not covered

**Acceptance criteria**

- [ ] AC1. B-roll appears only on the overlay track and never during the first 3 seconds of the hook
- [ ] AC2. Every inserted asset is licensed and credited in the project credits

##### US-414 - Music selection from the registry

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 8 | Multimedia Engineer | [US-314](phase-3-agent-mvp-alpha.md#us-314---audio-normalization-music-and-ducking-tools), [US-411](phase-4-mvp-complete.md#us-411---unified-local-asset-registry-with-starter-packs) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want background music that fits the mood of my video, so that I do not need to find music myself.

**Technical tasks**

- [ ] `US-414-T1` Add a select_music tool choosing by mood tags, BPM range and duration
- [ ] `US-414-T2` Loop or trim with musically clean fades and apply ducking from US-314
- [ ] `US-414-T3` `TEST` Integration test verifying length, fades and ducking levels

**Acceptance criteria**

- [ ] AC1. The selected track covers the full video with no abrupt start or end
- [ ] AC2. The chosen track's license and attribution are recorded

### EP-21 - Conversational Editing and Preview

**Epic goal:** Let users refine an existing edit through natural language and preview it instantly.

#### FT-21.1 - Conversational Revision

##### US-415 - Revision mode for incremental natural-language edits

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 8 | AI / Agent Engineer | [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history), [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to say "make the captions larger" or "remove the part where I talk about pricing", so that the AI changes only what I asked instead of redoing the whole edit.

**Technical tasks**

- [ ] `US-415-T1` Add a revision planner that outputs a minimal command set against the current timeline, never a full rebuild
- [ ] `US-415-T2` Resolve references to time ("at second 21"), content (transcript search for "pricing") and elements (captions, B-roll, music)
- [ ] `US-415-T3` Apply commands through the CommandBus as a new project version and summarize the change
- [ ] `US-415-T4` `TEST` Test set with the five canonical utterances from the plan plus 10 more, asserting the resulting diff

**Acceptance criteria**

- [ ] AC1. Each canonical utterance changes only the targeted elements (verified by timeline diff)
- [ ] AC2. Every revision creates a new version that can be undone in one step

##### US-416 - AI chat panel in the editing workspace

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 8 | Frontend Engineer | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api), [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) | Sequential after US-415 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want to chat with the editor next to the preview, so that refining the video feels like talking to a human editor.

**Technical tasks**

- [ ] `US-416-T1` Build a chat panel with streaming responses, applied-change summaries and per-change undo
- [ ] `US-416-T2` Link mentioned timecodes to the player
- [ ] `US-416-T3` `TEST` Component tests and an E2E revision scenario with a recorded cassette

**Acceptance criteria**

- [ ] AC1. A revision request updates the preview without leaving the page
- [ ] AC2. Each applied change can be undone from the chat

#### FT-21.2 - Version History

##### US-417 - Version history with undo, redo and restore

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 8 | Backend Engineer | [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to see and restore earlier versions, so that experimenting with the AI is safe.

**Technical tasks**

- [ ] `US-417-T1` Store immutable project versions with author (user or agent run) and change summary
- [ ] `US-417-T2` Expose list, diff summary, restore, undo and redo endpoints backed by the command log
- [ ] `US-417-T3` `TEST` Integration tests for restore and undo across agent and user changes

**Acceptance criteria**

- [ ] AC1. Restoring a version reproduces its timeline exactly
- [ ] AC2. Undo and redo work across agent and user changes in order

#### FT-21.3 - In-Browser Preview

##### US-418 - In-browser preview with the Remotion Player

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 7 | Frontend Engineer | [US-211](phase-2-perception-editing-core.md#us-211---frame-accurate-video-player-component), [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator, I want to preview the current edit instantly in the browser, so that I do not wait for a render to see changes.

**Technical tasks**

- [ ] `US-418-T1` Embed the Remotion Player using the same composition and component registry as the render worker
- [ ] `US-418-T2` Stream proxy media and fonts through signed URLs
- [ ] `US-418-T3` Keep the preview in sync with project versions
- [ ] `US-418-T4` `TEST` E2E test comparing preview frames with rendered frames at fixed timestamps

**Acceptance criteria**

- [ ] AC1. Preview and final render match at sampled frames (within the visual regression threshold)
- [ ] AC2. A new project version updates the preview within 2 seconds

### EP-22 - Basic Self-Review (Critic v0)

**Epic goal:** Let the agent detect objective problems in its own render and fix them once automatically.

#### FT-22.1 - Deterministic Quality Checks

##### US-419 - Deterministic render quality checks

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 8 | Multimedia Engineer | [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation), [US-405](phase-4-mvp-complete.md#us-405---layout-metadata-emission-for-quality-checks) | Sequential after US-405 (same sprint; contract-first stubs allowed) |

**User story:** As the agent, I want an automatic quality report for every render, so that obvious defects are caught before the user sees them.

**Technical tasks**

- [ ] `US-419-T1` Detect black and frozen frames (blackdetect, freezedetect), loudness and true-peak violations, duration and resolution mismatch
- [ ] `US-419-T2` Use layout metadata to detect caption overflow, safe-zone violations and captions covering faces
- [ ] `US-419-T3` Check caption minimum duration and reading speed
- [ ] `US-419-T4` Output a QualityReport (issue type, severity, time range, evidence, suggested fix) in packages/schemas
- [ ] `US-419-T5` `TEST` Fixture renders with injected defects, one per check

**Acceptance criteria**

- [ ] AC1. Each injected defect is reported with the correct type and time range
- [ ] AC2. A clean render produces no errors

##### US-420 - Frame sampling and contact sheets

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 8 | Multimedia Engineer | [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) | Parallel - can start on day 1 of the sprint |

**User story:** As the critic, I want contact sheets and keyframes around every edit point, so that visual review is efficient for humans and multimodal models.

**Technical tasks**

- [ ] `US-420-T1` Sample frames at cut points, component entrances and fixed intervals from renders
- [ ] `US-420-T2` Compose timestamped contact sheets and store them with the render
- [ ] `US-420-T3` `TEST` Tests for sampling positions and sheet layout

**Acceptance criteria**

- [ ] AC1. Every cut point has a frame before and after it in the contact sheet
- [ ] AC2. Contact sheets are available through the render API

#### FT-22.2 - Single Refinement Pass

##### US-421 - Automatic single refinement pass

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 8 | AI / Agent Engineer | [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling), [US-419](phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks) | Sequential after US-419 (same sprint; contract-first stubs allowed) |

**User story:** As a creator, I want the AI to fix problems it finds in its own render, so that I receive a clean result.

**Technical tasks**

- [ ] `US-421-T1` Map QualityReport issues to fix strategies (resize caption, move caption, renormalize audio, trim black frames)
- [ ] `US-421-T2` Apply fixes as commands, re-render and re-check once (configurable iteration limit, default 1)
- [ ] `US-421-T3` Record before and after reports in the audit trail
- [ ] `US-421-T4` `TEST` Scenario test with an injected caption overflow that is fixed automatically

**Acceptance criteria**

- [ ] AC1. The injected caption overflow and loudness issues are absent from the refined render
- [ ] AC2. The loop never exceeds the configured iteration limit

### EP-23 - Platform Hardening and Pipeline Maturity

**Epic goal:** Make workers safe under hostile input and the pipeline efficient before advanced features add risk.

#### FT-23.1 - Execution Isolation

##### US-422 - Hardened, resource-limited worker containers

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 5 | Sprint 8 | DevOps & QA (shared) | [US-114](phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration), [US-127](phase-1-foundation.md#us-127---media-validation-and-hostile-file-defense) | Parallel - can start on day 1 of the sprint |

**User story:** As the security owner, I want every worker isolated with strict resource limits, so that a malicious or runaway job cannot affect the host or other jobs.

**Technical tasks**

- [ ] `US-422-T1` `SECURITY` Run workers non-root with read-only root filesystems, dropped capabilities and the default seccomp profile
- [ ] `US-422-T2` `SECURITY` Apply CPU, memory, pid and disk quotas per job with per-job temporary directories
- [ ] `US-422-T3` `SECURITY` Deny network egress for media and render workers except object storage
- [ ] `US-422-T4` `TEST` Tests with a decompression-bomb style input, a fork-heavy filter and an outbound connection attempt

**Acceptance criteria**

- [ ] AC1. Resource-abuse tests are terminated by limits without affecting other jobs
- [ ] AC2. Outbound connections from media and render workers fail

#### FT-23.2 - Pipeline Efficiency and Perception Upgrades

##### US-423 - Analysis caching by media fingerprint

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 3 | Sprint 7 | Multimedia Engineer | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation) | Parallel - can start on day 1 of the sprint |

**User story:** As the platform, I want identical footage to reuse existing analysis, so that repeated uploads and re-runs cost nothing.

**Technical tasks**

- [ ] `US-423-T1` Compute content fingerprints (SHA-256 of streams) and key analysis results by fingerprint plus analyzer version and parameters
- [ ] `US-423-T2` Reuse results on match; invalidate when analyzer versions change
- [ ] `US-423-T3` `TEST` Tests for hit, miss and version invalidation

**Acceptance criteria**

- [ ] AC1. Re-uploading the same file completes analysis without running any analyzer
- [ ] AC2. Changing an analyzer version triggers re-analysis for that analyzer only

##### US-424 - Active speaker detection

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P1 - Should | 5 | Sprint 7 | Multimedia Engineer | [US-202](phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation), [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) | Parallel - can start on day 1 of the sprint |

**User story:** As a creator editing a podcast, I want the frame to follow whoever is speaking, so that vertical reframing works for multi-person footage.

**Technical tasks**

- [ ] `US-424-T1` Correlate speech regions with face tracks using mouth-motion features or a pretrained active speaker model
- [ ] `US-424-T2` Output speaker-to-track assignments over time in the analysis document
- [ ] `US-424-T3` Use active speaker tracks in reframe_video when more than one face is present
- [ ] `US-424-T4` `TEST` Two-speaker fixture test for assignment accuracy

**Acceptance criteria**

- [ ] AC1. Active speaker accuracy is at least 80 percent on the two-speaker fixture
- [ ] AC2. Reframing switches subjects no more often than the configured minimum shot length

#### FT-23.3 - MVP Quality Assurance

##### US-425 - Visual regression testing for components and renders

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 7 | DevOps & QA (shared) | [US-216](phase-2-perception-editing-core.md#us-216---remotion-render-worker) | Parallel - can start on day 1 of the sprint |

**User story:** As the team, I want automatic visual comparison of rendered frames, so that component changes cannot silently break the look of videos.

**Technical tasks**

- [ ] `US-425-T1` `CI/CD` Render reference frames for every component and fixture timeline and compare with a perceptual diff threshold
- [ ] `US-425-T2` `CI/CD` Publish diff images as CI artifacts and allow reviewed baseline updates
- [ ] `US-425-T3` `DOC` Document how to update baselines

**Acceptance criteria**

- [ ] AC1. A deliberate one-pixel-line change is detected and a harmless re-encode is not
- [ ] AC2. Baselines can only be updated through a reviewed pull request

##### US-426 - MVP evaluation report and human acceptance pilot

| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |
|---|---|---|---|---|---|
| P0 - Must (MVP-critical) | 3 | Sprint 8 | DevOps & QA (shared) | [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0), [US-413](phase-4-mvp-complete.md#us-413---basic-b-roll-insertion), [US-421](phase-4-mvp-complete.md#us-421---automatic-single-refinement-pass) | Sequential after US-413, US-421 (same sprint; contract-first stubs allowed) |

**User story:** As the product owner, I want an evaluation of the complete MVP against the dataset and human raters, so that the mid-project review is based on evidence.

**Technical tasks**

- [ ] `US-426-T1` `TEST` Run the harness on all dataset videos with the MVP prompts
- [ ] `US-426-T2` Run a pilot acceptance study with at least 3 raters on 6 videos and record manual corrections needed
- [ ] `US-426-T3` `DOC` Publish the MVP evaluation report with metrics, failures and next actions

**Acceptance criteria**

- [ ] AC1. The report covers every MVP capability with at least one metric
- [ ] AC2. Findings are turned into backlog items before Sprint 9 planning

## 7. Dependencies

### Phase-level

- Depends on [PH3](phase-3-agent-mvp-alpha.md) Autonomous Editor Agent - MVP Alpha.
- The component registry (US-401) extends the component factory from US-217 and the tool registry from US-219 (Open/Closed - no agent change needed to add components).
- Conversational editing (US-415) depends on command history (US-215) and the agent loop (US-305).
- External - licensed starter packs for music, SFX, B-roll and icons (CC0 or equivalent) must be sourced before Sprint 7.
- Hardened containers (US-422) are the base layer for the PH5 sandbox (US-501).
- Unblocks [PH5](phase-5-advanced-autonomy.md) Advanced Autonomy - Self-Expanding and Creative Editor.

### Cross-phase story dependencies (inputs from earlier phases)

| Story | Needs | From phase | Ready by |
|---|---|---|---|
| [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) Component manifest and plugin registry | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-401](phase-4-mvp-complete.md#us-401---component-manifest-and-plugin-registry) Component manifest and plugin registry | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | PH2 | Sprint 4 |
| [US-405](phase-4-mvp-complete.md#us-405---layout-metadata-emission-for-quality-checks) Layout metadata emission for quality checks | [US-312](phase-3-agent-mvp-alpha.md#us-312---word-synchronized-caption-component) Word-synchronized caption component | PH3 | Sprint 5 |
| [US-406](phase-4-mvp-complete.md#us-406---font-registry-with-metadata-and-validation) Font registry with metadata and validation | [US-122](phase-1-foundation.md#us-122---object-storage-port-and-direct-upload) Object storage port and direct upload | PH1 | Sprint 1 |
| [US-407](phase-4-mvp-complete.md#us-407---agent-font-selection-with-glyph-coverage-checks) Agent font selection with glyph coverage checks | [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) Agent context builder with token budgeting | PH3 | Sprint 5 |
| [US-409](phase-4-mvp-complete.md#us-409---project-creative-memory) Project creative memory | [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) Agent context builder with token budgeting | PH3 | Sprint 5 |
| [US-410](phase-4-mvp-complete.md#us-410---creativity-level-policy-enforcement) Creativity level policy enforcement | [US-219](phase-2-perception-editing-core.md#us-219---tool-manifest-registry-and-schema-validation) Tool manifest, registry and schema validation | PH2 | Sprint 4 |
| [US-410](phase-4-mvp-complete.md#us-410---creativity-level-policy-enforcement) Creativity level policy enforcement | [US-304](phase-3-agent-mvp-alpha.md#us-304---agent-context-builder-with-token-budgeting) Agent context builder with token budgeting | PH3 | Sprint 5 |
| [US-411](phase-4-mvp-complete.md#us-411---unified-local-asset-registry-with-starter-packs) Unified local asset registry with starter packs | [US-122](phase-1-foundation.md#us-122---object-storage-port-and-direct-upload) Object storage port and direct upload | PH1 | Sprint 1 |
| [US-413](phase-4-mvp-complete.md#us-413---basic-b-roll-insertion) Basic B-roll insertion | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-414](phase-4-mvp-complete.md#us-414---music-selection-from-the-registry) Music selection from the registry | [US-314](phase-3-agent-mvp-alpha.md#us-314---audio-normalization-music-and-ducking-tools) Audio normalization, music and ducking tools | PH3 | Sprint 6 |
| [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) Revision mode for incremental natural-language edits | [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history) Edit commands with undo, redo and replayable history | PH2 | Sprint 3 |
| [US-415](phase-4-mvp-complete.md#us-415---revision-mode-for-incremental-natural-language-edits) Revision mode for incremental natural-language edits | [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) Observe-plan-act loop with validated tool calling | PH3 | Sprint 5 |
| [US-416](phase-4-mvp-complete.md#us-416---ai-chat-panel-in-the-editing-workspace) AI chat panel in the editing workspace | [US-306](phase-3-agent-mvp-alpha.md#us-306---agent-event-stream-and-audit-trail-api) Agent event stream and audit trail API | PH3 | Sprint 6 |
| [US-417](phase-4-mvp-complete.md#us-417---version-history-with-undo-redo-and-restore) Version history with undo, redo and restore | [US-215](phase-2-perception-editing-core.md#us-215---edit-commands-with-undo-redo-and-replayable-history) Edit commands with undo, redo and replayable history | PH2 | Sprint 3 |
| [US-418](phase-4-mvp-complete.md#us-418---in-browser-preview-with-the-remotion-player) In-browser preview with the Remotion Player | [US-211](phase-2-perception-editing-core.md#us-211---frame-accurate-video-player-component) Frame-accurate video player component | PH2 | Sprint 3 |
| [US-418](phase-4-mvp-complete.md#us-418---in-browser-preview-with-the-remotion-player) In-browser preview with the Remotion Player | [US-217](phase-2-perception-editing-core.md#us-217---timeline-to-remotion-composition-mapping) Timeline to Remotion composition mapping | PH2 | Sprint 4 |
| [US-419](phase-4-mvp-complete.md#us-419---deterministic-render-quality-checks) Deterministic render quality checks | [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) Preview and final render profiles with output validation | PH3 | Sprint 6 |
| [US-420](phase-4-mvp-complete.md#us-420---frame-sampling-and-contact-sheets) Frame sampling and contact sheets | [US-315](phase-3-agent-mvp-alpha.md#us-315---preview-and-final-render-profiles-with-output-validation) Preview and final render profiles with output validation | PH3 | Sprint 6 |
| [US-421](phase-4-mvp-complete.md#us-421---automatic-single-refinement-pass) Automatic single refinement pass | [US-305](phase-3-agent-mvp-alpha.md#us-305---observe-plan-act-loop-with-validated-tool-calling) Observe-plan-act loop with validated tool calling | PH3 | Sprint 5 |
| [US-422](phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) Hardened, resource-limited worker containers | [US-114](phase-1-foundation.md#us-114---docker-compose-environment-with-typed-configuration) Docker Compose environment with typed configuration | PH1 | Sprint 1 |
| [US-422](phase-4-mvp-complete.md#us-422---hardened-resource-limited-worker-containers) Hardened, resource-limited worker containers | [US-127](phase-1-foundation.md#us-127---media-validation-and-hostile-file-defense) Media validation and hostile-file defense | PH1 | Sprint 2 |
| [US-423](phase-4-mvp-complete.md#us-423---analysis-caching-by-media-fingerprint) Analysis caching by media fingerprint | [US-210](phase-2-perception-editing-core.md#us-210---analysis-orchestration-and-aggregation) Analysis orchestration and aggregation | PH2 | Sprint 3 |
| [US-424](phase-4-mvp-complete.md#us-424---active-speaker-detection) Active speaker detection | [US-202](phase-2-perception-editing-core.md#us-202---voice-activity-detection-and-speech-segmentation) Voice activity detection and speech segmentation | PH2 | Sprint 3 |
| [US-424](phase-4-mvp-complete.md#us-424---active-speaker-detection) Active speaker detection | [US-207](phase-2-perception-editing-core.md#us-207---face-detection-and-tracking) Face detection and tracking | PH2 | Sprint 4 |
| [US-425](phase-4-mvp-complete.md#us-425---visual-regression-testing-for-components-and-renders) Visual regression testing for components and renders | [US-216](phase-2-perception-editing-core.md#us-216---remotion-render-worker) Remotion render worker | PH2 | Sprint 3 |
| [US-426](phase-4-mvp-complete.md#us-426---mvp-evaluation-report-and-human-acceptance-pilot) MVP evaluation report and human acceptance pilot | [US-320](phase-3-agent-mvp-alpha.md#us-320---evaluation-harness-v0) Evaluation harness v0 | PH3 | Sprint 6 |

### Same-sprint sequencing (everything else in a sprint runs in parallel)

- Sprint 7: US-401 -> US-402 Motion graphics pack v1
- Sprint 7: US-406 -> US-407 Agent font selection with glyph coverage checks
- Sprint 7: US-406 -> US-408 Font library and project font picker UI
- Sprint 8: US-412 -> US-413 Basic B-roll insertion
- Sprint 8: US-415 -> US-416 AI chat panel in the editing workspace
- Sprint 8: US-405 -> US-419 Deterministic render quality checks
- Sprint 8: US-419 -> US-421 Automatic single refinement pass
- Sprint 8: US-413, US-421 -> US-426 MVP evaluation report and human acceptance pilot

## 8. Sprint allocation

| Sprint | Sprint goal | Stories | SP | AI | MM | GEN | BE | FE | OPS | ALL |
|---|---|---|---|---|---|---|---|---|---|---|
| [Sprint 7](../sprints.md#sprint-7) | Make the agent's output professional and consistent - plugin-based Remotion component library, font registry with Arabic support, creative memory, creativity levels and in-browser preview. | US-401, US-402, US-406, US-407, US-408, US-409, US-410, US-411, US-418, US-423, US-424, US-425 | 50 | 11 | 8 | 10 | 10 | 8 | 3 | 0 |
| [Sprint 8](../sprints.md#sprint-8) | Close the MVP boundary - basic B-roll and music from the asset registry, basic self-review with one automatic refinement pass, conversational edits of an existing project, and hardened workers. | US-403, US-405, US-412, US-413, US-414, US-415, US-416, US-417, US-419, US-420, US-421, US-422, US-426 | 51 | 8 | 11 | 11 | 8 | 5 | 8 | 0 |

Stretch backlog (pulled in only if capacity allows): US-404

## 9. Deliverables

- Component manifest and plugin registry with built-in motion graphics and transitions packs
- Layout metadata emitted by components for automated quality checks
- Font registry with Arabic-aware selection and glyph coverage checks; fonts library UI
- Project creative memory and creativity levels (Conservative, Balanced, Creative)
- Unified local asset registry with semantic search, B-roll insertion and music selection
- Conversational revision mode, AI chat panel, version history with undo/redo
- In-browser preview with the Remotion Player
- Critic v0 deterministic quality checks, contact sheets and a single automatic refinement pass
- Hardened worker containers, analysis caching by fingerprint, active speaker detection
- Visual regression tests for components and the MVP evaluation report

## 10. Definition of Done

The phase is done when all of the following hold (in addition to the story-level DoD for every story):

- [ ] Milestone M4 met - every capability in the original MVP boundary works end-to-end and v0.9-mvp is tagged
- [ ] Checkpoint CP4 render budget met and visual regression suite green in CI
- [ ] Adding a new built-in component requires only a new plugin package with a manifest (verified by a test plugin)
- [ ] Creativity levels are enforced by tool and component filtering in code, not only by prompt wording
- [ ] All workers run non-root with CPU, memory, pid and time limits and no network egress except storage
- [ ] Identical footage is never analysed twice for the same analyzer version
- [ ] MVP evaluation report presented at the mid-project academic review

### Milestone exit criteria

**CP4 - Render Budget** (end of Sprint 7)

- [ ] 60-second 1080p render with captions and motion graphics completes in at most 3 minutes on the reference machine
- [ ] Visual regression suite for built-in components is green in CI

**M4 - MVP Complete - v0.9-mvp** (end of Sprint 8)

- [ ] Every capability in the MVP boundary works end-to-end on talking-head, podcast and educational footage
- [ ] Basic self-review detects and fixes at least caption overflow, loudness and black-frame issues
- [ ] Conversational edits modify the existing project and create a new version
- [ ] Mid-project academic review held with the MVP evaluation report
