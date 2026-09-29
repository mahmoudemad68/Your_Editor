# ADR-006 — LLM provider abstraction

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Not yet accepted. Pending team review (US-103 AC2).

## Context

The agent must call more than one model. The feasibility spike (US-107) compares hosted providers and a local model. Provider SDKs differ in tool-call shape, streaming, and error handling. The domain and the agent loop cannot take a dependency on one vendor, because the roadmap's risk plan treats provider swap as the mitigation for cost and quality.

## Decision

The Agent module defines four ports:

- `IChatModel`
- `IToolCallingModel`
- `IStructuredOutputModel`
- `IVisionModel`

An adapter in the agent worker's infrastructure layer implements the ports a provider actually supports and reports the ones it does not. The domain and the application use case depend on the ports. They do not import a provider SDK.

Structured output and tool arguments are validated against JSON Schema (ADR-003) before the agent treats them as a plan. The adapter does not catch schema failures by retrying inside the port implementation with hidden prompts. Retries are an application policy.

No provider is wired in this slice.

## Rationale

Splitting ports by capability avoids pretending every model can call tools or see images. Validation at the schema boundary makes provider output look the same to the agent loop. Putting the SDK in the adapter keeps `packages/domain` free of frameworks and of vendor clients, which the dependency rules enforce.

## Consequences

- US-301 adds the real port types, capability descriptors, and the first adapters. This ADR only fixes the boundary.
- A provider that returns tool calls in a private format is normalized in the adapter, not in the use case.
- Secrets for providers live in worker configuration (US-114), not in source.
- Tests of the agent loop can use a fake port. Live provider tests are a later, explicit suite.

## Alternatives considered

- **One SDK called directly by the agent loop.** Rejected. Swapping providers would edit the loop, and the domain would depend on that SDK.
- **A single `IModel` port with optional methods.** Rejected. Callers would discover missing capabilities at runtime. Separate ports make the requirement visible in the use-case signature.
- **An external LLM gateway as the only integration.** Rejected as a requirement. A gateway can be one adapter. It must not be the only way to run a local model.
