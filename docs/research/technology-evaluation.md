# Technology evaluation

Sprint 1 research notes. The roadmap remains the source of truth for sequencing. This page records measurements. It does not choose a production render pipeline and it does not implement US-216.

## US-106 Rendering feasibility (FFmpeg vs Remotion)

### 1. Research question

For a 60-second 1080×1920 composition, how long do FFmpeg and Remotion take on the machine that ran this spike, and which class of edit belongs to each tool?

Two comparisons are kept separate:

- **Performance of the required FFmpeg cut-and-concat workflow.** Three accurate trims of the generated source, re-encoded with the shared x264 settings, then concatenated with stream copy. The picture is the test pattern only. It has no captions and no animated title.
- **Feature-oriented comparison.** Remotion draws the test pattern, twelve timed captions, and a title whose opacity and vertical position change every frame. A separate FFmpeg command burns the same words and a drawtext title animation into the same source. That FFmpeg output is closer, and it is still not a React composition.

### 2. Test hardware

This run is not the project's reference machine. The SRS says the reference machine is the host used for CP1 and CP4, and it does not name a CPU or GPU model. The numbers below were taken on the cloud VM that executed the spike.

| Item             | Value                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OS               | Ubuntu 24.04.4 LTS                                                                                                             |
| Kernel           | Linux 6.12.94+                                                                                                                 |
| CPU              | Intel(R) Xeon(R) Processor, 4 logical cores, 1 thread per core                                                                 |
| RAM              | 16,791,945,216 bytes (about 15.6 GiB)                                                                                          |
| GPU              | None detected. `nvidia-smi` is not installed                                                                                   |
| Disk             | overlay filesystem, 126G volume, about 86G free at the end of the run. `lsblk` reports `vda` 128G and `vdb` 256G with `ROTA=1` |
| Hardware encoder | Not used. Every encode is `libx264`                                                                                            |

`ROTA=1` on these virtio disks is not treated as proof of a spinning disk.

### 3. Software versions

| Tool                  | Version                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| Node.js               | v22.14.0                                                                 |
| pnpm                  | 10.33.3                                                                  |
| FFmpeg / FFprobe      | 6.1.1-3ubuntu5, `--enable-libx264`, no hardware encoder selected         |
| Remotion              | 4.0.532 (`remotion`, `@remotion/bundler`, `@remotion/renderer`)          |
| React                 | 18.3.1, used only by the benchmark package                               |
| Chrome Headless Shell | Chromium 149.0.7790.0, installed by `ensureBrowser()`                    |
| Docker                | 29.8.1                                                                   |
| Host Chrome           | Google Chrome 148.0.7778.96 is installed and was not used for the render |

Shared encode settings, held constant across strategies and trials: CRF 23, preset `veryfast`, H.264, AAC at 128 kb/s, 30 fps, 1080×1920. Remotion was asked for `yuv420p`. Its files are tagged `yuvj420p` (full-range 4:2:0). FFmpeg's own encodes are tagged `yuv420p`. That difference is recorded and was not "fixed" by switching presets.

Remotion concurrency was 2. It was not changed between trials.

### 4. Benchmark workloads

`spec.json` and `captions.json` define the workload.

| Property   | Value                                                             |
| ---------- | ----------------------------------------------------------------- |
| Resolution | 1080 × 1920                                                       |
| Aspect     | 9:16                                                              |
| Duration   | 60 seconds                                                        |
| Frame rate | 30 fps (1800 frames)                                              |
| Pictures   | Generated `testsrc2` plus a 440 Hz sine. No downloaded footage    |
| Captions   | Twelve lines, five seconds each                                   |
| Title      | The word EditAgent. Opacity and vertical offset follow sine waves |

The source file is produced by `scripts/generate-fixture.mjs` and is not committed.

### 5. Reproduction commands

From `tools/benchmarks/rendering`:

```bash
pnpm install --ignore-workspace
pnpm rebuild esbuild --ignore-workspace
env -u LD_LIBRARY_PATH node scripts/generate-fixture.mjs
env -u LD_LIBRARY_PATH node scripts/run-suite.mjs
```

The suite runs, for each strategy, one cold run, one warm-up, and three measured runs. Medians use only the three measured runs. CI does not call `run-suite.mjs`.

Container proof:

```bash
docker build -f docker/Dockerfile -t editagent-render-spike .
docker run --rm --shm-size=1g editagent-render-spike
```

### 6. FFmpeg measurements

Wall-clock seconds. Peak RSS is the largest sampled sum of `VmRSS` for the process tree. CPU seconds are the summed user and system ticks of every process the sampler observed.

**Cut-and-concat** (not visually equivalent to the Remotion composition):

| Run        | Seconds | CPU seconds | Peak RSS bytes |
| ---------- | ------: | ----------: | -------------: |
| cold       |  11.219 |       34.84 |    466,485,248 |
| warmup     |  11.339 |       35.77 |    466,460,672 |
| measured-1 |  11.438 |       36.11 |    466,608,128 |
| measured-2 |  10.813 |       34.01 |    466,333,696 |
| measured-3 |  10.833 |       34.04 |    466,604,032 |

Measured minimum 10.813, median 10.833, maximum 11.438. Peak RSS across measured runs 466,608,128 bytes. Median render seconds per output second: 0.181. Real-time factor 5.539 (faster than real time).

**Decorated FFmpeg** (burned captions and a drawtext title animation; still not a React composition):

| Run        | Seconds | CPU seconds | Peak RSS bytes |
| ---------- | ------: | ----------: | -------------: |
| cold       |   9.085 |       30.63 |    489,373,696 |
| warmup     |   9.078 |       30.69 |    492,228,608 |
| measured-1 |   9.014 |       30.37 |    476,573,696 |
| measured-2 |   8.927 |       30.29 |    489,390,080 |
| measured-3 |   8.908 |       30.23 |    492,515,328 |

Measured minimum 8.908, median 8.927, maximum 9.014. Peak RSS across measured runs 492,515,328 bytes. Median render seconds per output second: 0.149. Real-time factor 6.721.

The decorated encode is one pass. Cut-and-concat re-encodes three 20-second pieces and then copies them together, so it does more encode work and is slightly slower. Neither number is a Remotion render.

### 7. Remotion measurements

`renderMedia()` from `@remotion/renderer`, codec `h264`, CRF 23, preset `veryfast`, AAC, concurrency 2, `enableMultiProcessOnLinux: true`. Each run is a new Node process. Cold deletes `node_modules/.cache` before bundling. Warm-up and measured runs leave that cache in place.

| Run        | Wall seconds | Bundle seconds | Render seconds | Startup seconds | CPU seconds | Peak RSS bytes | Browser peak RSS bytes |
| ---------- | -----------: | -------------: | -------------: | --------------: | ----------: | -------------: | ---------------------: |
| cold       |      141.901 |          5.193 |        136.518 |           5.674 |      304.58 |  7,948,771,328 |          2,195,369,984 |
| warmup     |      155.778 |          5.997 |        149.547 |           6.487 |      357.34 |  7,677,652,992 |          2,217,484,288 |
| measured-1 |      135.649 |          1.266 |        134.197 |           1.768 |      294.58 |  7,822,417,920 |          2,249,322,496 |
| measured-2 |      139.644 |          1.282 |        138.164 |           1.782 |      299.24 |  7,362,584,576 |          2,161,991,680 |
| measured-3 |      141.973 |          1.321 |        140.458 |           1.809 |      306.75 |  8,640,839,680 |          2,165,755,904 |

The measured peak RSS is 8,640,839,680 bytes. The measured browser peak is 2,249,322,496 bytes. Both are the maximum of the three measured runs.

Measured wall time: minimum 135.649, median 139.644, maximum 141.973. Median render seconds per output second: 2.327. Real-time factor 0.430 (slower than real time).

Startup in the table is bundle time plus time until the first rendered frame. On the measured runs that is about 1.8 seconds. The frame render, not the bundle, is the cost. The warm-up was the slowest wall time. The three later runs were not faster than the cold run by enough to treat caching as the main lever.

Output file size for the Remotion renders was 46,093,947 bytes at 6,144,733 bits/s. The same file was produced for each Remotion run.

### 8. Comparison table

Medians of the three measured runs. Cut-and-concat is not feature-equivalent to the other two rows.

| Strategy              | Median seconds | Seconds per output second | Real-time factor |            Peak RSS | Output                      |
| --------------------- | -------------: | ------------------------: | ---------------: | ------------------: | --------------------------- |
| FFmpeg cut-and-concat |         10.833 |                     0.181 |            5.539 |   466,608,128 bytes | test pattern only           |
| FFmpeg decorated      |          8.927 |                     0.149 |            6.721 |   492,515,328 bytes | drawtext title and captions |
| Remotion              |        139.644 |                     2.327 |            0.430 | 8,640,839,680 bytes | React title and captions    |

Remotion's median is about 15.6 times the decorated FFmpeg median on this VM. The extra time buys a React composition, not a faster copy of the same filter graph. Peak memory is about 17 times higher.

### 9. Output validation

`ffprobe` checked every run that the suite marked valid.

| Check      | Cut-and-concat | Decorated FFmpeg | Remotion       |
| ---------- | -------------- | ---------------- | -------------- |
| Duration   | 60.021 s       | 60.010 s         | 60.011 s       |
| Size       | 1080×1920      | 1080×1920        | 1080×1920      |
| Frame rate | 30/1           | 30/1             | 30/1           |
| Video      | h264, yuv420p  | h264, yuv420p    | h264, yuvj420p |
| Audio      | aac            | aac              | aac            |
| Empty      | no             | no               | no             |

Frames from the measured Remotion output, opened and inspected:

- 9:16 color bars fill the frame. The timecode overlay reads `00:00:30:000`.
- The title "EditAgent" is visible near the top.
- At 1 second the title is opaque. At 8 seconds the same crop shows it faded, so the opacity animation is in the picture.
- The lower-third caption at 1 second is "Sixty seconds, vertical frame". At 12 seconds it is "The title moves and fades".
- The decorated FFmpeg frame at 1 second shows the same first caption on a dark box.

A render that exited non-zero, or that failed these probe checks, was not counted as a measured success. All fifteen runs in the final suite passed the probe.

### 10. Docker and Chromium findings

The production image `workers/render-worker/Dockerfile` is a non-root Node 22 bookworm image. It does not install Chromium, FFmpeg, fonts, or a shared-memory setting. It only starts the current placeholder process. This spike does not change that image.

Remotion 4.0.532's `openBrowser()` always appends `--no-sandbox` and `--disable-setuid-sandbox` before launch. Setting `enableMultiProcessOnLinux: true` avoids `--single-process`. It does not turn the sandbox back on. A non-root sandboxed Chromium runtime was therefore not demonstrated. That is a deployment blocker for any later render worker that must keep the Chromium sandbox enabled. It is not solved by adding `--no-sandbox` to a production Dockerfile.

Host render observation: Chrome Headless Shell 149.0.7790.0 launched with those sandbox flags, `--disable-dev-shm-usage`, and `--headless=old`. Browser peak RSS was about 2.2 GB. The whole tree peaked near 8.6 GB, so a container memory limit under that will be killed.

The isolated image `tools/benchmarks/rendering/docker/Dockerfile` installs the shared libraries named in the Remotion Docker document (`libnss3`, `libatk1.0-0`, `libgbm1`, `libasound2`, `libxrandr2`, `libxkbcommon0`, `libxfixes3`, `libxcomposite1`, `libxdamage1`, `libcups2`, Pango, Cairo), plus FFmpeg and DejaVu fonts. It installs Chrome Headless Shell at build time and drops to uid 10001. It was run with `--shm-size=1g`.

That container run completed as uid 10001. Wall time was 212.336 seconds, including fixture generation. The inner `renderMedia()` call was 211.723 seconds, peak RSS 7,398,510,592 bytes, browser peak RSS 1,953,988,608 bytes. `ffprobe` accepted the file: 60.011 seconds, 1080×1920, 30/1, h264, `yuvj420p`, aac. The Dockerfile does not pass `--no-sandbox`. Remotion's launcher still did, as on the host. `results/docker.json` records the field `sandboxDisabled: false` to mean the spike script did not add a sandbox-disable flag. It does not mean the Chromium process ran with the sandbox enabled.

The image is not published and is not wired into Compose.

### 11. Remotion licensing

Checked 2026-10-01.

The benchmark depends on Remotion 4.0.532. The license text shipped for the current line is [LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md), also published at [remotion.dev/license](https://www.remotion.dev/license).

Free License eligibility in that text:

- an individual
- a for-profit organization with up to 3 employees
- a non-profit or not-for-profit organization
- evaluating whether Remotion is a good fit, and not yet using it in a commercial way

The Free License allows commercial and non-commercial creation of videos and images, and modification for a custom use case. It does not allow selling a derivative of Remotion itself. The company license is required when the user is outside that group. Pricing for that license is on [remotion.pro](https://www.remotion.pro/license).

Remotion has also published [Terms and Conditions v5.0](https://www.remotion.dev/docs/terms), which the page says take effect when Remotion 5.0 is released. They are not the license of the 4.0.532 packages used here. Under those future terms, a Company License user who builds an automated video pipeline pays for Remotion for Automators at $0.01 per render with a $100 monthly minimum. Free License users may build automations without buying renders. An Enterprise License is quoted with a $500 monthly minimum. Source: the v5.0 terms, sections "Free License User", "Remotion for Automators", and "Enterprise License User".

This repository does not record the team headcount or whether the graduation project is a for-profit product. The project owner has to place the team in one of the eligibility groups. A later SaaS that renders customer videos is the kind of automation the v5.0 Automators option describes, if that version is what ships and the team is not on the Free License.

Individual packages in the 4.0.532 set used here (`remotion`, `@remotion/bundler`, `@remotion/renderer`) are covered by that Remotion license. This spike did not use Remotion Lambda, Cloud Run, or the Player, and it does not claim those products share every clause.

### 12. Hybrid strategy

Supported by the measurements on this VM:

- FFmpeg cut-and-concat of this 60-second source finished in about 11 seconds and under 0.5 GB.
- FFmpeg drawtext of the same captions and a moving title finished in about 9 seconds and under 0.5 GB.
- Remotion's React composition of the same duration finished in about 140 seconds and peaked near 8.6 GB.

Proposed split, not implemented in the render worker:

- FFmpeg for trim, cut, concatenation, transcode, audio processing, and proxy files. US-218 and US-222 are the later stories for that strategy.
- Remotion for animated captions, motion graphics, React components, and compositions that are not a filter graph. US-216 and US-217 are the later stories. The worker would shell out or call `renderMedia()` only for those segments, then hand the intermediate file back to FFmpeg for the join.
- The current render-worker process stays a placeholder until those stories. It should not gain a browser until the sandbox blocker above is accepted or removed upstream.

### 13. CP1 evaluation

CP1 requires Remotion to render 60 seconds of 1080p with captions in at most 300 seconds on the reference machine.

```text
Output duration: 60 seconds
Maximum render time: 300 seconds
CP1_RENDERING_PASS = measured_time <= 300
```

On this VM the median of three measured Remotion runs is 139.644 seconds, which is under 300. That result is provisional. The reference machine is not identified in the SRS, and this VM is not claimed to be it.

**CP1 rendering gate: NOT_VERIFIED.**

### 14. Risks and limitations

- The CPU model string is the generic hypervisor name `Intel(R) Xeon(R) Processor`. It is not a specific SKU.
- About 12 GiB of the 15.6 GiB RAM was already in use before the spike. The Remotion peak still fit, and another concurrent job on the same VM could change the number.
- Remotion disables the Chromium sandbox in its own launcher. A sandboxed non-root container was not shown.
- `yuvj420p` versus `yuv420p` means the Remotion file is full-range 4:2:0. It is not a 10-bit or 4:4:4 file. Players still show the captions.
- Cut-and-concat must not be quoted as the cost of drawing captions.
- GitHub-hosted CI runners are not used as a performance gate.

### 15. References

- Roadmap story US-106 and checkpoint CP1 in `docs/roadmap/phases/phase-1-foundation.md` and `docs/roadmap/milestones.md`
- NFR-PERF-01 in `docs/requirements/srs.md` (180 seconds, later checkpoint CP4; not the CP1 300-second gate)
- Remotion `renderMedia()`: https://www.remotion.dev/docs/renderer/render-media
- Remotion Docker notes: https://www.remotion.dev/docs/docker
- Remotion license, checked 2026-10-01: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- Remotion 5.0 terms, not yet in effect for 4.0.532: https://www.remotion.dev/docs/terms
- Raw measurements: `tools/benchmarks/rendering/results/summary.json`
