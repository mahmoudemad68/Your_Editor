# US-216 / US-217 implementation evidence

This batch starts from `15d168e1444e9bae6cd206e11ef0206ae24bc709` (merged PR #42). The executable proof is `pnpm render:test`; `node tools/render/integration.mjs --no-build` reruns it against already-built production targets. CI runs the full build and proof and uploads `.local/render-batch/` as `render-evidence-<workflow SHA>`. MP4 files and process receipts remain outside git. This evidence is implementation self-testing, not Independent QA or a deployment.

## Real production-image render

The local combined proof passed with Remotion 4.0.534, React 19.3.0, Chrome Headless Shell 157.0.8080.0, Node 22.23.3 and the existing hardened FFmpeg/FFprobe 7.1.5-editagent1 build.

| Measurement                            | Observed result                                                    |
| -------------------------------------- | ------------------------------------------------------------------ |
| Five-second fixture                    | 150 frames, 320 × 180, 30/1 fps                                    |
| FFprobe duration                       | 5.000000 seconds (half-frame tolerance)                            |
| Output                                 | MP4, H.264, yuv420p, 19,143 bytes                                  |
| MP4 SHA-256                            | `720334362147c702fe7a80e59f32cd0c18574e06d2245aeea549347a7e5c2e27` |
| Local artifact                         | `.local/render-batch/fixture.mp4`                                  |
| Build-time bundle                      | One invocation, 15,855 ms; zero runtime invocations across jobs    |
| Queue/render/validate/upload wall time | 13,369 ms                                                          |
| Frame callback observations            | 151 distinct rendered-frame counts, including 0 and 150            |
| Observed browser processes             | Four owned Chrome processes, UID 10001                             |
| Largest sampled render-child RSS       | 135,118,848 bytes; not an aggregate process-tree peak              |
| Internal frame concurrency             | Two; worker concurrency one                                        |

The installed render version was `386aba167a7c3b1e2e591a57dd88d56027743e763523cb9622f404102328e8fb`. Build identity and wall time are environment-dependent; the CI artifact records the version and actual observations from its own exact commit. Bundle acquisition happens at image build, not per job. The test independently downloads the actual S3 object and probes it, while the production adapter also validates its container, exact rational FPS, duration, dimensions and complete decoded frame count before upload.

The real queue proof exercises queued cancellation, active Chromium cancellation, duplicate cancellation, cancellation near completion and during upload, and timeout after observing live Chromium. Terminal cancelled jobs have no successful output. PID/start-time identities are checked independently after cancellation/timeout, and both scratch locations must be empty. Timeout intentionally produces `Failed`; the cancellation cases produce `Cancelled`. A simulated crash after real upload but before durable acknowledgement reuses the same verified object on retry. A transient upload failure retries without changing its key. Corrupt bytes and decodable H.264 in a non-MP4 container are rejected.

The US-110 logical-render metric for the worker fault-injection subset is 4 successful validated logical requests / 5 admitted logical requests = 0.8; the denominator includes the intentional timeout, counts retries once and excludes four explicit cancellations. The seven successful timeline renders are reported separately. These test fault injections are not a production success-rate estimate.

## Timeline acceptance evidence

All seven real TimelineV1 MP4s passed production validation and independent decoded-frame/audio probes:

- `cut-offset-gap.mp4`: exact analytically defined RGBA hashes at frames 0, 29, 30, 31, 59, 60, 61 and 89; source A/V offsets yield the expected 440/880 Hz regions and silent gap.
- `fractional-cut.mp4`: exact 30000/1001 FPS and 60 decoded frames; exact black/white hashes at frames 0, 29, 30, 31 and 59. Video time is 2.002 seconds; container duration is 2.005 seconds from AAC framing, within the documented half-frame tolerance.
- `graphics.mp4`: registered solid component appears and disappears exactly at frames 0/29 and 30/31, respectively.
- `caption-unicode.mp4`: Arabic/emoji text renders as visible pixels and ends exactly at frame 30.
- `dissolve.mp4`: the six-frame visual opacity ramp produces RGB probes 43, 128 and 255 at frames 30, 32 and 35; clip placement and audio timing remain unchanged.
- `audio-track-offset.mp4`: the separate audio track is active only in its 0.5–1.5 second window, reading the expected source-offset tone; surrounding video audio is attenuated by the configured -60 dB.
- `title-safe-text.mp4`: a title containing literal `<script>` and multilingual text renders through React text nodes and ends at frame 30.

Golden black/white hashes come from analytically constructed pixels before rendering, not from accepting the current renderer's output as its own reference. Unit tests additionally cover rounded microsecond boundaries, fractional rates, source offsets, layer order, gain, malformed timelines and component binding validation. Unknown components fail the real queue path before Chromium starts. Cross-project, viewer and unvalidated-source requests are rejected; an authorized Owner request is accepted.

## Security posture and remaining limits

The real browser argv contains `--no-sandbox` and `--disable-setuid-sandbox`, under the explicit Issue #45 Owner exception. Non-root execution is not browser sandboxing. The proof verifies UID/GID 10001, network mode `none`, read-only root, dropped capabilities, default seccomp, no-new-privileges, bounded cgroups/tmpfs and no host bind mounts. Executor fetches to public IP, metadata IP and storage fail. Startup without mandatory controls fails. The actual Chrome process maps show the pinned, fixed Expat 2.9.0 library; its loaded library SHA-256 is `4adf32051b056fd3122847dd8e27cb691472c698dfe48b354e4f5aa3ad4a9a80`.

Residual browser/kernel risks, the two-container deployment requirements, compile-time component registry, source-byte budgets, execution limits and constrained private-storage resolution are described in [rendering.md](rendering.md). The database upload API still admits video media only. Visual dissolves are explicitly not audio crossfades. No user-code execution, public render API, Timeline editing, US-218 strategy or unrelated Issues #43/#44 repair is included. Existing US-110 generated-gold provenance and CP2 `NOT_MET` remain unchanged.
