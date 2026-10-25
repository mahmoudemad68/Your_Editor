# Optional local language evidence — MediaAnalysis 1.2.0

Issue #63 adds optional `transcript.data.languageSegments`. Historical 1.0.0
and 1.1.0 contracts and generated readers remain frozen. Exact version dispatch
accepts all three versions. Envelope migration to 1.2.0 preserves the old data;
it does not generate language labels for existing receipts. Migration 0021
adds the version to the document CHECK only; admission/auth/source/attempt/
generation/deadline predicates are unchanged.

The existing serialized transcript segments are one per recognized word. They
retain exactly the same IDs, text, word lists, start/end times and confidences.
New metadata does not split, join, translate or relabel those words. There is
**no word-level language or word-language confidence**. Document language and
languageConfidence retain their existing duration-weighted behavior.

## Evidence contract

Each language segment describes an **already executed original-PCM four-second
language-probe context**, including the shorter final context. These are model
observation ranges, not asserted linguistic boundaries. No extra inference,
new text segmentation, Unicode/script classification or borrowed decoder prompt
is used to manufacture metadata.

- `startUs` / `endUs`: exact source coordinates of that actual base probe.
- `scope`: `audio_context_not_word_language`.
- `method`: `ct2-source-context-v1`.
- `model`: pinned name, revision and bundle hash of the detector actually used.
  Tiny's existing bounded Small language-planning recovery is explicitly recorded
  as Small evidence; Tiny decoder words/provenance are not represented as Small
  transcription. No new cross-model recognition fallback is introduced.
- `status: dominant`: the base probe supplies a unique top score at the existing
  0.5 language-plan threshold, and confident overlapping native probes do not
  disagree. `language` and the **unaltered base-probe model score** `confidence`
  are included. This is neither calibrated accuracy nor evidence that every word
  in the context has that language. Forced-language decoder confidence is unused.
- `status: mixed`: confident overlapping source probes disagree. No single
  language/confidence is supplied. This can describe code switching or unresolved
  conflicting context evidence; it does not prove a human-annotated transition.
- `status: unknown`: no VAD-supported language observation, weak/tied/malformed
  model scores, or less than one second of source context. No confidence/label is
  invented from neighboring prompts or recognized characters.

The existing shifted/refinement probes can inform mixed status; their intervals
do not create new transcript segments. Failed Tiny language plans are discarded
before recording a successful bounded Small planning pass. Per-call collection
is reset, so a reused model cannot leak a previous input's language evidence.
Sorted native language entries and fixed source ordering give deterministic
serialization. Collection does not change model parameters, ASR provenance,
recognized words, word timing or existing fail-closed integrity guards.

## Consumers and qualification

The API/persistence use 1.2.0 for new documents and preserve old readers. The BFF
validates the exact declared version. The analysis viewer offers a collapsed
local-evidence list with source times, model name and model score, explicitly
distinguishing context observations from individual word labels. Old documents
without metadata continue to render their original transcript.

Unit, generated TS/Python differential and consumer tests cover optional fields,
EN/AR transitions, conflicting/weak/silent/short observations, source coordinates
and forbidden confidence on mixed/unknown outcomes. Real-model tests execute the
hash-pinned published base and head sequentially on licensed original/component
fixtures, comparing the complete legacy words, times, confidences, document
language, inference parameters and ASR provenance. New metadata is compared in
the existing fresh/reused-process and thread qualification runs.

**Language annotation accuracy is NOT_MEASURED:** the existing constructed
multilingual fixtures and generated project gold are not independently annotated
temporal language truth. Native observations and lexical-preservation tests are
not an accuracy certificate. Fine switches inside one context may remain
unresolved. Tiny Arabic remains unqualified; CP2 remains NOT_MET. No automatic
editing consumer may infer per-word language or safe cuts from this metadata.
