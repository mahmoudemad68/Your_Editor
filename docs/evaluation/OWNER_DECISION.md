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
ASR VAD filtering disabled. This records the producer's CPU recipe for these three clips,
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
Two producer-machine implementation passes matched labels and raw-output identities. That
observation does not guarantee bit-exact regeneration. Independent QA observed approximately
1% English differences and 17% Arabic differences across hardware, plus substantial degeneration
in one Arabic same-machine pass. CTranslate2, CPU/ISA, threading and numerical execution may
affect output despite fixed weights, temperature and settings. The committed gold is frozen by
its content identity, not by an assumption that running the model again reproduces it. Generated
word gold is not independently reproducible ground truth. Schema,
timestamp bounds/order/overlap, nonempty annotations, Arabic Unicode, manifest identity,
and approval fingerprints are checked offline afterward. Technical validity does not prove
semantic transcription accuracy or human boundary agreement.

Annotation `createdBy=machine_generated` and `generation` always name the actual producer.
The review tool requires `--accept-generated-baseline` plus `--attest-human-review`, the
recorded decision, accepted source/scope and reviewer `project-owner`. Review evidence
records `approvalBasis=owner_accepted_generated` and this deviation ID. It never claims
`createdBy=human` for these generated annotations. Empty templates and unapproved model
results cannot count.

## Post-QA provenance integrity and producer evidence

QA36-F3 is repaired without changing approved annotation or reference bytes. Every approved
artifact requires the exact reviewer ID `project-owner`, including human edits and human labels.
The manifest's decision now declares its dataset identity and six `acceptedArtifacts` bindings:
artifact/source/type, expected `createdBy=machine_generated`, canonical content SHA-256 and
generation SHA-256. These reviewed manifest bindings sit outside the mutable annotation body.
Deleting generation/basis/deviation fields and recomputing an unsigned body fingerprint cannot
turn these current artifacts into human-created gold. The input adapter requires explicit
manifest decision context; it never infers authority from an annotation's claimed producer.
These are integrity bindings backed by the reviewed git snapshot, not digital signatures against
an attacker replacing the entire manifest. A later version fork clears this decision, so genuinely
human-created replacements remain possible without a permanent source-ID prohibition.

The exact original scoped PCM, joint raw word/Silero output and producer conversion record for
each clip remain available and match the approved generation identities. Nine unchanged files
are archived privately under the versioned `producer-evidence` prefix outside git. Manifest
`producerEvidence` records bind source SHA, scope, annotation IDs, dataset version, object key,
size and SHA. Joint raw JSON preserves Faster-Whisper words (including omitted zero-duration
outputs) and Silero speech-sample ranges; the exact PCM is both models' input. The conversion
record preserves settings and exact output arrays. No substitute was regenerated. Full GET/SHA,
size and native-version checks verify archive identity. This local archive remains subject to
the accepted durable-storage finding below.

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
QA36-F4 remains explicit Sprint 3 evaluation debt. QA36-F2 (durable team storage), F6 (stale
approved editorial notes), F7 (representativeness/short source) and F8 (local timing/environment)
are accepted findings, not opportunistically repaired here. Approved notes and all gold content
remain unchanged; no new Owner review or approval is claimed by the post-QA repair.

## Authoritative v1 policy after re-QA

The v1 decision and nine producer-evidence records are pinned by canonical SHA-256 in
`tools/evaluation/provenance-policy.mjs`, outside mutable manifest and annotation JSON.
All v1 validation paths fail closed if the decision/evidence is removed or rebound. This policy
preserves the existing Owner decision and approved bytes; no new approval is claimed. A later
version fork clears the waiver, evidence bindings and current approvals and must establish its
own provenance. It cannot inherit v1 generated acceptance as human provenance.

Approval records are unsigned. Repository review protects policy code and human approval
records; project-owner-looking metadata alone is not cryptographic identity evidence
(QA36R-F3). The pins prevent data-only escalation/rebinding of this accepted v1 snapshot.
