# Source-bound word captions — US-312 / US-313

Issue #92 is one captions-only batch. Production planning remains
`PLANNER_NOT_CONFIGURED`; no hosted provider or paid call is needed. CP1 remains
NOT_VERIFIED, CP2 NOT_MET, Tiny Arabic NOT_QUALIFIED, and full US-305 AC1 remains
NOT_MET_DEPENDENCY. Caption delivery alone does not authorize silence removal.

## Baseline and dependency inventory

Base main: `8ccaac7ab4f86b0382ee53f729bc70c90afeb704`, including merged PR #88.
US-201 supplies persisted, versioned MediaAnalysis words and source/model
provenance. US-217 supplies canonical Timeline, half-open 1:1 source mappings,
strict commands, replay and CommandBus inverses. US-219 supplies strict versioned
Tool SDK manifests, membership/resource permission checks and durable unique
execution admission. The existing Remotion TimelineV1 supports legacy static
captions and UnicodeText; it did not support timed words or caption tools.

| Gap                           | Reused authority                                                   | Added path                                                                                 |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Word paint and source mapping | Rational microsecond clock, Timeline source clips, installed fonts | Source-bound caption track 1.0.0 and word-captions-v1 compile-time binding                 |
| Caption creation/style        | ToolRegistry, ToolExecutor, PostgresToolAuthority                  | editing.add-caption and editing.update-caption-style, pinned 1.0.0                         |
| Persistent edits/undo         | editing_timelines CAS and domain inverse/replay                    | AddTimedCaption / UpdateCaptionStyle command v2; additive migration 0024 receipts/inverses |
| User workflow                 | Authenticated API, editor BFF, existing timeline/render/download   | Explicit caption controls; no planner enablement                                           |

This inventory identifies reusable implementation, not an independent QA verdict.
Real bilingual visuals, frame measurements and Linux integration remain required
before this batch can be reported ready.

Decoded-video boundary qualification calibrates native word paint through the
same H.264/yuv420p/CRF23/veryfast profile as production. Chroma subsampling changes
thin glyph colors; lossless PNG RGB thresholds alone are not a codec reference.
The probe retains native pixels whose active color survives that reference encode,
never selecting coordinates from the actual video under test. To avoid treating
achromatic codec brightness changes as missing color, each witness compares both
R-B and G-B chroma with the midpoint of its independent active/inactive codec
controls (neutral chroma is clamped at zero). This rejects black, white and lone
red/green paint; the threshold is not fitted to the actual video.
The encoded witness uses separable chroma and the existing visible-signal floor
(a channel above 32), not the obsolete absolute RGB cutoff. Near-black encoded
noise is unmeasurable and rejected. This matters for thin Arabic strokes whose
chroma survives while their encoded luma changes. Original raw RGB,
codec-mask RGB and calibrated fractions are all reported. A native end-frame codec control must have
at most 20% target paint; actual active/inactive thresholds remain 70%/20%, with
more than four measurable pixels and zero measured onset/end frame error. Missing,
unmeasurable, persistent or wrong-word paint fails closed. Independent native
shaping comparisons still cover every glyph in the separate lossless frame matrix.

## Versions and historical compatibility

Legacy caption clips, TimelineV1, project schema v1 and command schema v1 remain
unchanged. A Timeline with captions carries optional `captionsV1`, absent from old
snapshot serialization. Project exports with that field use schemaVersion
`1.1.0`; old project exports retain integer `1`. New caption commands use integer
version `2` and a separate closed schema. Caption-bearing logs/history/inverses
use `1.1.0`; readers retain historical version 1. No new data is silently
represented as an old project or old command. Migration 0024 adds only caption
request/command receipts; it does not rewrite existing rows or immutable media.

The renderer accepts the explicit extended Timeline shape as well as the original
shape, independently applies domain invariants and selects Remotion for timed
captions. The compile-time `word-captions-v1` component has typed version-1.0.0
props; its implementation is bound by the existing content-addressed render
bundle/version, and the job's Timeline/content hashes bind the exact caption data.
There is no user-supplied JavaScript, component source, font URL or CSS.

## Evidence and coordinate ownership

The initial authenticated add tool reads only **current persisted Small-model**
MediaAnalysis. It compares asset/project, source SHA-256, source duration,
document hash/version and completed transcript state, then copies original words,
times and confidence (missing confidence is explicit null). It does not infer
language from text or repair ASR. Missing analysis, unsupported model/alignment,
stale hashes, malformed/overlapping words or unreadable output fail closed.
There is no Tiny-to-Small substitution and no public human-timing ingestion in
this initial path. The data type reserves a labelled human-timed evidence kind;
it is not permission to manufacture or impersonate that evidence.

Persisted blocks use original source microseconds. Each render projects them
through retained 1:1 source spans. Within a single track, clips form one span
only when both source endpoints and composition endpoints touch with the same
offset. A non-destructive split, including a split inside a word, does not remove
audio and must not hide that word. Source gaps, composition gaps, reordering and
different tracks never bridge. The derived render plan records the contributing
clip IDs; persisted source/evidence records remain unchanged:

`compositionTime = sourceTime - clip.inPoint + clip.timelineStartUs`.

Only complete native word intervals inside the retained source span are displayed.
An interval cut in half by a trim is not assigned a guessed boundary; its original
record stays intact in the stored caption track. Removed source content never
reappears. Caption projection must still meet the same readability constraints
after a trim. If clipping a block makes its display duration or reading speed
invalid, bounded whole-word reflow may use retained silence before or after the
native words. Display containers stay inside the retained span and cannot overlap
adjacent containers or lexical items. Native word starts/ends never move. This
render-only operation does not change saved blocks, hashes, undo or command replay.
Impossible layouts still fail explicitly. Concurrent competing caption projections
are refused until an explicit multi-speaker layout policy exists.

Half-open word activation compares the exact rounded rational frame clock with
the original mapped start/end; gaps have no highlighted word. Display padding
for reading is distinct from lexical timing. No epsilon or fabricated speech
timestamps are introduced. Source hashes/durations are checked again against
verified assets at both coordinator and renderer staging boundaries.

## Readability and safe zones

Segmentation is deterministic, whole-word and grapheme-aware: at most two lines,
using bounded suffix dynamic programming to regroup a short final block rather
than relax limits or drop words. Each start considers at most the configured
line capacity in whole words; ties select the longest prefix deterministically.
There are
at most 32 graphemes per line (reduced conservatively for available pixel width),
at most 24 displayed characters/second, minimum 500 ms and maximum 6 s per block.
Padding cannot pass the next source word or source end. Oversized indivisible
words, excessive speed or impossible layout are refused rather than truncated.
Source-domain input is bounded to 60 minutes, 36,000 words, 2,000 blocks, 16 caption
tracks. The unchanged Tool SDK additionally bounds serialized command size to
65,536 characters and canonical JSON to 1 MiB; oversized tool requests fail.
The existing production renderer's 30-minute/frame/resource admission is retained;
60-minute domain tests do not claim a 60-minute production render qualification.

Safe-zone exclusions are permille of output dimensions:

| Preset                                       | Left | Right | Top | Bottom |
| -------------------------------------------- | ---- | ----- | --- | ------ |
| 9:16 Reel/Short/TikTok conservative fallback | 80   | 180   | 120 | 220    |
| 1:1                                          | 80   | 80    | 80  | 160    |
| 16:9                                         | 60   | 60    | 80  | 140    |

An optional additional 0–100 permille margin is applied on all sides.
Orientation must match the selected preset (portrait, square or landscape);
an incompatible style update is rejected before a Timeline effect. These are
documented conservative project presets, not a guarantee against every platform
UI revision. Placement is bottom-center within that rectangle. No qualified face
tracks are available to this caption path; no face/speaker avoidance is claimed.
Known installed DejaVu Sans/Noto Color Emoji fonts are used. Styles accept only
bounded hex colors, 8–96 pixel fonts, 0–2 pixel outline, 0–4 pixel shadow and known
direction/preset enums. Foreground, background and highlight colors must differ.
The editor defaults to 4% of composition width, clamped to 14–48 pixels (28 at
720 pixels), and the tool adapts line length to that size within the same safe
zone. The former 10-pixel default at 360 pixels produced thin strokes whose
active color was substantially attenuated by H.264/yuv420p encoding. Existing
saved styles are preserved; the default does not qualify every allowed custom
font size or palette for every codec/profile.
Arbitrary palettes are not advertised as independently qualified accessibility
combinations. The browser measures actual caption bounds during visual
qualification; conservative domain width/line-height bounds are an additional
admission check, not a substitute for visual proof.

Arabic shaping uses a continuous Unicode text stream. The native CSS Highlight
API paints an active DOM Range without inserting a span at every word boundary.
Emoji runs reuse the existing UnicodeText fallback.
Remotion moves its preparation portal into the capture canvas after initial
mount. Live Range endpoints collapse when that subtree moves. The component
observes DOM placement and rebinds the range before releasing Remotion capture
readiness, including captures starting directly on an active word. React commits
and later DOM moves also refresh the binding. Existing render-readiness timeouts
remain in force; no clock offset or arbitrary sleep is used.
Oversized grapheme clusters and excessive combining-mark stacks are refused;
ordinary Arabic diacritics and emoji ZWJ clusters stay intact. Actual layout must
fit the selected zone at runtime; overflow is contained defensively and is not
used to claim that an unreadable block passed admission. Unsupported native highlight
support fails explicitly; the renderer does not degrade to unsynchronized text.

## Tool, persistence and security boundaries

Both manifests are closed, pinned 1.0.0, zero-cost in-process proposals with a
10-second admission deadline. add-caption requires project.read, timeline.propose,
asset.read and analysis.read. Style changes require current Owner/Editor project
authority and the caption's recorded creator; they preserve words, times and
evidence. Request input cannot assert actor, membership, permissions, URLs,
commands, transcript text or tool identity.

Output contains one bounded canonical serialized v2 command. This fits the
unchanged deliberately small SDK JSON-schema subset (including explicit null
confidence inside the serialized command). ToolExecutor independently parses the
closed command, checks subject/source/creator and applies domain invariants before
returning canonical commands. A string is never executed as code.

The API derives execution identity from current actor, project and request UUID,
persists admission before ToolExecutor, then commits command/inverse, Timeline
snapshot and resulting hash in one transaction. Membership/project locks order
revocation with commit; source/analysis locks and final evidence revalidation
prevent a stale proposal from becoming authority. Duplicate committed requests
return current authorized state without reapplying effects. A pending/unknown
receipt never re-executes the tool after restart. Tool audit success remains a
proposal receipt, distinct from the committed caption command record.

Undo requires the same actor, project, Timeline and exact current result hash,
and uses the domain inverse in a transaction. It cannot overwrite intervening
edits. History returns bounded status/identity metadata only; raw transcript and
inverse documents are not published through audit/SSE/logs. Existing CSRF,
membership, error redaction and render/export authorization remain in force.
Existing AgentRun lease/generation fencing is unchanged: this batch exposes
explicit user-directed caption commands, not autonomous planner execution.

## Qualification and remaining gates

Run domain/Tool SDK tests, schema compatibility, real PostgreSQL/Redis API and
receipt/restart tests, real bilingual upload/analysis/caption/render/browser proof,
actual Arabic/Bidi frame and safe-zone measurements, manual trim/split/export
regressions, all required exact-head CI/Walking Skeleton/Supply Chain checks.
The original evaluation gold, model identities, graduation deliverables and held
files must stay unchanged. Security-sensitive human reviews and Owner release
authorization remain separate from Coding Agent self-tests and Independent QA.

### QA93-F1 repair qualification

The Coding Agent reproduced the complete failure on diagnostic-only commit
`935e0d4831f17801e9ba30c7f3dabb16d7ec85d3`,
[CI run 40693482884](https://github.com/mahmoudemad68/Your_Editor/actions/runs/40693482884).
Source SHA-256 was `0e1f190e110bacf9f0cc55cab8b33ed7e46adec167011093153c5f668d41830f`;
the 34 native words in QA's array ordering hashed to
`524008ff7943485cb0a5bde7442aad45542974bde09993bbec82bc64e4a02904`,
matching the independent QA evidence exactly. A pending style response reset the
typed trim value; a subsequent trim response reset the split field. Requests for
trim 12 seconds and split 6 seconds actually persisted clips `[0,8)` and `[8,16)`.
The database state survived the API restart. The real render failed with typed
stage `caption_projection`, reason `min_duration`: per-clip projection clipped
caption display padding at a non-destructive source boundary. A first replay
that explicitly awaited every response passed; it did not reproduce the rapid
sequence and is not presented as proof that QA's failure was absent.

The original self-test split only between caption blocks; it did not qualify a
12-second trim, a 6-second split and an API process restart. The repair regression
is `apps/web/caption-demo/repair.spec.ts`, driven by
`tools/render/caption-repair-proof.mjs` on the existing real-service Linux render
test. It independently generates licensed AR-then-EN, 640×360, 25-fps input, obtains
actual pinned Small analysis, saves captions, styles, trims/splits, verifies a stale
undo is fenced and a current-state command really undoes, restarts the actual API
process, verifies the PostgreSQL snapshot and browser reload, renders, plays and
downloads the MP4. It compares complete retained native tuples, not just counts.
Rapid style/trim/split entry is tested with 250-ms real browser network latency,
without route interception or replacement service responses. Inputs are disabled
while a request or render is pending. A metadata-only clip replacement must not
reset draft time fields; only a selection or actual clip-coordinate change resets
them. The regression verifies the persisted coordinates equal the requested
12-second trim and 6-second split, rather than assuming a successful click applied
the intended value. The report includes requested/actual coordinates and a second
tuple hash using the original QA array ordering, avoiding hash-format confusion.
A second saved timeline deliberately splits the very same completed Small analysis
at the 8-second source-component boundary. This isolates render projection from
the rapid-entry race. All source words, native intervals, confidence and evidence
must remain identical; the complete retained projection must equal those original
tuples. A separate real render, playback, download and 400-frame FFprobe check are
required for `repair-boundary-export.mp4`. Neither test inserts fake analysis,
snapshots, tool receipts or completed Jobs.
Existing trim semantics retain the explicit 16-second composition; source content
ends at 12 seconds and the remaining range is black. FFprobe must verify 400 exact
25-fps video frames, 640×360 H.264, 48-kHz stereo AAC and the composition duration.

Mapping failures retain `TimelineMappingError.stage` and their original cause.
Readability predicates have closed `CaptionReadabilityError.reason` codes.
`TimelineRenderContractError` remains a permanent job failure with the unchanged
public message `Invalid timeline render contract.` Its cause is non-enumerable;
no source identities, text, storage keys, stack or raw exception messages become
public failure details. Only bounded typed cause codes, hashes, counts, sanitized
screenshots and the newly generated licensed export enter the fixed CI artifact
allowlist. Private state and diagnostic files are excluded.

These are Coding Agent self-tests. The independent QA FAIL on frozen product
`09745c0b456aa17195ac815c13d1ad18f0921db4` is historical evidence and remains intact.
Re-QA readiness requires a new immutable repair SHA with all mandatory workflows
passing; the Coding Agent does not issue an Independent QA verdict.

### QA93-F2 optimistic concurrency

Independent Re-QA cleared F1 on `d7e23c4cfa6b9d6339a77b40407ffd75699caa62`
but found overlapping manual trims returning one success and one 500. The Coding
Agent reproduced that exact status pair with real PostgreSQL and authenticated
HTTP by pausing the losing SDK execution immediately before final command
validation, then committing the winner. No SQL/constraint exception or lost
database update was required: the stale command raised `DomainError`, which the
executor had classified as an unexpected `execution_failed` error.

Final SDK command application now classifies only a typed `DomainError` as
`invalid_commands`. The existing API adapter maps that known validation failure
to a bounded domain error; `TimelineEditor` rechecks current access and its
expected hash. An advanced hash yields the existing `TimelineConflict` / HTTP 409. An unchanged basis retains genuine invalid-input semantics. Unexpected
exceptions retain `execution_failed` / HTTP 500, even if a concurrent edit also
advanced the hash. No classification searches private exception-message text.

The existing PostgreSQL snapshot write remains one atomic conditional statement
under READ COMMITTED: current membership/project share locks and the expected
snapshot SHA fence the UPDATE. A loser writes zero Timeline rows. No transaction
isolation, database constraint, public schema, generation fence or retry policy
is weakened or replaced with a blanket SQL-error-to-conflict mapping.

Tool SDK receipts for trim/split describe **proposals**, not committed Timeline
effects. Two proposals may legitimately finish before only one wins the snapshot
CAS. The regression separately observes committed Timeline writes inside their
database transactions; it does not pretend proposal receipts are mutation
receipts. A stale hash replay is rejected before another tool execution. These
in-process tools create no external media effects. Caption command/inverse
receipts, render idempotency and AgentRun generation fences remain unchanged.

The barrier-based real PostgreSQL/HTTP regression covers late validation, two
valid proposals at CAS, identical requests, current versus stale bases, winner
snapshot/hash consistency, an unrelated 500 control, cancellation of an actually
blocked PostgreSQL UPDATE (57014, no partial writes), and real process loss after
commit followed by replay from a new process. Test-only transactional observers
prove one committed update and no duplicate media/jobs; no production endpoint
or migration adds test controls. The real Small browser qualification retains
both F1 video paths and adds a separate caption-bearing Timeline with concurrent
authenticated BFF trims, one HTTP 200 + one 409, stale replay 409, persisted winner
reload and unchanged original native words. Private credentials are not reported.
