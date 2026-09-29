# ADR-002 — TypeScript for API, Web, and Node workers; Python for the AI worker

- **Status:** Accepted
- **Date:** 2026-09-29
- **Accepted:** 2026-09-29
- **Acceptance vehicle:** PR #2
- **Approved by:** project team / product owner

## Context

The web application is React. The API needs a structured server framework. The agent, media, and render workers share types with the API and call Node libraries (the queue client, Remotion, and the FFmpeg process wrapper). Perception depends on the Python machine-learning ecosystem (Faster-Whisper, VAD, and later vision models).

One language would either abandon that ecosystem or abandon the TypeScript UI and Remotion.

## Decision

- TypeScript is the language for `apps/web`, `apps/api`, `workers/agent-worker`, `workers/media-worker`, `workers/render-worker`, and the shared packages `domain`, `schemas`, `tool-sdk`, `media-core`, and `shared`.
- Python 3.11 is the language for `workers/ai-worker`.
- TypeScript is strict. Python is checked with Ruff and mypy.
- Cross-language data uses JSON Schema (ADR-003), not handwritten duplicate types as the long-term contract.

## Rationale

TypeScript is already required by Next.js and Remotion, and it gives one typechecker across the API and the Node workers. Python 3.11 is the baseline the roadmap names for the AI worker and matches the wheels those model libraries publish. Keeping model code in a separate package means the Node services do not import PyTorch or Whisper.

## Consequences

- Two toolchains are mandatory: pnpm and Turborepo for TypeScript, uv for the AI worker.
- A bug can hide in the translation between languages. The schema contract and, later, generated bindings (US-208) are the control for that.
- The AI worker cannot be inlined into a Node process under this decision.
- This slice does not add ASR, VAD, or model dependencies. The package is only the language and boundary home.

## Alternatives considered

- **Python for the API and workers, with a separate TypeScript UI.** Rejected. It splits the domain model away from the API and the Node render stack.
- **TypeScript only, calling Python models through a CLI.** Rejected as the architecture. A CLI boundary would be an informal contract. A Python worker with a schema-validated job payload is explicit.
- **All Node, with WASM or remote model servers only.** Rejected for the foundation. The team would still need a Python research path for CP1, and the worker would reappear later under time pressure.
