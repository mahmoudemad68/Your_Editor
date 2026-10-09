# US-110 Owner acceptance decision

Decision ID: `us110-owner-generated-annotation-gold-v1`. Dataset: `evaluation-dataset-v1`
(unreleased). Approver: `project-owner`. Evidence: the Project Owner's explicit instruction
in the implementation conversation on 2026-10-09, following engineering head
`d7d58fd3222c79de7aa89b7f5ad7eca44ded7aa5`. The manifest records the decision time and scope.

## Original requirement

**ORIGINAL_REQUIREMENT:** hand-labelled silence ranges and word alignments for 3 clips.

The historical US-110 roadmap text is unchanged. This decision does not claim that its
hand-labelling requirement has been performed.

## Owner decision and rationale

**OWNER_DECISION:** the Project Owner waives additional manual hand-labelling and accepts
technically generated, verified annotations with explicit Owner approval as this project's
US-110 gold evaluation baseline. The Owner reviewed and accepted the evaluation approach;
this is not evidence of manually producing labels or watching/reviewing each generated word.

The project team consists of the Project Owner, Technical Lead / Architect / Orchestrator,
Coding Agent and Independent QA Agent. The Owner is the sole human project approver and
explicitly chose not to perform additional manual annotation work. The Owner authorized
generation and approval subject to technical verification; no further manual work is claimed.

Accepted sources/windows (SOURCE coordinates, integer microseconds):

| Source ID        | Language | Start    | End      | Duration   |
| ---------------- | -------- | -------- | -------- | ---------- |
| commons-28956463 | en       | 30000000 | 90000000 | 60 seconds |
| commons-98650286 | en       | 30000000 | 90000000 | 60 seconds |
| commons-82236797 | ar       | 30000000 | 90000000 | 60 seconds |

All six genuinely human-created reference edits and their existing final Owner approvals
remain unchanged. Reference and annotation quotas remain six/three/three.

## Producer and technical verification

Word alignment uses the US-105 benchmark-compatible Faster-Whisper 1.2.1 path, multilingual
`Systran/faster-whisper-small` revision `536b0662742c02347bc0e980a01041f333bce120`.
CPU int8, two threads, beam size five, temperature zero, word timestamps enabled,
ASR VAD filtering disabled. This selects a reproducible CPU recipe for these three clips,
not a production ASR backend or a benchmark-winning model claim.

Silence labels are the complement of a separate Silero VAD v6 ONNX speech pass bundled
with Faster-Whisper: threshold 0.5, negative threshold 0.35, minimum speech 250 ms,
minimum separating silence 100 ms, speech padding 30 ms. These are non-speech labels;
noise/music/breathing may be included, and their meaning is not acoustic digital silence.

The isolated generator verifies source hashes/sizes, extracts local-only 16 kHz mono PCM,
and records exact tool/model/generator/audio/raw-output identities. Model output supplies
all words and times. Word seconds are rounded half-up to microseconds, clipped to the
scope, and offset into SOURCE coordinates. Zero-duration/empty model words are omitted,
never assigned invented durations; their raw outputs remain in ignored inference files.
VAD sample positions are converted with integer floor division (less than one microsecond
quantization), complemented inside the scope and offset into source coordinates.

The importer independently replays both conversions against raw model results, verifies
source/audio/raw-result/generator identities, and validates all six artifacts before writing.
The repeated inference check compares actual labels and raw-output identities. Schema,
timestamp bounds/order/overlap, nonempty annotations, Arabic Unicode, manifest identity,
and approval fingerprints are checked offline afterward. Technical validity does not prove
semantic transcription accuracy or human boundary agreement.

Annotation `createdBy=machine_generated` and `generation` always name the actual producer.
The review tool requires `--accept-generated-baseline` plus `--attest-human-review`, the
recorded decision, accepted source/scope and reviewer `project-owner`. Review evidence
records `approvalBasis=owner_accepted_generated` and this deviation ID. It never claims
`createdBy=human` for these generated annotations. Empty templates and unapproved model
results cannot count.

## Gate interpretation

`HUMAN_CREATED_GOLD` / `HUMAN_GOLD_COMPLETE` preserve the original human-created 6/3/3
definition and remain false. Existing human annotation counters stay zero.
`OWNER_APPROVED_GOLD` and `OWNER_APPROVED_*` counters report genuine Owner acceptance
of generated annotations separately. Only the explicit, validated decision authorizes
these three generated sources and scopes to satisfy the project gold gate.

`--require-gold` tests the project acceptance gate, including this recorded deviation.
`--require-human-gold` tests the original human-created requirement.
`--require-release` additionally requires exact, versioned durable-storage verification.
Published snapshots still require durable storage and remain immutable; a version fork
clears the Owner waiver rather than silently applying it to a later dataset.

## Storage finding

The Owner explicitly authorized preparation of Independent QA without waiting for a remote
team archive. Local private, versioning-enabled SeaweedFS is implementation evidence,
**not durable team storage**. `GOLD_STORAGE_DURABLE=false` is reported separately. No remote
provider, approval or credentials are invented. Owner-accepted gold can be handed to QA
under this decision, while `US110_RELEASE_COMPLETE=false` until durable storage is verified.

## Evaluation limitations

This is an Owner-accepted generated baseline, not independently hand-labelled ground truth.
WER, timestamp error and silence F1 measured against it quantify agreement with the generating
tools. Comparing the same model/recipe to its own output is circular and cannot establish
independent quality. Reports must identify the generation provenance, language and deviation.
This decision does not change CP2 thresholds or establish that Sprint 3 perception gates pass.
Independent QA should inspect technical provenance, scope, artifacts and these limitations.
