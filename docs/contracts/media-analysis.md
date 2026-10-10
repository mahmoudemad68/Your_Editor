# MediaAnalysis contract (US-208)

`packages/schemas` owns the canonical JSON Schema graph, draft **2020-12** (ADR-003).
`src/media-analysis.schema.json` defines **schemaVersion `"1.0.0"`**, the version of the
complete persisted analysis document. It is separate from dataset, model, runtime and application
versions. New analysis schema `$id`s include `/1.0.0.schema.json`; `$ref`s resolve through the
checked-in graph, never an HTTP fetch. US-202's existing SpeechAnalysis retains its own numeric
`schemaVersion: 1` and original `$id`.

## Structure and identity

One document identifies exactly one asset with the existing **lowercase UUIDv7** `mediaAssetId`.
`source.sha256` identifies original content. Optional `source.durationUs` is the known source
duration; absent means unknown, not zero. Image/unknown-duration metadata therefore need not
invent a duration. Temporal results require a known enclosing duration. Section input identities
and checksums do not authorize access to an asset; application authorization remains outside this
contract. No storage keys, local paths, signed URLs or credentials belong in this document.

All six keys in `sections` are required. Each uses the same exclusive lifecycle:

| Status          | Required                       | Forbidden                       | Meaning                                                                                   |
| --------------- | ------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `not_available` | `status`                       | `data`, `provenance`, `failure` | No result supplied; analyzer may not have run. Not a claim of successful empty detection. |
| `completed`     | `status`, `data`, `provenance` | `failure`                       | Successfully produced data; empty lists can be legitimate.                                |
| `failed`        | `status`, `failure`            | `data`, `provenance`            | No usable result; bounded fixed safe reason and explicit retryability.                    |

These are value contracts, not US-210 scheduling, retry, persistence or aggregation implementation.
Failure codes/reasons are closed enums of safe product messages; raw exception/command output is
not an extension field. Unknown properties are forbidden at every object boundary. No free-form
metadata blobs, defaults or nullable fields exist. Optional means **absent**, never `null`.

| Section    | Canonical source                  | Data                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| metadata   | `analysis-metadata.schema.json`   | Existing Media/Probe vocabulary: kind, durationUs, container, videoCodec/audioCodec, stored/display dimensions, rotation, rational frameRate, frameRateMode, colorSpace, sampleRate, audioChannels. Unavailable stream fields are omitted. All four dimensions occur together and respect rotation; frame-rate terms are positive decimal integers fitting PostgreSQL bigint. |
| transcript | `analysis-transcript.schema.json` | Language, optional language confidence, ordered segments and exact original Unicode word text, source-coordinate word times, optional confidence/speaker token. No transcription is implemented.                                                                                                                                                                              |
| audio      | `analysis-audio.schema.json`      | Optional `speech` **references the existing speech-analysis schema** without copying its fields. Optional silence ranges, loudness values, energy points and waveform summaries define future US-204 contracts only. At least one produced field is needed. Loudness uses LUFS, dBTP and LU; RMS uses dBFS; waveform extrema are normalized [-1,1].                           |
| scenes     | `analysis-scenes.schema.json`     | Unique scene/shot IDs, ordered non-overlapping ranges and confidence. No detector.                                                                                                                                                                                                                                                                                            |
| faces      | `analysis-faces.schema.json`      | Unique opaque track IDs, positive ranges, ordered observations and boxes. No person identity or recognition.                                                                                                                                                                                                                                                                  |
| objects    | `analysis-objects.schema.json`    | Unique track IDs, class label, positive ranges, ordered observations and boxes. No detector.                                                                                                                                                                                                                                                                                  |

`analysis-provenance.schema.json` defines per-section analyzer/version, original source SHA and
configuration SHA. Runtime, model and input derivative identities are optional when applicable;
a model identity, when present, includes name, version and SHA. An input checksum identifies bytes,
not a storage URL. Document-level `provenance.producer/producerVersion` identifies the producer or
assembler, not a model purported to have generated all sections. Completed section source SHA
must match the document source. Embedded US-202 retains its complete source/audio identities,
scope, confidence aggregation, normalized PCM hash, model/runtime/configuration provenance and
source coordinates. Its source checksum and duration must match the enclosing document.

## Time, coordinates and bounds

ADR-008 timestamps/durations are **integer microseconds encoded as canonical decimal strings**,
never floats or JS numbers. `analysis-common` specializes the existing media-time `$ref` with a
20-digit transport bound and strict end-of-string matching. Temporal ranges are half-open
`[startUs,endUs)`, positive, inside the known source duration. Touching ranges are valid.
Observation `atUs` is inside `[track.startUs,track.endUs)`; observation times strictly increase.
Words belong inside their segment and segments/word lists are ordered and disjoint. Track/scene
IDs are unique in their respective lists; tracks may overlap each other.

Large-time fixtures preserve `9007199254740993` exactly in both languages. This representation test
**does not relax the existing 30-minute media ingestion cap**. The contract is a bounded archival
representation, not upload admission. Actual US-202 speech still enforces its existing 30-minute
source, threshold, configuration, scope and padding limits unchanged.

Boxes use normalized **x/y top-left and width/height**, all finite, positive extent and entirely
inside [0,1] canvas. Confidence is finite [0,1]; existing US-202 confidence retains its documented
sample-weighted mean, not statistical calibration. Strings are well-formed Unicode, with lengths
measured in Unicode code points in both languages. Arabic/punctuation/case/emoji are preserved.
JSON numbers such as `1` and `1.0` denote the same integer; neither runtime coerces strings or bools
into numbers. Nonfinite numbers are invalid. Python serializers omit unset optional fields by
default so absent fields do not become nulls.

Storage ceilings cover 54,000 words/segments (30 minutes at a generous 30 words/second), 56,250
speech/silence regions (the existing 32 ms US-202 window budget), and 108,000 observations/scene
ranges/summary points (30 minutes at 60 observations/second). Nested face/object observations and
transcript words have aggregate ceilings, not just per-list ceilings. Face tracks are bounded at
128 and object tracks at 1,024. These are payload safety limits, not a claim about analyzer sampling
or accuracy; future producers must negotiate a version if they need a larger representation.
Boundary callers must also enforce a byte-size budget before JSON decoding (32 MiB is the test
bridge ceiling); schema constraints alone do not replace transport/memory limits.

JSON Schema handles structural validation. Its `x-editagent-checks` annotation is the canonical
source for relational checks standard JSON Schema cannot express (range ordering, containment,
unique IDs, geometry and source identity). The repository compiler emits calls to generic
language-specific operations; it does not maintain separate hand-written contract shapes.
Plain third-party JSON Schema validation alone does **not** run these relational annotations.
Consumers use the generated boundary validators for complete validation. No domain framework
imports are introduced.

## Generation and consumption

```sh
pnpm schemas:generate
pnpm schemas:check
pnpm --filter @editagent/schemas build
pnpm schemas:test
pnpm --filter @editagent/ai-worker test
```

The repository compiler `tools/schema/generate-media-analysis.mjs` is version **1.0.0** and uses
existing pinned Prettier **3.9.9** for TS. It runs offline after dependencies are installed and has
no external generator dependency. Runtime bindings use existing catalog Zod **4.6.5** and locked
Pydantic **2.13.5** (Python 3.11). Zod is newly declared only in the schema package; it was already
in the workspace lock. No Python dependency graph changes are needed.

Inputs include all new analysis schemas, existing media time and speech analysis. Output is:

- `packages/schemas/src/media-analysis.generated.ts`
- `workers/ai-worker/src/editagent_ai_worker/contracts/media_analysis_generated.py`

Both carry a generated warning, source digest and generation command, with no date or machine
path. Python formatting is deterministic Node-emitted source with an explicit generated-block
`fmt: off` and only E501 suppression; imports, type checking and all other Python lint checks stay
active. This keeps Node-only image builds independent of Python/Ruff installation. Human-owned
helpers are fully Ruff-formatted. Existing job-event generators remain unchanged.

Supported codegen subset: strict objects, required/optional fields, finite bounded numbers and
integers, primitive literals/enums, bounded arrays/strings, offline `$ref`, scalar string `allOf`,
and `oneOf` with disjoint required literal status. Scalar `allOf` constraints belong in its
members; assertion siblings and unsupported nested keywords fail generation. No recursion, arbitrary defaults, formats,
coercion, schema downloads or executable payloads. Unsupported features fail generation; adding
one requires compiler implementation and differential tests first.

```ts
import { MediaAnalysisSchema, type MediaAnalysis } from "@editagent/schemas";
const analysis: MediaAnalysis = MediaAnalysisSchema.parse(JSON.parse(input));
// Browser consumers enforcing CSP can pass the supported {jitless: true} parse context.
```

```py
from editagent_ai_worker.contracts import MediaAnalysis
analysis = MediaAnalysis.model_validate_json(input_json)
output_json = analysis.model_dump_json()  # excludes unset fields; never adds null defaults
```

`@editagent/schemas` also exposes section validators/types, `SpeechAnalysisSchema` and
`AnalysisTimeSchema`; Python exports MediaAnalysis/SpeechAnalysis through its stable `contracts`
module. Generator internal paths are not needed by consumers. Models are boundary values, not
canonical domain aggregates. Use normal validation APIs; Pydantic's explicit unsafe construction
or unvalidated model-copy APIs are not an ingestion path.

The schemas package build regenerates expected bytes in memory and compares **both outputs**.
It fails on missing/stale/hand-edited files without modifying the worktree. Normal build/check/CI
therefore run drift verification transitively. Node image build stages include the generated Python
file as a drift-check input; it is not included in their final runtime images. The adversarial test copies sources/outputs to a
throwaway directory, changes a meaningful constraint, proves the actual check CLI exits 1,
regenerates and proves check passes. Two clean generations must be byte-identical.
Contract tests construct actual Pydantic values, serialize into Zod, and send actual Zod-validated
values to Pydantic. Synthetic fixtures and a deterministic invalid matrix cover all section
states, large times, Unicode, source bindings and US-202 compatibility. They are not perception
accuracy evidence or evaluation gold.

## Versioning and migration policy

The semantic version names accepted **document meaning**, not dependency releases.

- **PATCH:** documentation/schema corrections that do not change intended accepted meaning.
  Any change in valid meaning/type/constraints is not merely a patch.
- **MINOR:** backward-compatible additions only, such as an optional non-critical field or optional
  section. Adding a required field, narrowing a type/bound, changing units/ID semantics or removing
  a field is never minor. Increasing a storage ceiling needs negotiation with consumer limits.
- **MAJOR:** breaking/removing/renaming/type-changing changes, including additions to current
  **closed enums** unless safe handling by older consumers is explicitly proven. Enum additions
  are not automatically safe merely because they are additions.

Strict old readers intentionally reject new versions/unknown fields. "Backward compatible" means
new consumers retain readers for older snapshots and can upgrade them without changing meaning;
it does not mean a 1.0.0 reader silently accepts 1.1.0 fields. Producers negotiate an exact supported
version. When a new version is introduced, preserve the published schema graph/validators for old
versions, add version-specific `$id`s/readers, and implement tested, explicit pure JSON-to-JSON
migration where needed. Never relabel an incompatible document by changing its version string.
Downgrades require evidence that meaning is preserved; do not silently discard unknown results.
This first contract has no predecessor MediaAnalysis and needs no executable migration.

## Boundaries and known limitations

The US-202 QA F4 newline discrepancy is fixed minimally in its JSON Schema patterns; generated
bindings use the same constant/version/length bounds. Regression tests compare both languages and
the existing Python domain parser. **No VAD algorithm, model, settings or evaluation gold changes.**
Other PR #38 debt is untouched. US-202 remains accepted under Owner-approved project gold;
independent human accuracy is NOT_PROVEN and CP2 silence F1 is NOT_MET. US-216 remains
BLOCKED_ON_CHROMIUM_SANDBOX and render-worker is untouched.

This story adds no analyzer, runtime orchestration, persistence, API, rendering or recognition.
Provenance declares identities and configuration fingerprints; authentication/trust in producer
claims belongs to the calling system. Safe failure enums cannot prevent a caller from leaking
private transcript text elsewhere. Unknown versions fail closed until supported explicitly.
