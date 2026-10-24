# ASR CPU runtime qualification and read-only preflight — Issue #64

This runbook describes measured profiles, not a latency guarantee for arbitrary
machines. The production inference deadline remains **600,000 ms**. A preflight
PASS means prerequisites are present, never that transcription, determinism or
performance acceptance has passed. Do not extend deadlines to accommodate slower
hardware or disable admission, cancellation or supervision controls.

## Supported implementation versus measured qualification

| Property       | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production CPU | Linux x86-64 with AVX2 and FMA verified on every reported processor. `configure_asr_native_environment` fails closed otherwise. ARM, missing/hidden ISA evidence and Windows native inference are unsupported by this production profile.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Image/runtime  | `workers/ai-worker/Dockerfile`: pinned Python 3.11 Debian trixie image digest `45037981b62b34b44602584fccbc4d884d5f7dc92c7ee86bb38a698a79fe1e51`. The recorded PR60 container used Python 3.11.17, glibc 2.41. Exact images/library bytes matter; matching version strings alone do not prove numerical equivalence.                                                                                                                                                                                                                                                                                                                         |
| Libraries      | Locked NumPy 2.4.6, CTranslate2 4.8.2, faster-whisper 1.2.1, ONNX Runtime 1.31.0 and PyAV 18.1.0. Use `uv.lock` and the production image. The wheels/base provide native C/C++ runtime, OpenMP, oneDNN/CT2 and codec dependencies. Preflight checks distribution metadata without loading these libraries; actual image smoke/inference tests are required to prove dynamic linkage. Do not install arbitrary replacement libraries to obtain a local pass.                                                                                                                                                                                  |
| CPU dispatch   | `onednn-avx2-strict-v4`, NumPy `numpy-avx2-log-v2`; oneDNN rather than vendor-selected MKL GEMM; strict FP math; CT2/oneDNN AVX2 caps; NumPy AVX-512 dispatch disabled. Production startup establishes the reserved environment before native imports. Preflight reports conflicting overrides, never rewrites them.                                                                                                                                                                                                                                                                                                                         |
| Decoder        | CPU/int8, one worker, two CT2 CPU threads by default (one-thread output also compared in recorded tests); beam 5, temperature 0, seed 0, 24-second chunks, 2-second overlap, bounded original-PCM context at most 30 seconds. VAD thresholds 0.5/0.35, minimum silence 200 ms and padding 100 ms. Other accepted settings (threads up to 8, etc.) are configurable paths, not automatically qualified performance profiles.                                                                                                                                                                                                                  |
| Resource jail  | Measured Docker profile: 2 CPU quota, 3 GiB memory and total memory+swap limit, 128 PIDs; non-root UID/GID 10001, read-only root, no capabilities, no-new-privileges, no network, original input bind-mounted read-only, `/tmp` tmpfs 128 MiB, noexec/nosuid/nodev. Host CPU count is not quota. Visible ancestor quotas and affinity can impose lower limits.                                                                                                                                                                                                                                                                               |
| Disk           | Model weight files alone total 559,085,172 bytes for Tiny+Small, plus tokenizer/configuration, wheels, image layers and build cache. This is a byte inventory, not a complete image-size estimate. Tiny's alignment path also needs the pinned Small bundle. Keep image/model storage separate from writable job staging. Production AI staging is bounded to 64 MiB per input; qualification used 128-MiB tmpfs and a read-only prepared ten-minute input. Preflight reports free workspace bytes and flags less than 64 MiB; plan additional operational headroom for concurrency and service-specific staging. It does not allocate disk. |

The admission limits in code are unchanged. More logical CPUs, RAM or a preflight
success cannot establish a faster runtime or broaden the qualified input domain.
Memory measurements differ by accounting boundary: child peak RSS and cgroup peak
are separate observations, not interchangeable limits.

## Immutable models

Bundle SHA-256 covers the expected named files, sizes and digests, including
tokenizer and configuration; it is not merely the model.bin digest.

| Model | Revision                                   | Bundle SHA-256                                                     |
| ----- | ------------------------------------------ | ------------------------------------------------------------------ |
| Tiny  | `d90ca5fe260221311c53c58e660288d3deb8d356` | `83ba3102b2fb621cef33d905bb6f8dc7db9c383743bce3cf510d2f5574862281` |
| Small | `536b0662742c02347bc0e980a01041f333bce120` | `4e456821bbeabf0923f07220a86c1c14a8820bc83e78ae638d4474207b70aedd` |

`asr_model.py` is the authoritative file inventory. Runtime verification is offline.
The explicit build/setup acquisition command is separate from preflight. Preflight
never acquires, replaces or downloads models. Small can supply bounded forced-timing
evidence for Tiny words; this is recorded in provenance and is not silent replacement
of Tiny decoder text with Small transcription.

## Historical constrained observations

The following numeric evidence is the archived production qualification associated
with PR60 head `d1e131e08019300506c15653deeec71edb455afe`, tested merge checkout
`affe3ee9dc0044907efe6c934bd60501b8b4745d`. It is Coding Agent measurement, separate
from the [Independent QA sign-off](https://github.com/mahmoudemad68/Your_Editor/pull/60#issuecomment-6370247519)
and [QA run 39981935796](https://github.com/mahmoudemad68/Your_Editor/actions/runs/39981935796).
The measured CPU taxonomy was Intel family 6/model 106/stepping 6; resources were
the jail described above. Inputs and full ordered output checks are bound to
`tests/fixtures/asr/manifest.json` and `tools/asr/qualification.mjs`.

| Model/profile                                | Actual inference wall time | Child peak RSS              | Cgroup peak memory          | Minimum observed deadline headroom |
| -------------------------------------------- | -------------------------- | --------------------------- | --------------------------- | ---------------------------------- |
| Tiny/int8, two threads, two fresh processes  | 47.156381 / 46.997788 s    | 947,134,464 / 946,421,760 B | 877,346,816 / 876,978,176 B | 552.843619 s                       |
| Small/int8, two threads, two fresh processes | 210.867140 / 210.463990 s  | 680,656,896 / 678,871,040 B | 622,182,400 / 624,545,792 B | 389.132860 s                       |
| Tiny/int8, one thread                        | 63.043790 s                | 946,843,648 B               | 876,560,384 B               | 536.956210 s                       |
| Small/int8, one thread                       | 332.104660 s               | 693,297,152 B               | See original report         | 267.895340 s                       |

Recorded two-thread CPU throttled time was 1,334,636 / 1,029,285 µs for Tiny and
7,058,564 / 7,271,099 µs for Small. Inclusive phase timing is not additive;
preprocessing, language processing, alignment and decoder costs all contribute.
These are observations on one licensed original 600-second recording, not a
worst-case bound over all media, hardware, languages or background conditions.

[Issue #64](https://github.com/mahmoudemad68/Your_Editor/issues/64) separately records
Independent QA Small at approximately 388 seconds on an **unjailed Intel WSL**
environment. It is a historical diagnostic observation, not the Docker profile or
a universal maximum. An older reported 600.273-second Small deadline failure was
not verified against the published baseline; it is not promoted into current-code
qualification evidence. Never extrapolate either result into a throughput SLA.

## Read-only preflight

Inside the already built production image, run the installed module with bytecode
writes disabled. This creates no job, network request, model download, native
initialization, environment mutation or system installation:

```sh
docker run --rm --network none --user 10001:10001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --cpus 2 --memory 3g --memory-swap 3g --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777 \
  --entrypoint /app/.venv/bin/python YOUR_ALREADY_BUILT_AI_IMAGE \
  -B -m editagent_ai_worker.infrastructure.asr_preflight --verify-models
```

Use the approved image reference from the actual build; the placeholder is not a
command to obtain a new image. Model selection can use the existing explicit
`EDITAGENT_ASR_MODEL` deployment setting. No credentials are needed by preflight.
On Windows the same module reports UNSUPPORTED for production inference; this is
expected, not a reason to weaken CPU checks. Existing WSL1 is diagnostic only.

Output uses a bounded allowlist: capability booleans, runtime/dependency versions,
numeric resource limits/free space, model identities and safe status codes. It
does not output credentials, arbitrary environment values, paths, hostnames,
CPU serials, private media identities, transcripts or raw exceptions.

- `UNSUPPORTED` (exit 2): required Linux/x86-64/verified AVX2/FMA evidence is absent.
- `NOT_QUALIFIED` (exit 2): supported architecture but profile evidence is missing,
  conflicting, unverified, WSL-only, GPU, or outside the measured resource/runtime
  profile. Unknown cgroups are not treated as unlimited resources.
- `READY_FOR_QUALIFICATION` (exit 0): checked prerequisites match; not an acceptance
  verdict. Loaded native libraries, model numerical output, deadline performance,
  source integrity and service recovery still require actual Linux tests.

The utility checks visible cgroup-v2 ancestors. Hidden host constraints, cgroup-v1,
inaccessible mounts and unrecognized container markers remain unqualified. CPU
frequency, thermal throttling, noisy neighbours and all future load cannot be
predicted by preflight. Metadata matches do not establish native ABI compatibility.
The production ten-minute qualifier records this preflight result alongside real
inference and retains its existing resource/output/deadline assertions. Read-only
model hashing runs after the inference resource snapshot to avoid warming model
files before the measured worker starts.

## Failure, determinism and operating limits

For slower or unsupported machines, stop qualification, keep explicit failure,
and use an already authorized qualified Linux runtime. Do not purchase resources
or silently select another model. Timeout/cancellation terminate and reap owned
native processes; durable deadlines, attempt fencing and no-late-publication checks
remain authoritative across retries and restarts. No timeout result is a completed
transcript. Retries do not reset the absolute admission deadline.

Determinism is scoped to pinned PCM/model/native runtime, preprocessing, decoder
settings and process configuration. Existing tests compare actual complete ordered
text/time/confidence/provenance across fresh/reused processes, one/two threads and
the controlled same-runner host/container stack. Historical 1,168 versus 1,169 words
from differing Python/glibc/CPU stacks is not evidence of within-profile randomness.
Universal cross-hardware bitwise identity is not promised. Hashes alone do not prove
deterministic inference; preserve the actual comparison evidence.

Tiny Arabic word alignment remains **unqualified and fail-closed**. Small Arabic
must be selected explicitly through the existing model configuration; no Small
transcript may be reported as Tiny. English/Arabic project-gold scores are against
Owner-approved generated labels, not independently human-aligned truth. There is
no invented Arabic WER threshold. **CP2 remains NOT_MET**; PR67 safeguards remain
in place and automatic silence removal is not implemented/authorized.

CUDA/float16/int8_float16 and CPU-fallback configuration paths exist, but GPU
driver/CUDA/cuDNN combinations, GPU performance/determinism and nightly execution
are **NOT_PROVEN** by CPU qualification. Native Windows/WSL results cannot be used
as production-container acceptance. Do not advertise untested GPU prerequisites
or silently interpret CPU fallback as GPU qualification.

## Reproduction and evidence retention

Use the pinned toolchain, original Git LFS fixtures, locked models and existing
Linux Docker executor. Run `node tools/asr/qualification.mjs` as configured by CI;
it reports per-model runtime, RSS, cgroup quota/peak/throttling and real repeated
output checks without publishing transcripts. Preserve the report's exact
`prHeadSha`, checkout/tree SHA, source/model hashes and image identity. Re-run the
affected native/service regressions and exact-head workflows after publication.
Keep sanitized reports before workflow retention expires; never copy restricted
diagnostics into a new publication channel.

### Cgroup namespace visibility

Preflight reads the v2 membership and mounted filesystem identity before walking
the leaf and every visible ancestor. CPU, memory and PID evidence uses the most
restrictive finite observation independently. The genuine hierarchy root may
lack all three controller `max` files; it is terminal only when mount metadata
identifies a v2 hierarchy root and its controller list corroborates CPU, memory
and PIDs. Valid descendant limits survive that terminal root. A private namespace
root containing controller files is read normally. Missing intermediate/leaf
files, partial root evidence, hidden/delegated roots without limits, malformed
values and v1 stay unknown and cannot qualify. This does not infer hidden quotas
or turn preflight into a performance guarantee.

`node tools/asr/container.mjs` runs
`node tools/asr/preflight-container.mjs editagent-ai-asr:test` after its existing
image build. Both `--cgroupns=private` and `--cgroupns=host` must report the exact
2-CPU / 3-GiB / 128-PID profile. The non-root, read-only, no-network probe verifies
model hashes, no native imports, no environment mutation and no filesystem
changes. It makes no host changes, installations, downloads or inference calls;
the separate existing long-input performance tests retain the 600000-ms deadline.
