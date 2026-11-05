# EN/AR Reference Qualification Specification

Protocol: **your-editor-en-ar-independent-reference / 1.0.0-draft.1**

Status: **PROPOSED; BLOCKED_REFERENCE_DATA**. No annotators are assigned, no new
human annotations exist, and collection, paid services or external sharing are not
authorized. This document is for Technical Lead review before an implementation PR.

Authority: [Issue97 Technical Lead decision](https://github.com/mahmoudemad68/Your_Editor/issues/97#issuecomment-6481023074).
Verified main: `5cdb1d794d347a36d869027947bb62504dddff92`.
Main tree: `86e94e6a4b2d5eb705a9d5c9804c3196c69310f4`.
`protocol.json` is the machine-readable companion. Stage A's dependency matrix,
immutable source/gold hashes and recorded Stage A verification scope are enumerated
in this directory's `evidence-inventory.json`. The original local Stage A reports
remain hash-only historical records; their contents are not part of this publication.

## 1. Versioning, reproducibility and evidence status

The Lead approves an immutable protocol release before collection and model tuning.
Record protocol, manifest, source bytes, decoded PCM, annotation, adjudication,
split, lexicon, detector, scorer and runtime hashes independently. The original v1
US110 gold and approvals stay unchanged. A proposed independent reference has a
separate dataset ID, never a replacement file under the old ID.

Changing a label definition, primary match rule, partition or acceptance population
requires a new qualification version and an explicit reviewed comparison. An
editorial correction cannot silently change scored content. Never overwrite rater
tracks or an exposed held-out result. Freeze the accepted JSON bytes and archive
checksums; source/Git identity is recorded separately from raw artifact SHA256.

Evidence roles are disjoint: INDEPENDENT_HUMAN_REFERENCE, HISTORICAL_GENERATED_GOLD,
SYNTHETIC_SOFTWARE_FIXTURE, MODEL_PREDICTION, and UNFILLED_TEMPLATE. Only the first
can satisfy Issue97's independent reference requirement, after provenance review.
No signed statement, human identity, consent or completed review is fabricated by
an AI. A labelled reference itself does not authorize a production edit.

## 2. Operational label definitions

All intervals are half-open in ORIGINAL SOURCE time. Annotate immutable decoded
PCM with original channels preserved, before normalization, attenuation, resampling
or mono downmix. Record sample rate, format, channels, decoder/version, original
media hash and PCM hash. Boundary sample indices are integers; serialize us as
`floor(sampleIndex * 1000000 / sampleRate)` decimal strings, retaining samples for
audit. Excerpt offsets are explicit. Never fabricate epsilon word intervals.

| Label v1         | Positive definition                                                                                                                                                                                                                                                                                                             | Negatives / ambiguity                                                                                                                                                                                                    | Authority                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACOUSTIC_SILENCE | Consecutive samples for which every original channel is below the unchanged -60dBFS amplitude condition for at least200000us. For normalized PCM, compare absolute amplitude with10^(-60/20); preserve exact representation/threshold convention. Boundaries describe the complete qualifying low-level run, not a padded edit. | A loud sample in any channel breaks the run. Subthreshold music or quiet speech can still be positive acoustically and protected semantically. Clipped/undecodable/uncertain channel evidence is UNKNOWN.                | Independently human-reviewed signal-boundary evidence, never the evaluated FFmpeg predictions. A separate sample checker corroborates physical validity after blind rater submission. |
| NON_SPEECH       | Human-confirmed absence of linguistic speech, including intelligible/unintelligible spoken words, filled speech pauses and sung lyrics, over a fully reviewed interval. Music, breath, laughter and noise may be non-speech yet meaningful.                                                                                     | Uncertain or masked speech is UNKNOWN; hummed/no-word music remains meaningful non-speech. Unlabelled gaps do not mean confirmed absence.                                                                                | Human coverage track. Historical Silero-complement NON_SPEECH retains its own producer/version; it is not converted into human truth.                                                 |
| FILLER           | An audible filled pause or contextually non-propositional hesitation/discourse filler with the exact human word/vocalization references identified. Preserve original wording and event context.                                                                                                                                | Lexicon spelling alone is insufficient: English like/well/so and Arabic يعني/طيب/آه can be meaningful. Lexical use, quoted examples, emphasis, names and unresolved function are not definitive filler positives.        | Two independent bilingual judgments plus adjudication, not ASR confidence or a lexicon lookup.                                                                                        |
| REPETITION       | An unintended repeated sequence or restart: identify the reparandum/candidate words and the retained repair/counterpart. Subtype EXACT_REPEAT or RESTART. A restart need not repeat identical tokens.                                                                                                                           | Intentional emphasis, recitation, lyrics, quoted speech, purposeful repetition, a separate speaker's turn and uncertain intent are protected negatives/UNKNOWN as adjudicated. Identical spelling alone is insufficient. | Contextual human annotation with explicit retained counterpart and original word references.                                                                                          |

These tracks may overlap. ACOUSTIC_SILENCE=true with NON_SPEECH=false is legitimate
quiet speech. ACOUSTIC_SILENCE=true with meaningful music is legitimate signal
evidence but not safe removal. No labels are changed to make them mutually exclusive.
Add separate SPEECH_PRESENT, MUSIC_PRESENT, NOISE_PRESENT and MEANINGFUL_CONTENT
flags, each YES/NO/UNKNOWN, and reviewed coverage. They are protection evidence,
not new production schema fields. Filler/repetition truth never grants deletion.

For US203, normalization is matching-only NFC, Unicode casefold and explicitly
versioned punctuation/Arabic diacritic/tatweel handling. Keep the raw text and word
coordinates. Do not broadly fold alef/hamza/ya, infer language from Unicode alone,
or change a meaningful Arabic token to match a filler. Code-switch language comes
from human context for reference annotation and trustworthy existing local model
evidence for the producer; unknown/mixed remains explicit. No invented per-word
language confidence.

For reproducibility, reference-key-v1 uses Unicode14.0.0 tables: NFC, casefold,
delete U+064B..U+065F/U+0670/U+0640, trim outer Unicode whitespace, then strip only
leading/trailing P-category characters. Preserve internal apostrophes, hyphens,
decimal punctuation and whitespace; never split/merge an original word to match.
An empty key is unmappable. This is a new proposed evaluation mapping, not a change
to US110's frozen WER normalization. Pin the scorer/runtime and table identities
in the run manifest; reject an unexpected Unicode-table version.

## 3. Boundaries, protected words and adjudication

**Acceptance tolerance:** CP2's primary duration score has **zero collar**. No
boundary expansion, forgiven speech, removal of uncertain samples or retuning of
-60dBFS/200ms is introduced. Source frame snapping happens only in future edit
planning, never to the reference labels before scoring.

**Annotation review tolerances, proposed:** >20ms difference between human word
onsets/ends and >50ms difference between human NON_SPEECH boundaries trigger explicit
review. These are review triggers, not allowed scorer errors or new roadmap limits.
ACOUSTIC_SILENCE endpoints require independent original-sample verification; coarse
listening agreement does not establish a threshold crossing. Keep each rater's exact
boundary, earliest/latest plausible bounds and reason. Report disagreement below
the triggers too. Final adjudication must retain auditable sample/phonetic evidence.

When ASR combines a filler and meaningful speech into one native word interval,
the detector must abstain from a removable span; neither reference nor output can
split that native interval by invented timing. Filler/repetition primary identity is
the complete referenced word set; temporal uncertainty is reported separately.

All transcript words, audible uncertain speech, VAD speech, meaningful music/noise
and user-protected content remain protected for automatic silence editing. Preserve
the existing50ms transcript/VAD padding and exact frame/source checks. Reference
annotation does not narrow that protection. For US223, even correctly labelled
fillers/repetitions remain protected speech; removing them belongs to separately
authorized functionality, not this silence-removal route.

Rater A and B independently submit locked tracks without seeing each other's work,
ASR transcripts, VAD output, tested detector suggestions or scores. An independent
qualified adjudicator then reviews disagreements against original audio/context,
records the selected label/boundary and rationale, or retains UNKNOWN. Never resolve
disagreement by majority among AI outputs, by the tested detector, or by asking the
Owner to annotate. Annotators may correct factual errors via new signed revisions;
the raw independent submissions remain intact.

For unresolved boundary bands, report the strict point score plus conservative
uncertainty bounds. Let Gcore use latest plausible starts/earliest ends and Gpossible
use earliest starts/latest ends. TPmin=|P intersect Gcore|, TPmax=|P intersect
Gpossible|, FPmax=|P minus Gcore|, FPmin=|P minus Gpossible|, FNmax=|Gpossible minus P|,
FNmin=|Gcore minus P| give conservative F1 bounds. They are sensitivity reports,
not substitute acceptance scores. If unresolved ambiguity changes whether an
acceptance criterion passes, qualification is BLOCKED; do not select the favorable
boundary or silently exclude the clip. Unknown class coverage is reported explicitly.

## 4. Data acquisition, privacy and stratified partition

### Preferred source route, subject to Owner approval

Use approved licensed natural EN/AR recordings plus newly approved licensed or
consented sources where required for coverage. Existing project sources can seed
training/pilot work; they have already been examined and are not pristine holdout.
No old machine annotation becomes human truth. No source is acquired, annotated,
uploaded or sent to a contractor by this specification.

For each candidate, document source URL/revision, original SHA256, licence and
attribution, permitted annotation/adaptation/distribution, privacy/consent review,
speaker/session grouping and access restrictions. Public availability is not blanket
authorization for third-party sharing. A voice is potentially identifying; pseudonymous
IDs do not anonymize audio. Exclude unsuitable private/sensitive recordings instead
of editing the immutable original to conceal the issue. Derived redacted material
would require separate rights/provenance and cannot retain the old source hash.

Default custody is the already approved private environment and named approved
workstations. No external annotation portal, cloud sync, public attachment or raw
media/gold upload is authorized. Only allowlisted aggregate metrics/hashes may enter
ordinary engineering evidence. A later sharing/access approval must identify people,
location, purpose, retained data, licence, retention/deletion and permitted outputs.
No claim is made that durable off-host storage or suitable encryption is already set up.

### Proposed first collection, not an acceptance result

Plan60 natural clips of approximately1minute:20 EN,20 AR,20 code-switching. Each
language group initially targets5 clean,5 quiet-speech,5 music-bearing and5 ambient-
noise clips; record overlaps rather than misrepresent mutually exclusive content.
Use the screening category only for allocation. Include both EN→AR and AR→EN,
multiple switches, conversational hesitation/restarts and intentional repetition.
Record Arabic variety; an Egyptian-only sample cannot qualify all Arabic dialects.
Keep long pauses, short gaps, overlap, breaths, non-speech meaningful content and
scope-edge words in the challenge inventory. Do not attenuate natural clips and
call those independent natural observations. Synthetic controls stay separate.

Target30 train /15 dev /15 held-out clips, with language/condition coverage. All
excerpts from connected source families, sessions and recurring speakers remain in
one split. Exact quotas are subordinate to preventing leakage. Use an approved
manifest, deterministic constrained allocation with SHA256(protocolId + LF + groupId)
as its tie-break, and a checked-in resulting split manifest. Record any infeasible
quota and block a broad coverage claim instead of splitting a speaker across sets.
Ratios are targets, not evidence that the current12-source pool can fill them.

Pilot approximately5minutes from TRAIN only, revise guidance and redo pilot labels
before freeze. Actual annotation time is measured in that pilot. Aim to acquire at
least50 adjudicated disfluency positives for each EN/AR linguistic population plus
representative negatives; this is a sampling target, not a new roadmap threshold.
If too sparse, extend collection under predeclared, prediction-blind rules before
held-out scores are seen. Never select clips because the detector performs well.

Freeze clips/scopes, annotation version, normalization, primary metric and split
before tuning. Coders may use train/dev. The held-out custodian withholds labels;
an evaluator consumes a frozen detector artifact and reports one recorded result.
Record every exposure. A failed holdout is a real failure: report it, repair on
train/dev, and obtain a separately versioned untouched qualification set. The old
result remains visible. Do not repeatedly call the same held-out set "unseen".

## 5. Human workflow and inter-annotator agreement

Required roles: two real independent annotators competent in English and the sampled
Arabic varieties/code-switches; one separate qualified adjudicator; a held-out
custodian/evaluator. The custodian may be an authorized existing reviewer; no new
AI agent is introduced. No individuals are currently designated or assigned.

Each human first transcribes/listens independently and marks complete review coverage,
words, event labels, uncertainty and original-channel boundaries. Do not prefill
with ASR or model labels. Freeze both transcripts before constructing a deterministic
monotonic cross-rater word alignment for comparison. Ambiguous repeated-token matches
are reported, not silently aligned for best agreement. After independent submissions,
the physical-boundary checker may identify factual acoustic inconsistencies for
adjudication; it does not generate the human event or editorial-content labels.

IAA is reported **before adjudication**, by language, condition, class and speaker:

- Exact typed word-span agreement: one-to-one matches, pairwise precision/recall/F1;
  confusion matrix including negative/UNKNOWN and intentional emphasis.
- Continuous labels: exact duration intersection/union, pairwise duration F1 and
  Cohen kappa from the four YES/NO duration cells over jointly reviewed coverage.
  Unknown/unreviewed duration and denominator are explicit; constant-label/zero-
  variance kappa is undefined, not1. These metrics use source time without a grid.
- Boundary absolute differences: median/p90/max and counts over20ms/50ms review
  triggers; acoustic physical-validation mismatch counts; uncertainty-band widths.
- Raw transcript disagreement, cross-rater alignment ambiguity and adjudication rate.

Do not invent a kappa/F1 acceptance cutoff. Pilot disagreement patterns determine
whether definitions/training need revision before the protocol is frozen; the Lead
reviews reference fitness. High post-adjudication agreement is not independent IAA.
Report person-hours and adjudication changes. A frozen final reference requires actual
rater/adjudicator attestations bound to content hashes; empty templates cannot pass.

## 6. Independent metrics and US203 qualification

Primary proposal: **strict typed-span precision** TP/(TP+FP), micro-counted over
the manifest-designated EN/AR/mixed held-out clips, target **>=0.85**, unchanged.
Publish per-language/class/clip counts and limits; a pooled result is not proof of
every dialect or per-language>=0.85. The Lead/Owner must accept this aggregation
interpretation before any tuning; no additional per-language threshold is invented.

Reference events identify exact adjudicated human word sets and subtype/counterpart.
Prediction events refer to original native segment/word indices and transcript hash.
A deterministic monotonic lexical/source-time map relates the two independently
created transcripts; record normalization, edits, alternate matches and unsupported
alignments. An ambiguous map cannot be chosen opportunistically as a TP.

Mapping candidates require equal nonempty reference keys, positive original-source
time intersection and monotonic word order. Optimize the number of matched words,
then minimize summed absolute start-us differences. If multiple optima remain,
only pairs present in every optimum are trusted; mark the rest unmappable. The
alignment must not inspect FILLER/REPETITION labels to maximize detector scores.
One TP requires the correct class and exact referenced human word set. A duplicate,
wrong class, meaningful extra word, fabricated/unsupported anchor or unmatched
definitive prediction is FP; an unmatched known reference event is FN. Matching
does not allow a temporal-overlap collar to forgive an extra meaningful word.

Unresolved human class cases are UNKNOWN, not fabricated positives/negatives. Keep
all proposed predictions in the accounting and publish conservative precision bounds
for unresolved outcomes. If their treatment could change pass/fail, block qualification
until adjudication/protocol resolution; never silently drop hard predictions. Native
boundary correctness and no split meaningful word are separate zero-defect checks for
AC1, not a count-precision shortcut.

Abstention is allowed and recorded by reason: ambiguous linguistic function, language,
word mapping, coverage or alignment. It emits no positive/removal. A missed true event
still contributes FN; report recall, prediction yield, abstention and reference event
counts. Zero predictions yields undefined precision / NOT_PROVEN, never a pass.
Do not call an unsupported input a successfully empty detection. Do not invent a
recall acceptance threshold, but disclose low coverage prominently.

Evaluate the actual qualified production ASR input as the primary end-to-end route;
a detector run on a human transcript is a separate diagnostic oracle. Freeze lexicon,
rules, thresholds, code/model/runtime hashes and dependencies before held-out access.
Use the qualified pinned Small profile for supported Arabic; do not silently substitute
it for Tiny or claim Tiny Arabic acceptance. Preserve original native words/times/
confidence/provenance and explicit fail-closed invalid alignment.

An independent scorer implementation recomputes counts/matches from immutable
prediction and human-reference artifacts. The separate Independent QA Agent later
audits this methodology; two programs agreeing is not an Independent QA verdict.
Report sample sizes and confidence intervals without adding an undeclared lower-
confidence-bound requirement or replacing the>=0.85 point criterion.

## 7. CP2 historical baseline and independent-reference comparison

Keep three named tables: (a) historical generated Silero NON_SPEECH, (b) seven
constructed acoustic controls, (c) proposed independently annotated natural reference.
Never pool those label classes or make (c) overwrite (a). The strict canonical
duration metric unions intervals, clips to declared source scope and computes integer-
us TP/FP/FN; pool counts before ratios. Preserve empty-set conventions and0-collar F1.

Stage A rechecked stored predictions against verified original media/PCM/gold:
historical TP934876us / FP178687us / FN15117124us; P0.8395357964,
R0.0582404685, F1 **0.1089245951**. Constructed controls are TP5750000us,
FP0,FN0,F1=1. These are not new natural human qualification measurements.
All6 original annotation hashes remain pinned; source/gold identities are in the
Stage A inventory. Historical reference has38 generated NON_SPEECH intervals and
446 generated words, zero independent human word/silence labels.

Run the **unchanged** production acoustic detector first on (c), with fixed original
defaults. Compute both acoustic detection metrics and separate speech/music protection
errors. Annotate a full reviewed scope; absent event tags do not define negatives.
Report point score, uncertainty, coverage, per-language/condition/source failures and
pooled TP/FP/FN. Any later tuning uses train/dev only and keeps the first baseline.

The original F1>=0.90 criterion, English WER<=12%, recorded Arabic WER and median
word-start error<=100ms against hand-aligned references remain unchanged. A silence-
only result cannot close full CP2. Designating (c) as the correct class/reference for
the existing criterion needs explicit acceptance-contract approval, not silent gold
replacement. Natural acoustic agreement alone also cannot authorize destructive edits.

## 8. US223 target-duration failure contract — proposed integration behavior

The Lead has decided: **protected speech/content always wins**. There is no remaining
question about sacrificing protected content to meet a target. The current nonempty
automatic-removal rejection remains unchanged; this is a future interface design,
not an enabled endpoint, error enum migration or alternative explicit-edit bypass.

Order: authenticate and recheck project/membership first; reject invalid input;
enforce qualification/security gates; then consider a trusted source-bound plan.
With the current guard closed, return the existing safe unqualified outcome before
attempting removal; do not pretend a target can be executed. Unauthorized callers
must not learn whether an asset, transcript or infeasible target exists.

In a separately authorized qualified path, let D0 be current composition duration
and C the union of admissible frame-aligned acoustic cuts after required inward
padding, word/VAD50ms protection, meaningful-content and minimum-clip constraints.
Calculate the actual feasible output-duration set from validated plans, including
the renderer's documented transition semantics. It need not be a continuous interval.
If no allowed plan meets the requested target within the existing one-frame duration
criterion, return **TARGET_DURATION_UNACHIEVABLE**, applied=false, retryable=false.
Changing the requested target or source/constraints requires a new request; retrying
the unchanged request cannot create permission. A safe authorized preview may expose
permitted bounds only when actually computed, not an invented "nearest" duration.

Do not drop word padding, remove filler/speech/music, shorten below minimum clips,
extend source reads, silently change the requested target or commit a partial plan.
There are no Timeline/version mutations, render jobs or media effects on this outcome;
only existing bounded rejection auditing may occur. Preserve basis/hash/generation
fencing. A bounded solver that cannot prove feasibility returns an honest planning-
limit/unsupported outcome, not a false assertion of mathematically proven infeasibility.

Illustrative safe response, **SYNTHETIC_INTERFACE_EXAMPLE_NOT_EXECUTION**:

```json
{
  "status": "not_applied",
  "code": "TARGET_DURATION_UNACHIEVABLE",
  "applied": false,
  "retryable": false,
  "message": "The requested duration conflicts with protected content or editing limits."
}
```

Keep private word text, storage identities, raw errors and detailed causes out of
public failures. Preserve old consumers through explicit versioned/backward-compatible
error mapping when implemented. Test deterministic200+409 races separately from
this pre-write outcome and preserve unrelated500s.

FFmpeg cut-only audio already uses5ms non-overlapping fades; Remotion caption-bearing
audio retains hard cuts. Reuse existing behavior honestly and require actual decoded
audio/listening proof for the caption-bearing path. Do not call a visual dissolve an
audio crossfade or infer safety from one successful cut-only render.

## 9. Availability, resources and acquisition options

| Route checked                                                       | Availability / fitness                                                                                                                                                          | Access and cost implications                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing licensed project sources + new local dual-human annotation | Sources available; no qualifying human labels or named annotators. Previously examined sources are pilot/train/diagnostic only. Novel held-out sources still needed.            | Preferred route; existing permitted media may avoid new media fees, but staff time and new-source privacy/licence approval remain. No outsourcing assigned.                                                                                                                                                                                       |
| AudioSet strong                                                     | Public human sound-event annotation metadata; Silence is perceptual, not the project's -60dBFS condition. No ready qualified EN/AR word/disfluency/audio reference established. | Annotation release CC-BY4.0. Original-media rights/availability require separate verification; no audio retrieved. Useful candidate/supplement, not automatic acceptance gold. [Official release](https://research.google.com/audioset/download_strong.html), [Silence definition](https://research.google.com/audioset/ontology/silence_1.html). |
| NXT Switchboard, LDC2009T26                                         | English disfluency reference lead; timing alignment and source audio require separate review. Not Arabic or acoustic-silence coverage.                                          | Listed noncommercial/share-alike terms; source speech is a separate corpus. Applicable fees require login, not a known quoted price. No agreement or download. [Official catalogue](https://catalog.ldc.upenn.edu/LDC2009T26).                                                                                                                    |
| CALLHOME Egyptian Arabic speech/transcripts                         | Separate speech and text products; turn timestamps are not independent word/filler/acoustic boundaries. No project access verified.                                             | LDC agreement/permission and account-specific fees; no cost invented. Supplements require annotation and source alignment. [Speech](https://catalog.ldc.upenn.edu/LDC97S45), [Transcripts](https://catalog.ldc.upenn.edu/LDC97T19).                                                                                                               |

These official pages were checked for this design. No paid account, corpus purchase,
download of new raw media, external sharing or contact with annotators occurred.
No reviewed candidate presently satisfies all reference requirements out of the box.

### Effort estimate — planning assumptions, not a vendor quote

For the proposed60minutes of natural audio, using the5-minute pilot to revise rates:

| Work                                                               | Estimated person-hours |
| ------------------------------------------------------------------ | ---------------------: |
| Source/rights/privacy/partition preparation                        |                   6–10 |
| Shared training/pilot and guideline refinement                     |                   6–10 |
| Two independent annotation passes, combined;12–20x audio time each |                  24–40 |
| Independent adjudication                                           |                   8–16 |
| Reference QA, integrity and freeze                                 |                    4–8 |
| **Human-reference work total**                                     |              **48–84** |
| Separate tooling/evaluator engineering                             |              **10–20** |

At an **illustrative, unquoted** blended human rate of USD20/40/60 per hour, human
work budgets are respectively USD960–1680 /1920–3360 /2880–5040. These are arithmetic
scenarios, not current market rates, offers or spending authorization. Add actual
licence/consent/storage charges, taxes and engineering costs if applicable; all are
currently unquoted. University volunteers still need real availability, competence,
consent/access approval and time; do not assume they exist or are cost-free.

Earliest completion depends on personnel and source approvals;48–84 staff-hours
is not a promised wall-clock deadline. Pilot findings may increase effort. No paid
LLM or annotation subscription is required by this proposal.

### Concrete acquisition sequence and Owner decisions

1. Approve protocol semantics: acoustic-class reference alongside unchanged historical
   NON_SPEECH, primary US203 span matching/aggregation, uncertainty handling and
   designated qualification scope. This accepts a reference protocol; it does not
   lower thresholds, close CP2 or enable removal.
2. Select/authorize the local annotation route and designate two qualified humans,
   an independent adjudicator and held-out custodian; approve a staff-time/budget cap.
   Obtain real quotes only if an external licensed route is chosen. Nobody is assigned
   by this report. Do not ask the Owner to create labels or run qualification tests.
3. Approve eligible source pools, rights/consent review and approved local access/
   retention locations. New collection and any external disclosure require explicit
   scope-specific authorization. No public service upload is currently permitted.
4. Conduct the authorized train-only pilot, document actual effort/IAA, and freeze
   the reviewed protocol, corpus version and partition before coding/tuning on dev.
   If resources or reference fitness still fail, retain BLOCKED_REFERENCE_DATA.
5. After reference readiness and Lead review, open the first sequential Draft PR
   for US203 detector + qualification harness. US223 is a later separate PR only
   after reference/CP2/safety gates. Lifting Issue96's dependency block remains an
   explicit Lead decision after independent acceptance, not a consequence of a draft.

## 10. Tooling design, synthetic checks and acceptance ledger

Possible future offline tooling: original-channel audio/waveform viewer, source-sample
cursor, independent per-rater JSON save, uncertainty and coverage tracks, role-separated
submission hashes and comparison/adjudication view. No network media fetch, ASR/VAD
prefill, remote analytics, credential capture or public export. Reuse approved local
access controls; do not build a new privileged service or security-gate infrastructure.
An annotation record needs dataset/protocol/source/PCM hashes, original scope/channel
clock, rater role/submission ID, word references, events/uncertainty, coverage, status
and actual human attestation. Unknown or unfilled attestations cannot count as human
gold. Tool operation is not evidence that a human listened.

Future synthetic software cases, always isolated from qualification metrics:

- overlapping/duplicate half-open intervals count union duration once;
- a meaningful word included with a filler cannot be an exact positive match;
- duplicate spans yield at most one TP; wrong class is not a TP;
- abstain-all yields NOT_PROVEN, not precision1;
- multichannel antiphase/quiet music can satisfy acoustic conditions without removal;
- uncertainty that could change pass/fail blocks qualification;
- grouped splits reject recurring-speaker/source leakage;
- infeasible target yields no commit/render; solver uncertainty is not proven infeasibility;
- original gold/model/guard files stay unchanged; all synthetic/example records are
  tagged SYNTHETIC_SOFTWARE_FIXTURE or UNFILLED_TEMPLATE, never independent-human.

No annotation application or production evaluator is implemented in this stage.
Only the specification, machine-readable protocol, source/evidence inventory and
consistency/preservation checks are prepared. Actual IAA, US203 human-reference
precision and independent-natural CP2 F1 are **NOT_MEASURED**, never0 or PASS.

Existing restrictions: CP1 NOT_VERIFIED, CP2 NOT_MET, Tiny Arabic NOT_QUALIFIED,
PLANNER_NOT_CONFIGURED;600000ms ASR deadline and existing CI budgets unchanged.
Automatic nonempty removal remains fail-closed; no US309 PR, Ready transition,
merge, deploy, paid/live provider or independent-QA impersonation. All27 protected
files, original gold and frozen graduation/evidence packages remain unchanged.
