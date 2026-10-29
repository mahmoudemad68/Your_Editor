## Issue #99 — pre-change evidence matrix (2026-10-29)

Verified main and prepared branch: `5cdb1d794d347a36d869027947bb62504dddff92`. PR #98 stays frozen at `98288b652c36a3e557e45599e29ac60d27e0f92f`; its documentation is excluded.

| Failure                                                       | Verified evidence                                                                                                                                                                                                                                                                                                                                                                                        | Impact / minimal correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI repository render step, run 40816237286 / job 123257841066 | 04:24:45 UTC: shared `build-ffmpeg.sh` exits with curl 35, TLS receive reset. Media-worker build in run 40816237539 / job 123257841965 fails identically at 04:11:32 UTC. Both call `https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz`; apt completes before failure. Existing `--retry 3` excludes this error. The resetting peer and wider network cause are not established.                           | Retry failed idempotent HTTPS downloads with explicit connection, transfer and total-retry bounds. Preserve URL/version/SHA and checksum-before-extraction. No new mirror/cache/insecure TLS. Test actual curl failure/recovery and corruption rejection.                                                                                                                                                                                                                                                               |
| SeaweedFS image scan, run 40816237539 / job 123257842008      | Trivy 0.75.0, NVD CRITICAL CVE-2026-111497, Alpine 3.24.2 `brotli-libs` 1.2.0-r1, fixed 1.2.1-r0. Syft locates APK DB `/lib/apk/db/installed`; library dependency installed with curl/libcurl in upstream image layer. Original index digest `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`, amd64 `sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931`. | Native decoder out-of-bounds write on malicious compressed input; presence is confirmed, application exploit reachability is not established. Upgrade immutable upstream 4.51 index `sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8`, amd64 `sha256:3a522c379599e163433a636e75022630848b63a74f08ea37bf06f8d776e9a707`. Digest-verified package layers contain brotli-libs 1.2.1-r0, curl/libcurl 8.23.0-r0, su-exec 0.3-r0. Fresh pinned Trivy/SBOM and storage qualification remain required. |

Upstream image 4.51 was built 2026-10-26 from revision `ffa87c25fdf587178b1521ad87f2a4a72a02e584`. Release changes include S3 metadata authorization; real contract tests must confirm compatibility. Separate Go `github.com/andybalholm/brotli` v1.2.6 remains below v1.2.7: upstream GHSA-c9gr-gmg4-2vqv classifies its bounds-checked malformed-input panic as Low (not native memory corruption). This is disclosed as a residual dependency risk, with no scanner exception or security-policy change. Fresh scan must still pass unchanged gates.

Sources: [curl retry behavior](https://curl.se/docs/manpage.html#--retry), [Google Brotli 1.2.1](https://github.com/google/brotli/releases/tag/v1.2.1), [Alpine CVE](https://security.alpinelinux.org/vuln/CVE-2026-111497), [SeaweedFS 4.51](https://github.com/seaweedfs/seaweedfs/releases/tag/4.51), [Go Brotli advisory](https://github.com/andybalholm/brotli/security/advisories/GHSA-c9gr-gmg4-2vqv).

Scanner artifacts: `supply-chain-trivy-seaweedfs` (12872303226), `supply-chain-sbom-seaweedfs` (12872527479). Registry manifests, config and APK layers were independently SHA-256 verified before extracting package metadata in memory (no untrusted archive extraction).

Validation plan: deterministic bounded-download/partial-transfer/checksum controls; pinned image package assertions; unchanged scanner positive controls; Linux image builds, FFprobe codec/container/DASH rejection; existing JWT/firewall lifecycle/trust boundary/S3 read-write/revocation plus backup/restore regression; actual render cancellation/timeline/browser export; six ASR shards; exact-head CI, Walking Skeleton, Supply Chain. Windows has no Docker; existing authorized GitHub Linux workflows supply real-container evidence. No acceptance claim before execution.

## Implemented controls and measured self-tests

- The shared FFmpeg builder keeps version 7.1.5, the original primary source URL and SHA-256, all configure flags, and checksum-before-extraction. The Owner approved the exact Debian fallback proposal after the first published workflow attempt proved that primary-only retries were insufficient (details below). Both fixed origins allow at most four requests each, a 15-second connection limit, 90-second transfer limit and 120-second retry window. A final transfer can finish up to 90 seconds after that window: at most 420 seconds across both origins. Initial and redirected URLs must use HTTPS. Failed `.part` files are removed; only verified bytes are promoted. No TLS bypass or caller-controlled URL override exists.
- Eight offline controls run the production download/checksum prefix with actual curl against an ephemeral, explicitly trusted local TLS fixture. They reproduce the old exit 35 behavior, recover a reset, restart a partial body without appending bytes, stop persistent failure after at most eight total requests, verify fallback recovery and fallback corruption rejection, reject primary corruption without fallback, and verify production identity/time bounds. The test substitutes only its local destination, fixture URLs/hash, and primary-only default retry behavior for the negative control. It neither compiles fixture bytes nor counts as a real FFmpeg build.
- `python3 tools/test/ffmpeg-download-controls.py`: 8/8 PASS (32.371 seconds). The Node architecture wrapper plus existing SeaweedFS architecture suite: 5/5 PASS before the fallback extension, then rerun for the final change. Ruff, ESLint and scoped Prettier checks PASS. WSL1 is not a production Docker/kernel qualification environment.
- Unchanged `infra/scripts/test-secret-exceptions.py` with checksum-pinned Gitleaks: PASS (original exceptions, fresh secret and moved-coordinate controls). Direct execution of the full security suite initially encountered existing CRLF shell scripts in the Windows checkout. A bounded LF fixture exported from the published commit then passed all 19 unchanged security tests; no held files were normalized or copied. A clean Linux CI checkout remains the production regression gate.
- The Supply Chain image matrix now asserts native Brotli 1.2.1-r0, curl's Brotli version, availability of both entrypoints and `su-exec` uid 1000 in the actual offline/read-only SeaweedFS image. Scanner versions, severities, ignore rejection and failure policy are unchanged.
- The existing S3 contract can run `--verify-backup`: back up stopped disposable storage using the existing scripts, delete a test object and prove absence, restore, compare its original bytes, and verify anonymous access remains denied. CI invokes this before application tests. No production storage is exercised by this test.

## Explicitly approved Debian source fallback

First publication `a0956fc667bb29e8e0ffd72bb112bd6c7a6c8e0f` proved finite retry behavior in GitHub: Supply Chain job 123290419893 and Walking Skeleton job 123290419257 exhausted four requests to ffmpeg.org with curl 28/35. Other builds succeeded from that same origin. The origin's wider network failure cause remains unproven; TLS peer identity or geographic blocking is not inferred from these logs. No unchanged-head retry was used to manufacture green results.

The Owner then explicitly approved proposal patch SHA-256 `8b1fe922dd8ec62ce4bc991fc4841f202ad2452ee6e3305a907f2b485b08d97e`: add only the official [Debian Security FFmpeg source archive](https://security.debian.org/debian-security/pool/updates/main/f/ffmpeg/ffmpeg_7.1.5.orig.tar.xz) as fallback after primary transport failure. An independently downloaded copy is 11,050,340 bytes and matches the unchanged approved SHA-256 `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`. No new storage service or spending is involved; existing ephemeral build storage is used.

The corresponding [Debian source-control document](https://security.debian.org/debian-security/pool/updates/main/f/ffmpeg/ffmpeg_7.1.5-0+deb13u1.dsc), SHA-256 `9ed2ed34cbe7f056eeebbe9045c5e2d15e41b5b053fe7c8ba6979a0b6fb081ce`, records the same size/hash. Its signature was not independently verified here; the existing approved archive SHA-256 remains the integrity anchor. Both download sources are hard-coded HTTPS URLs. A checksum mismatch is an integrity failure and stops immediately, without trying another origin. Only transport failure permits fallback. The existing codec/protocol restrictions and source identity remain unchanged.

At the first published head, the actual media-worker image build and FFprobe container probe passed (job 123290419823), including MP4/MOV/MKV/WebM, edited H.264/AAC, rotated/VFR/WAV/PNG fixtures, native sandbox checks and DASH rejection. The SeaweedFS image build, offline native Brotli/privilege checks and unchanged scan passed (job 123290419788). CI's real storage startup/JWT/firewall/trust checks and S3 backup/restore contract also passed. These observations are intermediate evidence; the final published head must pass all required workflows independently.

## Fresh vulnerability confirmation

Trivy 0.75.0 was independently obtained through the existing checksum-pinned installer. Both immutable images were scanned with a fresh vulnerability DB on 2026-10-29, retaining secret scanning, HIGH/CRITICAL reporting, `--ignore-unfixed=false`, and no ignore/config override. The replacement uses Alpine 3.24.3.

| Image                   | HIGH findings | CRITICAL findings | Native Brotli CVE                                 |
| ----------------------- | ------------: | ----------------: | ------------------------------------------------- |
| Original 4.48 digest    |             8 |                 1 | CVE-2026-111497 present, 1.2.0-r1                 |
| Replacement 4.51 digest |             1 |                 0 | Absent; installed 1.2.1-r0 independently verified |

The replacement still reports **HIGH CVE-2026-116587**, Go dependency `github.com/go-jose/go-jose/v4` v4.1.5, fixed v4.1.6. This is retained in reporting and must be reviewed as a residual upstream dependency risk; there is no waiver or claim of zero HIGH findings. The repository's unchanged image policy reports HIGH and fails on CRITICAL. Application exploitability of this dependency has not been established here. The separate Go Brotli Low advisory remains disclosed above and is not eliminated by patching native Brotli.

SHA-256 provenance of exact report bytes (local copies retained; published workflow artifacts remain the approved review channel):

| Evidence                            | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| Original failed-run Trivy JSON      | `20c24e9322b7dfeee41669f0660a0fed0d185b195f8f77e3d36b165d87c2477b` |
| Original failed-run Syft SPDX JSON  | `381793d9de633ff57c5f262c31ff19c11588afd9be50de43a855b908763362ea` |
| Fresh original-digest Trivy JSON    | `65748cba36db4bd243def4b2511726e101c31728e53f79ff325c619e1cad014c` |
| Fresh replacement-digest Trivy JSON | `3a92d1505dff010cbbafc92006c52038773aaddf339a250124549a3e9220b941` |

The failed-run SBOM lists native decoder `/usr/lib/libbrotlidec.so.1.2.0` and the encoder/common shared libraries. The separate Go module is embedded in `/usr/bin/weed`. Image availability and package versions are not sufficient proof of S3 compatibility: exact-head container, lifecycle, rendering and workflow results are required in the frozen handoff.

Reproduce scoped controls with `node --test tests/architecture/ffmpeg-download.test.mjs tests/architecture/seaweedfs-object-storage.test.mjs` on Linux with Python 3, OpenSSL and curl. Full gates remain the existing `pnpm test`, `pnpm render:test --graduation-demo`, `pnpm asr:container`, CI, Walking Skeleton and Supply Chain workflows. No original gold, model identity, held file, PR #98 document, secret-scanning exception or CI budget is changed. CP1 remains NOT_VERIFIED, CP2 NOT_MET, Tiny Arabic NOT_QUALIFIED, US-309 BLOCKED and PLANNER_NOT_CONFIGURED.

## Phase 2 — custom Go security rebuild (qualification pending)

Owner authorization: [6497156507](https://github.com/mahmoudemad68/Your_Editor/pull/100#issuecomment-6497156507).
The earlier results above describe the frozen Phase-1 head only. They do not qualify
this changed implementation. RELEASE_HOLD remains ACTIVE and SAFE_TO_MERGE remains NO.

The reviewed input lock is `infra/seaweedfs/security-build.lock.json`: SeaweedFS
`ffa87c25fdf587178b1521ad87f2a4a72a02e584`, Go 1.26.10, linux/amd64, CGO=0,
GOAMD64=v1, default tags, go-jose v4.1.6 and Go Brotli v1.2.7. Original source and
module ZIP/checksum-database records are checked before compilation. The upstream
go-bip39 replacement is preserved; no replacement is added. Other graph/version
or checksum changes fail the build. No `go get -u`, tidy, alternative mirror,
FIPS override or RSA-cap increase is permitted.

BuildKit actually disables the compile RUN network. Two empty, separate compiler
caches produce the same ELF; comparison is byte-for-byte, not normalized. The
native donor filesystem, Rust binaries, uid/mode/link behavior and native Brotli
1.2.1-r0 are compared before admission. The final scratch image receives the donor
filesystem with old weed removed, then the new ELF and bounded provenance. It
inherits neither the old ELF layer nor compiler/source/cache stages. Actual ELF
module information is read using the pinned compiler without executing weed.

### Native PR qualification and the external policy record

All three native PR triggers and genuine `ci`, `supply-chain-security` and
`walking-skeleton` contexts remain. Consumers fail explicitly with
PRODUCER_NOT_YET_CREATED or PRODUCER_NOT_YET_COMPLETE until the entire original
Supply run succeeds. Only that initial prerequisite failure permits exactly one
controller-requested full re-run of the original consumer run ID. No partial,
failed-producer, security/integrity/test retry or dispatch substitution qualifies.
Original M, H, B, their trees and merge parents are checked through live PR/run
metadata and content-addressed Git objects; checkout retains M and its parents.

After publishing the complete implementation, the Coding Agent runs:

```sh
node tools/test/load-qualified-storage.mjs policy-inventory
```

This prints REVIEW_REQUIRED_NOT_APPROVED, H/B/TH and the complete expected-policy
file SHA-256 map. It **does not approve itself**. Technical Lead must inspect the
actual workflow/build/scanner/guard files and publish a separate Owner-associated
review comment containing that exact record with decision APPROVED in a fenced
`seaweedfs-policy-v1` block. The review is external to candidate artifacts; exactly
one matching record is required. The Coding Agent must not fabricate it. Merely
having a job name, successful run, manifest, artifact or Owner account name is not
the required human review. Policy admission is not independent QA or the two
distinct human release-security approvals.

The loader verifies the completed producer's attempt-specific jobs, all eleven
image scans, actual module/zero-HIGH controls, aggregate check app/PR association,
reviewed policy and controlled artifact upload. It verifies GitHub ZIP digest,
bounded safe extraction, inner digest, final image/layers and actual ELF before
load. Missing/failed/forged/expired evidence is a hard failure, not retryable.

Walking's preparation job alone receives the already authorized contents-read and
Actions-read grant. Its downstream contents-only job retrieves an exact promoted
same-run artifact ID and validates its receipt and image hashes before load. CI
downloads the original source artifact using its existing permitted Actions access.
No PAT, signed URL or GitHub token enters artifacts or product containers. Source
and promoted replicas share identical compressed bytes. C <=120 MiB, provenance
including transfer receipts R <=16 MiB, 2*C+R <=256 MiB and one-day retention are
enforced. Size, runtime and successful contents-only transfer remain NOT_PROVEN
until clean Linux qualification; a cap failure returns CI_DESIGN_BLOCKED.

### Required new evidence, not yet claimed

- Two clean-cache ELF hashes; actual `go version -m`; source/lock/recipe/OCI IDs.
- Fresh pinned Trivy/Syft with zero HIGH/CRITICAL and the explicitly fixed Low
  module. Existing scanner policy, canary and all other images remain required.
- Resource-limited RSA 2048/4096, default-cap/invalid/private JWK and Brotli
  positive/malformed controls. No external OpenBao/KMS is configured or assumed
  compatible with >4096-bit RSA keys; those need a separate operator decision.
- Production-isolated JWT/S3/firewall/restart, stopped backup/delete/restore,
  missing/corrupt archive rejection and disposable baseline-to-candidate snapshot
  upgrade/rollback. Rollback restores the old snapshot and loses subsequent writes;
  in-place downgrade is not claimed. Production migration is NOT_AUTHORIZED and
  NOT_VERIFIED.
- Retained MinIO journey plus explicit `--storage-seaweedfs` journey with actual
  candidate image/backend, Small ASR, saved captions/editing/undo/restart, render,
  browser playback/download and FFprobe. The existing readiness helper's legacy
  network alias `minio` does not identify the backend; SeaweedFS uses its actual
  gateway endpoint and image receipts. Private fixture CORS permits only the real
  test web origin. No fallback or mock is used.
- Original 45m repository, 15m Walking, 60m image and 600000ms inference limits,
  all six ASR shards and the separate <=45m SeaweedFS regression job.

CP1, CP2 NOT_MET, Tiny Arabic unqualified, immutable model/gold identities,
PLANNER_NOT_CONFIGURED, protected files and other PRs remain unchanged. The new
head cannot be READY_FOR_INDEPENDENT_RE_QA until every entry gate has actual proof.

### Narrow blocked-head repair — identity and dependency preparation

The failures at `1c548f0` remain historical FAIL, not waived or rerun. The original
identity mismatch cause is NOT_PROVEN: its instantaneous API values were absent.
The repaired reader emits selected public event H/B/M, checked-out commit/tree,
merge parents, live PR H/B/M and mergeability, native workflow/run/attempt/PR/check
identity, per-field comparisons, observation time and allowlisted API request/date
correlation. Response bodies, authorization headers, URLs and account fields are
excluded. The failure-outcome artifact embeds this sanitized identity snapshot;
all observations also appear as `IDENTITY_EVIDENCE` records in the job log.

A same-attempt refresh is bounded to three PR reads (3s each) with two 500ms
pauses, at most 10s. It is allowed only for an explicit null merge SHA with null
mergeability and state unknown, after all other guards pass. A concrete different
merge SHA, wrong H/B, repo, workflow, run, attempt, checkout, parents, tree or check
association fails immediately. Incomplete metadata remaining after the bound is
non-retryable failure. Every success still requires the original M, `[B,H]`
parents, equal trees and exact live H/B/M. This is not a workflow rerun or a
substitution of the current PR merge for the original event merge.

Dependency preparation downloads only existing root requirements, the two
approved upgraded targets, and the upstream Brotli test dependency
`github.com/xyproto/randomstring@v1.0.5`. Both exact records below occur in the
approved original source go.sum (SHA-256
`78c8b44110c4633c5721e0f7dad0fe99308116ebb7bdd5dafb160dc378f31d89`):

```text
github.com/xyproto/randomstring v1.0.5 h1:YtlWPoRdgMu3NZtP45drfy1GKoojuR7hmRcnhZqKjWU=
github.com/xyproto/randomstring v1.0.5/go.mod h1:rgmS5DeNXLivK7YprL0pY+lTuhNQW3iGxZ18UQApw/E=
```

The native verifier additionally requires this exact unreplaced version in the
original module graph, both downloaded h1 records and actual cached archives.
The original-plus-four checksum set remains strict; no `download all`, extra
module, replacement or unrelated upgrade is accepted. Offline-stage negative
controls exercise unknown modules, checksum changes, missing archives, graph and
replacement drift. A separate synthetic compile with an empty module cache must
fail specifically because BuildKit's disabled network prevents fetching that
same approved module; a timeout or unrelated error is not accepted as proof.
Native build/scan and consumer success remain subject to fresh exact-head evidence
and a separately reviewed `seaweedfs-policy-v1` binding, never this documentation.
