# PR53 repair evidence and residual findings

Repair target: `2f1b91863256c79c52681e2918d9a6f29dd90b85` (US-218 / US-222).

## H1 and M1

The old builder independently reproduced 45 correct video frames / 1.8 seconds
with only 0.905 seconds of audio. Its MP4 SHA-256 is
`88cd0db2c87c56cb97a8ef215a1dfee73affceb95a22bb1b8b869e45bfafa8c3`.
The repaired validator rejects that artifact. Independent segment inputs,
sample-count join ramps and audio concat address backward/repeated extraction
and the separately observed short-input acrossfade truncation. The production
static build enables exactly the needed `afade` filter and asserts its presence.
It retains disabled network/libxml2/DASH and the existing protocol/option policy.

Permanent fixed-sample fixtures use x264/yuv420p B-frames, known pulse/flash
positions, 25/30/30000:1001 fps and mono 48 kHz/stereo 44.1 kHz/missing audio.
Their truth is defined before rendering. Native tests cover seven cut arrangements
at each rate plus 20 repeated short fractional encodes. Production evidence is
emitted by the real PostgreSQL/BullMQ/S3/constrained-executor harness into
`.local/render-batch/audio-report.json`; CI archives this directory.
Non-flash frame identities differ by at least 28 in one RGB channel, greater
than twice the declared codec allowance of 8. A neighboring frame cannot pass
as the correct frame. The strengthened native and complete container suites pass.

The completed production suite verified 28 positive audio/resize/speed artifacts
and a seeded negative artifact. All 21 queued cut cases selected FFmpeg. The
original 25-fps arrangement decodes 45 video frames: its logical audio is exactly
86400 samples / 1.8 seconds, with 87040 decoded AAC samples (640 padding samples)
and five aligned authored beeps. Truncated cached output fails its durable Job;
same-sized modified stored bytes fail checksum verification before reuse. The
source-hash, seven-tool, storage-retry, post-upload SQL failure, cancellation,
timeline/caption/emoji golden-frame and container isolation regressions pass in
the same default production suite.

The CFR probe uses a bounded complete presentation-time prefix rather than
interleaved packet count / decoder-flush frames. Twelve real GOP/B-frame profiles
are covered, with explicit unsupported rate/VFR/rotation/codec/HDR rejection.

## M2 attribution

The exact merged base `174f83ef488a24b754028c70a67fd3dbb679e94f` and failed PR
head were built and forced through Remotion in matching production-container
controls. The paired outputs are byte-identical, establishing inherited behavior.
Source SHA: `93f63fc6ac4bf62e86f2bb675bded17d3e7273153050b215bdfe423d66aba340`.

| Frames at 30 fps | Video seconds | AAC/movie seconds | Paired MP4 SHA-256                                                 |
| ---------------- | ------------- | ----------------- | ------------------------------------------------------------------ |
| 50               | 1.666667      | 1.685000          | `47f8e19f5f7834d8bfd3dab4fd9db1c28ec826bb55542288228a5b79fdc17b56` |
| 75               | 2.500000      | 2.517000          | `478d22f5e120ac7a4231105571a49dc4c83b1c4270180c556801caea4199892e` |

Both old validators rejected these outputs. The repair checks exact video clocks,
complete decoded audio and bounded AAC packet padding separately. It preserves
logical frame duration in canonical metadata. It does not claim compressed AAC
has bit-exact sample values or that arbitrary A/V drift is acceptable. Forced
Remotion end-audio cases remain in the production suite to prevent routing from
masking this finding. Follow-up: [Issue54](https://github.com/mahmoudemad68/Your_Editor/issues/54).

A separate 49-frame / 25-fps Remotion gap experiment declared 94224 audio
samples but decoded 94208; both cover the required 94080 samples. The validator
allows at most one incomplete AAC packet between the declared edit duration and
decoded duration, while still requiring the entire expected composition sample
count. This codec-tail allowance cannot excuse the H1 audio shortfall.

## Low findings

L1: video-preserving transforms retain an inspected CFR count when the only
container discrepancy is at most one millisecond. A valid rounded-up duration
`5972634` us previously allocated 180 frames for a 179-frame 30000:1001 source.
The native real resize regression decodes exactly 179 frames.
The real SDK/container resize also decodes 179 frames, with no 180th frame.

L2: chained pitch-preserving atempo at 1/3 speed shifts short transients. The
fixed fixture nominal slowed beep onset is 1.215 seconds; a native experiment
observed approximately 1.128 seconds. No fixed offset, fabricated silence or
widened sync acceptance was introduced. The production diagnostic reports the
actual onset as 1.125854 seconds (89.146 ms early) and `NOT_PROVEN` sync acceptance.
This nonblocking quality limitation
is tracked in Issue54; exact slow-speed transient alignment is not claimed.

L3: two real consumer-invalid normalization calls fail permanently on attempt 1
with acknowledged cleanup and no edited output, but each retains 1000 micros
with `cost_basis=reserved`. This extends the documented conservative consumer
failure policy in [Issue51](https://github.com/mahmoudemad68/Your_Editor/issues/51).
It remains a nonblocking budget-exhaustion risk. Inspection work did occur; no
unproven zero-cost refund or accounting reset is introduced here.

L4: a real committed audit-attachment / pre-enqueue cancellation is independently
reproduced five times using the exact merged-base SDK and five times using the
repair SDK against real PostgreSQL/Redis/BullMQ. All ten settle Cancelled, release
cost to zero, have no Job or publication row and have no worker side effects.
The planned `job_id` nevertheless remains in the settled audit. Migration 0013
does not give that field a Job foreign key, and the unchanged dispatcher records
it before enqueue. The production-container path independently reproduces it.
This is inherited, not a repair regression, but remains a nonblocking audit-link
integrity limitation: consumers must not assume every planned job was admitted.
Follow-up should distinguish planned identity from an established Job relationship
without weakening admission fences or resetting historical audit/cost records.
No SDK accounting/fencing or permission changes are part of this repair.
Existing [Issue50](https://github.com/mahmoudemad68/Your_Editor/issues/50) remains open.

## Test-environment findings

A local full-container attempt failed MinIO's real storage-full safety check;
only superseded task-owned Docker cache/images were reclaimed. Another attempt
under concurrent self-test load failed the unchanged 10-second timeout/browser
observation; an isolated run passed it without deadline/assertion changes. The
subsequent static-build omission was independently diagnosed and corrected before
claiming any complete production-suite pass. Failed attempts are retained in the
repair logs and are not counted as successful evidence.

A new HDR negative fixture initially failed because its encoder did not retain
the transfer flag alone. The fixture now authors complete PQ/BT.2020 signaling
and independently asserts the actual FFprobe transfer value before requiring
selector rejection. The isolated 13-case CFR suite passes; no HDR eligibility
rule was relaxed. The parallel local aggregate also exceeded the unchanged
US-128 120-second suite deadline and lacked the auth-browser executable.
Sequential package execution and an explicit verified local browser prerequisite
are used for subsequent local checks; test deadlines/assertions remain unchanged.

All 87 media-worker tests pass with Docker's existing Tini subreaper, matching
production `--init`. The bare managed host retains orphaned descendant zombies,
which makes the unchanged US-129 process/group existence checks fail. Under Tini,
the same assertions pass (442 ms cancellation / 651 ms timeout cleanup). No
production supervisor, PID assertion or deadline is changed. All 365 root
architecture/integration tests pass against real services, including the existing
Tool SDK crash, budget, permission and publication-recovery corpus.

The local API corpus passes 110 of 111 tests. Its unchanged SeaweedFS multipart
test requires CORS OPTIONS HTTP 200; the disposable MinIO harness returns 204.
All preceding upload/checksum/idempotency assertions pass. Relevant test and
production files match merged main; this provider-specific assertion is retained.
Required CI uses the repository's normal infrastructure and remains authoritative
for the aggregate gates. Local failed aggregate attempts are not reported as passes.

The final executor and coordinator scans each retain the same 44 High vulnerability
identities as the captured main baseline, with zero new High/Critical identities
and zero image secrets using the same database snapshot. Node retains two existing
High advisories. These baseline findings and Issue50 are not hidden.

## Remaining verification limits

The editing manifest's 300000-ms timeout is checked, and the existing real remote
deadline/outage tests pass; expiration of a full five-minute editing-tool call was
not separately exercised. Actual post-upload SQL rollback/retry, stored-byte
corruption and general real-service SIGKILL admission/publication recovery are
tested. SIGKILL specifically after a media S3 upload and before PostgreSQL
acknowledgment is not claimed as proven by the SQL rollback test. L2–L4 above
remain explicit nonblocking findings pending follow-up and independent review.

No deployment, merge or Ready transition is authorized by this evidence.

## QA53R-1 and AAC-tail resize follow-up

Independent Re-QA rejected `43a253fc7a9f652d13874de504cd79b4418e7153`.
Both new reproductions were confirmed in that exact non-root production executor:
the 56-frame 30000/1001 case produced 89688 logical audio samples instead of
89690, and the 179-frame source with a 6000000-us AAC/container end resized to
180 frames. The previous resize fix covered only header rounding; it did not
cover this independently reproduced longer audio tail.

Gap audio now uses `anullsrc=r=48000:cl=stereo,atrim=end_sample=...`.
The finite consumer owns EOF at the exact cumulative rational sample boundary;
the producer cannot prematurely stop at a rounded microsecond duration.
Every branch terminates, and the existing execution timeout, capture, file,
process and container limits remain intact. Segment demuxer isolation and
sample-count non-overlapping fades remain unchanged. The strict output validator
is unchanged.

Video-preserving edits use the verified CFR video stream's count independently
of the audio/container end. The source clock must still cover that video stream;
a materially shorter asset clock is rejected. Resize retains 179 frames rather
than manufacturing a frame for an AAC or audio tail. Audio is bounded to the
resulting video's sample clock by the existing edit recipe; source bytes are
never modified.

Permanent real-FFmpeg tests cover the exact 56-frame reproduction, 58 frames with
17 segments and 8 inputs, one/multiple gaps, leading/middle/trailing one- and
two-frame gaps, repeated/backward and mixed-audio sources, and 25, 30,
30000/1001, 24000/1001 and 60000/1001 fps. The independent expectations use
authored sample/frame truth, not detector or render output. Additional production
fixtures honor the existing integer-us 1:1 domain rounding phase before rendering;
no domain or selector rule is weakened to admit a fixture.

The production queue suite includes a real AAC-tail resize with source frame
identities, sample timing, durable audit outcome and immutable S3 output checks.
The regression oracle also rejects an actual same-length silent replacement by
its missing authored beeps. That is a content regression test, not a claim that
the general runtime validator can prove arbitrary audio semantics. L2/#54,
L3/#51, planned-Job audit linkage and the #50 isolation risk remain visible.

Independent decoding of the production-image regression artifacts confirms:

| Fixture                                       | Video frames | Logical 48-kHz samples | Decoded samples including AAC padding |
| --------------------------------------------- | -----------: | ---------------------: | ------------------------------------: |
| Exact QA53R-1, 30000/1001                     |           56 |                  89690 |                                 90112 |
| Maximum 17-segment / 8-source fractional case |           58 |                  92893 |                                 93184 |
| Original H1 at 25 fps                         |           45 |                  86400 |                                 87040 |
| 179-frame AAC-tail resize                     |          179 |                 286686 |                                286720 |

The H1 beeps remain aligned at frames 0, 10, 25, 35 and 37. The resize oracle
checks all 179 authored frame identities, not merely the container frame-count
header. Native real-FFmpeg regression coverage passes 60 cases across five frame
rates, plus the parent test, retaining 20 repeated short fractional encodes.

Early local attempts are retained as failures: disposable S3 rejected uploads
when the 32-GB workspace fell below its free-space threshold; a subsequent
unchanged Remotion startup failed with a closed browser target. A completed
editing-only run exposed two new test references sharing an artifact filename;
labels are now unique and asserted before download. Independent decode oracles
use bounded decoder threads to avoid host process exhaustion. No production
probe, render deadline, assertion, permission or isolation control is relaxed.
The complete default suite and exact-head workflow results are recorded in the
PR handoff rather than inferred from partial local runs.

The five-minute expiration, exact post-S3-upload SIGKILL window and corruption
during an in-flight retry remain separately NOT_PROVEN unless additional
executed evidence is supplied. Existing cached-byte corruption, SQL rollback,
publication recovery and reservation accounting tests do not imply those exact
windows were exercised. The new mid-render revocation probe waits for a genuine
FFmpeg process, revokes the current member, and requires no S3 write, no published
intent, a settled non-successful audit/job and unchanged settlement on recovery.
