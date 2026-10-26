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

## Implemented contracts and execution

`provider.ts` defines four independent ports. The loop needs only structured output
and tool calls. `configuredHttpProvider` selects either protocol using trusted
configuration; model JSON cannot supply endpoints or credentials. HTTP connections
resolve an explicitly allowed origin to an explicitly allowed literal address and
pin that address for dispatch, preserving TLS hostname validation. Redirects are
rejected. Only 429/503 responses permit at most three attempts, with jitter and a
bounded Retry-After delay. Unknown network outcomes are not retried. Concurrent
calls share admission spacing; every attempt reserves tokens and estimated cost.
Responses, retries, input/output, deadline and abort are bounded. Only inline bounded
PNG/JPEG vision data are accepted. Capability declarations are operator claims or
offline fixtures, never measured model qualification.

Usage distinguishes provider-reported counts, offline HTTP counts, replay counts,
and unavailable counts. Anthropic input accounting includes reported cache-read and
cache-creation tokens. Actual billed cost is always null; versioned operator prices
and conservative UTF-8-byte token estimates are labelled estimates. Replay duration
zero is synthetic. Request/provider IDs are hashed. Raw responses, prompts, session
cookies and keys are absent from public events and reports.

`EditPlan@1.0.0` binds the original Timeline hash, project, source media intervals,
reviewed tool manifest hashes, sequential dependencies and pinned prompt/context
hashes. Validation uses pure domain commands and exact frame coordinates. Existing
trim/split tools preserve composition duration; a request to resize it fails with
`CAPABILITY_UNAVAILABLE`. No model has render, storage, shell or network authority.

Migration `0023_agent_planning.sql` adds private immutable configuration, frozen
context, validated plan and model-call ledgers. Original observations are frozen
once; current authorization is checked again after recovery and at each operation.
AgentRun/Event/Audit/Export 1.1 are additive unions. Historical 1.0 records, including
`decision=no_llm`, remain byte-for-byte historical facts. Public admission is
unchanged and rejects plan/provider fields. Controlled receipts disclose synthetic
usage; private validated proposals and creator text are not exported.

`checkpoint` counts committed tool effects; 1.1 `planning.toolAttempts` counts all
admitted proposals. Only a confirmed failed/rejected SDK receipt with confirmed
cleanup can produce bounded feedback and a new receipt. Successful or uncertain
effects never qualify for retry. Source Timeline plus step checkpoint commit
atomically. Pending model intents become unconfirmed after cancellation, revocation,
deadline or terminal delivery; recovery refuses to repeat them. Validated prior
model responses can be reused only by exact request hash. SIGKILL qualification
tests interrupt both completed checkpoints and unconfirmed publication.

Render orchestration uses the existing authenticated API and a stable idempotency
receipt under source/membership/lease fencing. An unconfirmed render can only be
reconciled to its exact existing job and Timeline; absence is an explicit stop, not
a repeated submission. The actual render worker persists an append-only FFprobe
receipt bound to job, input, Timeline, artifact and render version. The new
authenticated `/projects/:id/exports/:jobId/validation` endpoint returns it only for
a completed accessible job. Evaluating verifies duration, frames, dimensions,
codecs and frame rate before completion. Cancellation cleans up the bound render.

The separate `qualification-entry.js` is invoked explicitly in an isolated test
container with `NODE_ENV=test`, `EDITAGENT_RUNTIME=development` and
`EDITAGENT_REPLAY_QUALIFICATION=isolated-v1`. It accepts bounded ephemeral stdin,
not API planning input or a production enablement flag. Production `index.js` and
its Docker CMD continue to run only infrastructure admission. The 120-second
AgentRun deadline, 600-second ASR deadline and CI budgets remain unchanged.

## Reproducible self-tests and evidence boundaries

- Build: `pnpm --filter @editagent/api... build`,
  `pnpm --filter @editagent/agent-worker build`,
  `pnpm --filter @editagent/render-worker build`.
- Unit conformance: `pnpm --filter @editagent/agent-core test`. Both HTTP adapters
  communicate with local fake servers; all four modes also use replay. These tests
  cover retry, cancellation, malformed/oversized/truncated/refused responses,
  concurrent admission, native cache accounting, SSRF denial and unknown outcomes.
- Real lifecycle: existing `agent-runs.integration.test.js` uses PostgreSQL,
  Redis/BullMQ and ToolExecutor. Its render boundary is explicitly stubbed; those
  tests establish no actual-media validity. Linux CI additionally retains all
  historical AgentRun/context authorization and recovery regressions.
- Packaged conformance: `sh infra/scripts/verify-agent-provider.sh IMAGE` runs the
  same committed cases (only import locations change) against actual deployed
  modules, offline/read-only/non-root. No hosted request or secret is mounted.
- Actual media: `pnpm render:test --graduation-demo` preserves the existing manual
  browser journey and then runs the packaged controlled worker against real
  PostgreSQL, Redis, S3, API, SDK and FFmpeg. It reloads the edited Timeline in the
  existing browser editor, plays/downloads the output, and independently checks
  H.264/AAC, 320x180, 25fps, 200 frames and eight seconds with FFprobe. The proposed
  plan is a declared replay fixture, not natural-language understanding.
- Public CI evidence is allowlisted to the sanitized report, two screenshots and
  licensed sample MP4 under `.local/agent-loop-public/`. Private sessions, contexts,
  prompts, DB contents and raw provider data are never uploaded. A report's code
  identity distinguishes the PR head from the GitHub synthetic merge commit.

Recorded test results and exact-head workflow URLs belong in the frozen handoff.
The presence of a test or this contract is not evidence it passed. Full autonomous
editor acceptance, live model quality, CP1, caption/silence tooling and production
planner enablement remain separate gates.
