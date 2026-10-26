# US-301 / US-305 — controlled provider and editing loop

Issue [#87](https://github.com/mahmoudemad68/Your_Editor/issues/87) is one integrated
development batch. This document records its design and risk matrix; executable
qualification and exact-head receipts must establish implementation claims.

## Scope and dependency boundary

Production API admission and the normal agent-worker remain infrastructure-only:
`PLANNER_NOT_CONFIGURED`. No request body, environment provider URL, replay flag or
tool payload enables planning through production composition. A separately invoked
controlled replay worker exercises the same queue, PostgreSQL, context and tool
execution path in isolated non-production qualification. No hosted call, key request,
paid inference or production enablement is authorized.

The executable scope is original-source observation, validated trim/split plans,
fenced timeline command effects, existing render-job orchestration and verified MP4
output. Full US-305 AC1 (remove silences and add captions) remains
`NOT_MET_DEPENDENCY`: US-312/313 and US-309/US-223 are unavailable. CP1 remains
NOT_VERIFIED, CP2 NOT_MET and Tiny Arabic NOT_QUALIFIED. Unsupported requested
capabilities must stop explicitly before effects; they are not silently substituted.

## As-built reuse and implementation gap

Reuse `PostgresAgentRuns` and BullMQ outbox/delivery, five-second leases, generation
and membership fences, `beginStep`/`finishStep`, immutable original Timeline,
`PostgresAgentContextSource`, pinned `PromptRegistry`, canonical trim/split manifests,
stable ToolExecutor identities, existing render service, authenticated audit/SSE and
paginated command export. Provider ports, protocol adapters, bounded planning,
provider receipts and render integration are new in this batch.

## Design and risk matrix

| Area                 | Design / invariant                                                                                                                         | Required qualification                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Provider interface   | Segregated chat, tools, structured and vision ports; declared capabilities and versioned model/config/pricing provenance                   | Same supported-subset conformance for OpenAI-compatible, native Anthropic and deterministic replay |
| HTTP boundary        | Trusted endpoint allowlist, no caller URL, redirects refused, bounded body/deadline/retries; no network execution of model tools           | Local fake HTTP servers, SSRF/redirect/oversize/429/5xx/abort controls                             |
| Usage                | Distinguish provider-reported tokens, synthetic replay, estimates and unknown outcomes; never invent billed cost                           | Per-call durable receipts and exhaustion/adversarial cases                                         |
| Plan authority       | Strict versioned EditPlan, bound project/source/media/tool versions and dependency order; model data never grants authority                | Malformed, unavailable, foreign, injected and stale proposals reject                               |
| Durable effects      | Existing guarded ToolExecutor receipt and atomic Timeline/checkpoint transaction; uncertain intents fail closed                            | SIGKILL, duplicate delivery, revoked membership, cancellation and lease races                      |
| Contract evolution   | Additive migration and versioned controlled-loop views/events; historical v1 receipts remain unchanged, including factual no-LLM decisions | v1/vNext parsing, authorized audit/SSE/export replay and API compatibility                         |
| Bounded loop         | Observe, plan, execute, render, validate actual output; bounded safe feedback and typed stop reasons                                       | Real PG/Redis/Tool SDK, retry/iteration/tool/token/cost/deadline controls                          |
| Render               | Trusted worker orchestration invokes existing rendering boundary; model has no render/storage/shell authority                              | Actual H.264/AAC file, frame/duration/audio checks and browser/API roundtrip                       |
| Production isolation | Normal worker and API never compose an executable planner                                                                                  | Packaged-image and production-denial regressions                                                   |
| Evidence             | Offline protocol/replay tests are not live model qualification; current prompts/outputs never logged or exported                           | Sanitized exact-head CI, Walking Skeleton and Supply Chain, file/hash inventory                    |

Owner and Security Reviewer were one person for the prior six-fingerprint exception;
that policy is unchanged. Two distinct actual security-sensitive GitHub approving
reviews and later Owner merge authorization remain separate. No QA branch, held
file, original model/gold or graduation package belongs in this change.

## Protocol sources

- [OpenAI-compatible Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic native Messages](https://platform.claude.com/docs/en/api/messages/create)

Adapter conformance must validate actual wire serialization and parsing against
local servers. Unsupported model features fail explicitly. Current provider pricing,
live accuracy, hosted availability and CP1 are not established by offline tests.
