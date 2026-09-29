# ADR-003 — JSON Schema as the cross-language contract

- **Status:** Accepted
- **Date:** 2026-09-29
- **Accepted:** 2026-09-29
- **Acceptance vehicle:** PR #2
- **Approved by:** project team / product owner

## Context

TypeScript and Python both need the same shape for job payloads, `MediaAnalysis`, tool arguments, and model output. Hand-written interfaces on each side drift. The roadmap names JSON Schema as the contract and later generates zod types for TypeScript and pydantic models for Python (US-208).

## Decision

- JSON Schema (draft 2020-12) in `packages/schemas` is the cross-language contract.
- A payload that crosses a process or a language boundary must have a schema in that package.
- TypeScript and Python may contain hand-written views during the scaffold. Those views are not the contract. Generated bindings replace them in US-208, and CI will then fail on drift.
- Integers that must survive JSON without precision loss, including media time, are encoded as canonical decimal strings (ADR-008).
- Domain code does not depend on `packages/schemas`. Application and infrastructure validate at the boundary and pass domain values inward.

## Rationale

JSON Schema is language-neutral, reviewable in Git, and usable by both zod and pydantic generators. Keeping the files in one package makes the contract a package boundary that dependency-cruiser can see. Excluding the domain from a direct schema dependency keeps the domain free of validation libraries.

## Consequences

- `packages/schemas` is a leaf package. It depends on no other workspace package.
- Adding a queue message, a public API body, or a tool argument without a schema is an architecture defect once that feature exists.
- This slice ships the package and one small schema (`worker-health`) plus the media-time string schema. It does not generate zod or pydantic types and does not add Ajv.

## Alternatives considered

- **Protobuf or another IDL.** Rejected for the foundation. The roadmap's tools (zod, pydantic, LLM structured output) speak JSON Schema, and the public web API is JSON.
- **OpenAPI as the only contract.** Rejected as the whole-system contract. OpenAPI covers HTTP. Jobs, tool calls, and `MediaAnalysis` are not all HTTP.
- **Duplicate TypeScript and Python types, reviewed by hand.** Rejected. The two copies will drift as soon as analysis fields start landing.
