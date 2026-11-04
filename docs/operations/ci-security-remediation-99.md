# Route A prerequisite: CI transport and native Brotli remediation

This separate prerequisite is based on protected main
`5cdb1d794d347a36d869027947bb62504dddff92`. It uses the nine-file
`12b09f704d32bc68f662404872586f89d26f284f` remediation as a reference,
not as approval or current qualification. Its historical successful checks were
on Ubuntu 24.04. All new native checks must qualify the actual new commit.

## Reproduced baseline

- CI repository job 126423035948 at PR103 `f9d633ef` reproduced the inherited
  `change_speed-2` 15-second timeout on Ubuntu26/FFmpeg8, then a real image build
  failed with curl 35 (TLS connection reset). No source was accepted without its
  checksum. Ubuntu26/FFmpeg8 remains **unqualified and unresolved**.
- Native Supply job 126422787116 reproduced **CVE-2026-111497 CRITICAL** in
  main's SeaweedFS image: `brotli-libs 1.2.0-r1`, fixed in `1.2.1-r0`.
- Walking job 126422786286 failed during host storage isolation/startup on the
  inherited Ubuntu26 runner. The inner cause is not inferred from exit1.
- The real loopback TLS controls reproduce primary-only curl's old exit35,
  corrupt/partial bytes and bounded retry exhaustion without a real source build.

## Minimal isolated change

CI repository/ASR/aggregate, Walking, and Supply dependency/image/aggregate jobs
use **ubuntu-24.04**. Tests, names, permissions, scanner policy, triggers, resource
limits, deadlines, and publication/staging jobs remain unchanged. Walking's YAML
is the one additional path beyond the QA reference nine: its actual browser,
firewall and storage-host behavior requires the same qualified host profile.

The shared builder retains FFmpeg **7.1.5** and the exact archive SHA-256:
`de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`.
Primary: `https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz`.
The previously Owner-approved fallback is the checksum-identical official Debian
Security HTTPS source archive. Each origin has at most four attempts, connection
15s, transfer90s and retry-window120s (including a final transfer, at most420s
across both origins). TLS verification and HTTPS-only redirects remain enabled.
A successful corrupt primary fails immediately without fallback. Extraction and
promotion occur only after checksum verification. EXIT cleanup removes partial
files; HUP/INT/TERM now exit129/130/143 rather than returning into the build.
Eleven real curl/shell controls cover this boundary; they do not count as a real
FFmpeg compile. Windows may select its existing Python using TEST_PYTHON; the
Windows/Git compatibility controls may run locally; production Linux qualification
still requires genuine Ubuntu runs. The fixture uses an explicit ephemeral CA
because Windows Schannel ignores CURL_CA_BUNDLE; no system CA is installed.

SeaweedFS is the complete original upstream **4.51** image, without a Go rebuild:

| Identity             | Complete immutable digest                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| Upstream index       | `sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8` |
| linux/amd64 manifest | `sha256:3a522c379599e163433a636e75022630848b63a74f08ea37bf06f8d776e9a707` |
| Image config         | `sha256:e9535759e270021cc18782c39e1dcc7977ad801edc4e3676a3d2f6c29bf598b6` |

Index and manifest bytes were independently hashed against registry digest
headers; the amd64 selection is unique. The native workflow must independently
verify installed APK `brotli-libs=1.2.1-r0`, curl's Brotli runtime, weed4.51,
upstream/wrapper entrypoints and uid1000 privilege drop. It then executes the
unchanged Syft and Trivy policies on the actual built image.

No pc100/candidate/App/qualified-storage source, policy, compiler or Go-module
change is included. Existing entrypoint, JWT/mTLS, firewall, source-network and
volume safeguards remain in force. Walking additionally runs the S3 contract's existing stopped backup/delete/restore
procedure on a disposable random object, checking restored bytes and anonymous
denial before its existing post-restore readiness/smoke checks. CI retains its
original S3 contract; no production volumes are used.

The first exact-head native CI run, `41860887282/1` at `ee59acf969`, reproduced a
cumulative scheduling overrun: all product assertions passed, including
`CAPTION_REPAIR PASS` at16:29:06 UTC, but artifact/cache cleanup hit the unchanged
45-minute limit at16:29:39. This is not a passing CI result. The added recovery
proof consumed about78s on that critical path. The one further necessary path,
`tools/test/run-walking-skeleton.mjs`, moves that additional proof into the
existing required Walking job (first run completed its work in about10m), before
readiness and smoke verification. Recovery failure remains fatal. No original
assertion is removed, no new job is added, and the45m/15m deadlines, permissions,
scanner policy and all six ASR shards remain unchanged. The corrected HEAD must
still obtain its own complete native qualification; historical passes and warm
caches are not substitutes.

## Qualification and honest scanner interpretation

Required exact-HEAD checks: **ci, supply-chain-security, Walking Skeleton**.
All six real ASR shards, production FFmpeg build/codec/DASH rejection, real
render/cancellation/timeline/browser checks, S3, trust-boundary, JWT, firewall and
backup/restore are required. Skipped or unavailable checks are not PASS.

The existing scanner writes HIGH/CRITICAL JSON but **blocks on CRITICAL only**.
Passing that unchanged gate is NOT zero HIGH/CRITICAL, a release waiver, or a
production safety approval. The independent November4 reference scan of4.51
reported **one HIGH** go-jose vulnerability; the prior report identified
`CVE-2026-116587`, modulev4.1.5, fixedv4.1.6. Separate Go Brotli remains a disclosed
LOW dependency risk. Fresh per-head SBOM and Trivy artifacts determine the actual
current findings and must be independently dispositioned before release.
No ignore, threshold change or scanner exemption is authorized.

Reproduce on Linux with the pinned project toolchain:

```sh
pnpm install --frozen-lockfile
node --test tests/architecture/ffmpeg-download.test.mjs tests/architecture/seaweedfs-object-storage.test.mjs
pnpm test:walking-skeleton --verify-failure
pnpm render:test --graduation-demo
```

Use the existing native workflows for real services/scans and the complete test
matrix. Per-run artifacts `supply-chain-sbom-seaweedfs` and
`supply-chain-trivy-seaweedfs` provide fresh image-bound evidence; historical
reports are supporting context only. The final handoff must record exact run,
commit, image, report hashes, actual counts and every remaining HIGH.

**SAFE_TO_MERGE=NO; LIVE_A6_ENFORCED=NO; RELEASE_HOLD=ACTIVE.**
Neither this change nor a passing critical-only scan authorizes release,
production migration, planner activation, CP2/CP1 qualification or Tiny Arabic
acceptance. PR100 and PR103 remain separate Drafts; no protection is changed.

References: [upstream SeaweedFS4.51](https://github.com/seaweedfs/seaweedfs/releases/tag/4.51),
[Alpine Brotli advisory](https://security.alpinelinux.org/vuln/CVE-2026-111497),
[curl retry semantics](https://curl.se/docs/manpage.html#--retry-all-errors).

Independent QA rejected frozen `400df54` with RouteA-F1: the bare recovery flag
could reach the helpers' default `editagent` volumes. That is a FAIL, despite its
green native checks. The corrected entry rejects before S3 operations unless it
verifies the exact reserved disposable `walking-skeleton` stack on the local
Linux Docker socket: loopback endpoint/port, all four live container identities,
Compose working-directory/config/service ownership, and each named data volume's
ownership. It pins the helper environment to this checkout's Compose file with
.env loading disabled and rechecks identity before backup and restore. Default,
missing, ambiguous, remote, changed or production ownership fails closed. Use the
Walking driver (which creates and disposes its test stack), never a bare restore
flag on an existing operator stack. Hermetic tests exercise actual module control
flow without storage effects; native Walking must additionally pass admission
against real containers. No production backup/restore is authorized here.
