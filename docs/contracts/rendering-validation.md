# US-216 / US-217 implementation evidence

This batch starts from `15d168e1444e9bae6cd206e11ef0206ae24bc709` (merged PR #42). The executable proof is `pnpm render:test`; `node tools/render/integration.mjs --no-build` reruns it against already-built production targets. CI runs the full build and proof and uploads `.local/render-batch/` as `render-evidence-<workflow SHA>`. MP4 files and process receipts remain outside git. This evidence is implementation self-testing, not Independent QA or a deployment.

## Original pre-QA production-image render

The local combined proof passed with Remotion 4.0.534, React 19.3.0, Chrome Headless Shell 157.0.8080.0, Node 22.23.3 and the existing hardened FFmpeg/FFprobe 7.1.5-editagent1 build.

| Measurement                            | Observed result                                                    |
| -------------------------------------- | ------------------------------------------------------------------ |
| Five-second fixture                    | 150 frames, 320 × 180, 30/1 fps                                    |
| FFprobe duration                       | 5.000000 seconds (half-frame tolerance)                            |
| Output                                 | MP4, H.264, yuv420p, 19,143 bytes                                  |
| MP4 SHA-256                            | `720334362147c702fe7a80e59f32cd0c18574e06d2245aeea549347a7e5c2e27` |
| Local artifact                         | `.local/render-batch/fixture.mp4`                                  |
| Build-time bundle                      | One invocation, 18,059 ms; zero runtime invocations across jobs    |
| Queue/render/validate/upload wall time | 9,024 ms                                                           |
| Frame callback observations            | 151 distinct rendered-frame counts, including 0 and 150            |
| Observed browser processes             | Four owned Chrome processes, UID 10001                             |
| Largest sampled render-child RSS       | 141,631,488 bytes; not an aggregate process-tree peak              |
| Internal frame concurrency             | Two; worker concurrency one                                        |

The installed render version was `a89bcae9aadadc2e6a5f3bbcfc1bf4586b1169aafaf996b1a337a5d98cee62d4`. Build identity and wall time are environment-dependent; the CI artifact records the version and actual observations from its own exact commit. Bundle acquisition happens at image build, not per job. The test independently downloads the actual S3 object and probes it, while the production adapter also validates its container, exact rational FPS, duration, dimensions and complete decoded frame count before upload.

The real queue proof exercises queued cancellation, active Chromium cancellation, duplicate cancellation, cancellation near completion and during upload, and timeout after observing live Chromium. Terminal cancelled jobs have no successful output. PID/start-time identities are checked independently after cancellation/timeout, and both scratch locations must be empty. Timeout intentionally produces `Failed`; the cancellation cases produce `Cancelled`. A simulated crash after real upload but before durable acknowledgement reuses the same verified object on retry. A transient upload failure retries without changing its key. Corrupt bytes and decodable H.264 in a non-MP4 container are rejected.

The US-110 logical-render metric for the worker fault-injection subset is 4 successful validated logical requests / 5 admitted logical requests = 0.8; the denominator includes the intentional timeout, counts retries once and excludes four explicit cancellations. The seven successful timeline renders are reported separately. These test fault injections are not a production success-rate estimate.

## Timeline acceptance evidence

All seven real TimelineV1 MP4s passed production validation and independent decoded-frame/audio probes:

- `cut-offset-gap.mp4`: exact analytically defined RGBA hashes at frames 0, 29, 30, 31, 59, 60, 61 and 89; source A/V offsets yield the expected 440/880 Hz regions and silent gap.
- `fractional-cut.mp4`: exact 30000/1001 FPS and 60 decoded frames; exact black/white hashes at frames 0, 29, 30, 31 and 59. Video time is 2.002 seconds; container duration is 2.005 seconds from AAC framing, within the documented half-frame tolerance.
- `graphics.mp4`: registered solid component appears and disappears exactly at frames 0/29 and 30/31, respectively.
- `caption-unicode.mp4`: the original visible-pixel probe proved text visibility and frame-30 removal, but did not distinguish emoji glyphs from missing-glyph boxes. Independent QA identified that coverage gap; the repair below adds independent glyph references.
- `dissolve.mp4`: the six-frame visual opacity ramp produces RGB probes 43, 128 and 255 at frames 30, 32 and 35; clip placement and audio timing remain unchanged.
- `audio-track-offset.mp4`: the separate audio track is active only in its 0.5–1.5 second window, reading the expected source-offset tone; surrounding video audio is attenuated by the configured -60 dB.
- `title-safe-text.mp4`: a title containing literal `<script>` and multilingual text renders through React text nodes and ends at frame 30.

Golden black/white hashes come from analytically constructed pixels before rendering, not from accepting the current renderer's output as its own reference. Unit tests additionally cover rounded microsecond boundaries, fractional rates, source offsets, layer order, gain, malformed timelines and component binding validation. Unknown components fail the real queue path before Chromium starts. Cross-project, viewer and unvalidated-source requests are rejected; an authorized Owner request is accepted.

## Security posture and remaining limits

The real browser argv contains `--no-sandbox` and `--disable-setuid-sandbox`, under the explicit Issue #45 Owner exception. Non-root execution is not browser sandboxing. The proof verifies UID/GID 10001, network mode `none`, read-only root, dropped capabilities, default seccomp, no-new-privileges, bounded cgroups/tmpfs and no host bind mounts. Executor fetches to public IP, metadata IP and storage fail. Startup without mandatory controls fails. The actual Chrome process maps show the pinned, fixed Expat 2.9.0 library; its loaded library SHA-256 is `4adf32051b056fd3122847dd8e27cb691472c698dfe48b354e4f5aa3ad4a9a80`.

Residual browser/kernel risks, the two-container deployment requirements, compile-time component registry, source-byte budgets, execution limits and constrained private-storage resolution are described in [rendering.md](rendering.md). The database upload API still admits video media only. Visual dissolves are explicitly not audio crossfades. No user-code execution, public render API, Timeline editing, US-218 strategy or unrelated Issues #43/#44 repair is included. Existing US-110 generated-gold provenance and CP2 `NOT_MET` remain unchanged.

The final local regression run passed all 24 package test tasks and 320 root integration tests, including 500 real readiness probes with zero warning/listener accumulation. The unchanged browser multipart-resume test missed its existing five-second completion assertion on this two-CPU workspace; 15 other browser regressions passed. The earlier full-disk render attempt failed at MinIO storage admission and passed unchanged after unused build-cache cleanup. These local failures remain recorded separately from the exact-head CI results in the PR. No production deadline or test assertion was weakened.

## Mandatory QA repairs: S3 readiness and emoji output

The reviewed `7d07f6ee84095a72be7112b76a940d5a3abd9dca` coordinator was reproduced returning 200 with the real S3 container disconnected. Its readiness omitted storage; temporary S3 loss was not a liveness failure. The repair adds authenticated, bounded HeadBucket availability to the existing executor/Postgres/Redis probes, with only in-flight coalescing and no stale success cache.

The repaired production images use render identity `1fd45839aafdca14811fc25166a6e450249c42a040ff7bf6569f5011459016bf`. The first complete production-container proof passed startup with unavailable S3 (ready 503 / health 200), healthy operation, network disconnection (503, 1,064 ms), reconnect (200, 104 ms), silent paused S3 (503, 1,103 ms) and unpause (200, 121 ms). Every liveness response was 200 and the coordinator's start/restart identity remained unchanged. The SDK deadline remains 1,000 ms; HTTP measurements include handler overhead. Unit tests cover mandatory-dependency failure/recovery, shutdown, concurrent probe coalescing and silent SDK timeout.

A second complete production-container run passed unchanged: disconnection 503 in 1,095 ms, recovery 200 in 100 ms, silent storage 503 in 1,123 ms and unpause 200 in 152 ms. Liveness remained 200, startup with storage unavailable remained 503, and the coordinator did not restart. Both runs produced identical decoded emoji frame hashes.

The same complete proof rendered 17 timeline MP4s, retaining the original seven acceptance cases and adding emoji captions, a registered emoji title, repeatability and real negative controls. Official Noto Color Emoji 2.051 is checksum-pinned and installed at image build with its SIL OFL license. Actual decoded frame 15 matched independently extracted font glyph images for 😀, 👋, ❤️ (VS16), 👩‍💻 (ZWJ), 👍🏽 (skin modifier) and 🇪🇬 (regional-indicator pair). Mean spatial RGB errors were 3.73–10.98 / 255 against a predefined maximum of 30; every probe had 676–1,848 colored pixels. A white-box caption and an unjoined woman/laptop caption were rendered as negative controls and rejected. Repeated 😀 renders had identical decoded RGBA SHA-256 `194d8fdcc7256330c894a70ec6dadcf52f468a67fbcbbb931a0f103940a0c4b6`. All tested captions/titles disappeared at exact frame 30.

Color-font testing exposed tiny H.264 chroma-prediction residue at removal frames (maximum channel value 2), not a timeline-placement change. Supported encoder-hook keyframes at caption/graphics visibility boundaries remove that residue. Existing exact-black assertions, rational FPS, CRF and pixel format remain unchanged. Ordinary symbols, numbers and Arabic keep their existing shaping/font; complete emoji graphemes use the installed color font. No runtime font fetch, network access or schema change is introduced.

The five-second fixture remains 150 decoded frames, 320×180, 30/1 FPS, 5.000000 seconds, H.264/yuv420p, 19,143 bytes. All queue cancellation races, owned browser/child cleanup, timeout, conditional output/retry reuse, authorization, frame hashes and isolation assertions passed in the same production run. `.local/render-batch/report.json`, MP4s and decoded PNGs carry the actual identities; CI uploads the complete proof for its tested commit. Cross-machine encoded-byte equality is not claimed.

### Inherited failure attribution

The multipart browser test and three legacy media-worker queue integration test files are byte-identical to the merged pre-batch base `15d168e1444e9bae6cd206e11ef0206ae24bc709`; their production upload/queue code is unchanged by this repair. The earlier local multipart completion timeout and QA-reported legacy cleanup failures remain inherited findings, with no demonstrated repair-attributable product regression. No test deadline, cleanup assertion or unrelated production path was changed.

The reviewed-head CI transport revocation poll expected 404 within seven seconds but observed 200/503/200. The full unchanged CI rerun passed all 16 browser tests; isolated transport tests passed both untouched base (2/2) and reviewed head (2/2). A subscription/reconnect timing race is a possible explanation, not an established root cause. This remains an inconclusive inherited transport timing finding rather than a closed production fix; transport/controller code is untouched.

The repair's local unsuppressed image scans report zero Criticals and secrets in both images. Each has 44 High rows / nine unique CVEs, with no added (CVE, package, installed-version) High tuple versus the QA-tested images. No production dependency version or security exception/control changed. Node audit retains the two inherited High advisories; final exact-head workflow artifacts provide the CI scanner snapshot.
