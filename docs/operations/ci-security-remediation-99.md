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

The recorded native failures at H `940fd7e` establish an API-contract defect:
`X-GitHub-Api-Version: 2026-03-10` deliberately removes `merge_commit_sha`, while
all other recorded identity comparisons matched. This is not classified as a
harmless merge-computation race. [GitHub's breaking-change record](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10)
confirms the removal. An authenticated, version-controlled comparison and an
anonymous distinct-query comparison observed the field missing under 2026 and
present with the exact original M under 2022-11-28.

The PR identity request is therefore explicitly pinned to the still-supported
2022-11-28 contract, with a constant version-qualified query key and mandatory
verification of GitHub's selected API-version response header. Other API calls
retain their existing version. There is no version fallback, permission increase,
M substitution, or adoption of a moving ref as proof. A missing field under the
pinned contract remains an immediate failure. Diagnostics now distinguish absent
versus null values and record requested/selected API versions. Any failure to
establish exact original M remains terminal, never a producer prerequisite.

### Transfer-budget forensics — measurement only

`produce` emits `TRANSFER_BUDGET_MEASUREMENT` **before** enforcing the original
caps. Authoritative values are integer bytes; one binary MiB is 1,048,576 bytes.
The record includes raw Docker-save archive bytes, compressed C, each existing
report/manifest size, one-copy R, two-copy provenance `R_total=2*R+65536`, total
`2*C+R_total`, every threshold and predicate, XZ preset, elapsed/CPU time, peak RSS
where available, and visible process/runner observations. It does not log report
contents, archive bytes, secrets or environment values. The diagnostic is in the
existing job log, not an extra candidate-bundle file; no provenance bytes are
removed from the original accounting. Retention remains one day.

C<=120MiB, R_total<=16MiB and combined<=256MiB remain mandatory. R includes all
six report files, including the exact UTF-8 manifest bytes. Accounting for a
second copy is never replaced by single-copy arithmetic. Given the two-copy
formula, R_total and combined totals are even integer byte counts: one extra byte
in C is possible; one extra one-bundle report byte adds two stored bytes. An
isolated combined failure while both individual caps pass is mathematically
impossible because 2*120+16=256; that redundant guard is still retained and tested.
Missing, malformed or non-integer measurements fail closed. Diagnostic callbacks
cannot mutate the decision or turn failure into success; a logging failure also
prevents publication. The unchanged failed produce step prevents candidate upload,
the entire Supply aggregate and all consumer admission.

After an over-budget baseline is measured, at most one **diagnostic-only** XZ
preset-9 probe may run on the exact same complete Docker archive. Preset 6 remains
the candidate format. The separate experimental file is never promoted, uploaded
or substituted, even if it fits. The original TRANSFER_BUDGET_EXCEEDED is always
re-thrown. The probe is Linux-only, read-only with respect to source image bytes,
and requires scratch for a full decoded copy plus inspection. Compression uses
at most 1GiB process address space, 480 CPU seconds / 540 wall seconds. Decompression
retains the existing 256MiB decoder and 4GiB expansion limits. It measures size,
wall time, RSS/CPU and scratch, verifies byte-identical archive SHA-256 after
decode, repeats existing image/layer/filesystem/ELF inspection, and records config,
layer and ELF digests. Any resource or verification failure is NOT_PROVEN, never
a passing alternative. A single probe does not prove recompression repeatability
or GitHub artifact upload/download compatibility. It cannot qualify a replacement.
If the measured settings cannot fit, freeze the failure and submit a separate
reviewable transport proposal; do not implement reconstruction, alter filesystem
contents/scanner evidence, increase caps or change authentication. External exact-H
policy review, whole-producer success and controlled consumer qualification remain
separate gates. RELEASE_HOLD remains ACTIVE and READY_FOR_INDEPENDENT_RE_QA is NO.

### Approved bounded BCJ feasibility profile — no default change

The next diagnostic replaces the historical plain-preset-9 probe with exactly
an XZ(CRC64) container with filters `X86 BCJ -> LZMA2 preset 9` on the original Docker-save
archive. Preset 6 remains the only candidate format. There is no normalization,
runtime modification, new dependency, alternate transport or experimental upload.
The encoder records CPython/liblzma versions, filter chain, wall/CPU/RSS, input and
compressed hashes and all unchanged C/R predicates. Encoder limits stay 1GiB
address space, 480 CPU seconds and 540 wall seconds; decoder limits stay 256MiB
and 4GiB expansion. Scratch is checked before execution.

Each attempt must independently decode to the exact original archive hash and
repeat the existing image/config/all-six-layer/ELF/native-files verification,
including absence of old weed and compiler. Capacity, resources and measurements
must all pass. A first-attempt failure prevents any second compression. Only a
fully passing first attempt permits one fresh-process repetition with identical
compressed SHA-256 and runtime profile, with its own decode/integrity verification.
There is no third attempt or alternative profile search.

The only outcomes are FULL_IMAGE_FILTER_FEASIBILITY=MET_EXPERIMENT_ONLY or
FULL_IMAGE_FILTER_FEASIBILITY=NOT_MET. Either outcome retains the original
TRANSFER_BUDGET_EXCEEDED, failed Supply aggregate and blocked consumers. No result
changes the default compression or policy approval. A MET finding needs separate
Technical Lead review before any default change and full artifact qualification;
a NOT_MET finding stops implementation and returns a design-only analysis.
Release hold and all existing protected-file, policy, permission and QA boundaries
remain unchanged.

### OCI100 bounded diagnostic — not a transport implementation

Technical Lead decision
[6507055898](https://github.com/mahmoudemad68/Your_Editor/pull/100#issuecomment-6507055898)
authorizes one three-file diagnostic patch on the existing Draft PR. The sole
new native experiment is `complete-oci-raw-xz6-v1`: complete original config bytes,
six ordered raw layer tar streams, one closed OCI index/manifest and all unique
raw blobs, inside deterministic USTAR and one XZ/CRC64 preset-6 stream. Repeated
empty-layer positions remain ordered descriptors referencing one stored blob.
The former BCJ native callback is replaced; it is not run alongside OCI.

Only the outer representation changes in this diagnostic. Original layer bytes
are never normalized, retarred, edited or discarded. The streaming parser checks
source blob hashes, raw DiffIDs, config/image identity, bounded PAX metadata,
backward hardlinks, virtual-root links, traversal, duplicates, whiteouts, compiler
paths and ELF fingerprints before emitting the layout. Unsupported legitimate
metadata is a blocking result. The decoded layout must have exactly the allowed
closure and descriptor types. A fixed Docker-load adapter preserves config and
every raw stream; the unchanged existing verifier runs against it and the actual
post-load resave. Native and runtime identity checks remain in force.

Each native attempt records per-blob encoded/raw sizes, metadata forms, USTAR
header/padding bytes, all digests, actual report byte lengths, C/R/R_total, encoder
and decoder resources, adapter/parser/verifier/import/export measurements, daemon
observations, scratch and remaining job time. Imported-image checks run in the
existing producer daemon: observed daemon RSS/HWM is shared/lifetime evidence,
not import-exclusive peak memory or fresh-runner qualification. No new daemon,
privileged service or dependency is introduced. Encoder address space is 1 GiB,
CPU 480 s and wall 540 s; decoder/parser address space is 256 MiB, expansion is
4 GiB, and existing parent job deadlines are unchanged. Original config, raw
layer identities, ELF/native files and scanner-image binding must all agree.

Reports are measured as finalized, non-uploaded diagnostic JSON plus the actual
unchanged source scan/module/version reports; image blobs stay inside C. The
caps remain C <= 125829120, R_total = 2R + 65536 <= 16777216 and
2C + R_total <= 268435456 bytes, retention one day. A conservative default-zlib
DEFLATE/ZIP64 model includes a fixed-name promotion wrapper, bounded receipts and
seal. Its assumptions and byte figures are reported rather than presented as
measured GitHub archive sizes. If that bound cannot fit the existing reserve,
the diagnostic fails with `OCI_ZIP_BOUND_NOT_PROVEN`; it does not claim actual
wire overage or silently spend extra reserve. Real wire/action behavior remains
NOT_PROVEN because uploads are prohibited. The model follows the default-parameter
bound in [zlib 1.3.1 deflate.c](https://github.com/madler/zlib/blob/v1.3.1/deflate.c);
it does not certify uninspected action parameters or other library versions.
The budget is for two retained candidate copies, not all workflow network I/O.
Experimental artifact uploads/downloads are zero; existing scanner artifacts and
build/reference-image network activity remain separately observable workflow costs.

A first capacity, resource, metadata, measurement, identity, adapter or ZIP-bound
failure stops further encoding. Only a complete first pass permits one additional
fresh packaging/compression process over the same source/profile, followed by
independent decode/verification and identical compressed hashes. No third attempt,
parameter sweep, native BCJ trial, historical workflow retry or format fallback.

Possible outcomes are `OCI_REPRESENTATION_FEASIBILITY=MET_DIAGNOSTIC_ONLY` or
`OCI_REPRESENTATION_FEASIBILITY=NOT_MET`. Either preserves the original
Docker-save/XZ6 candidate and its nonretryable `TRANSFER_BUDGET_EXCEEDED`, failed
Supply aggregate and blocked consumers. All diagnostic files remain in private
producer scratch; no candidate/seal/promotion or policy approval is produced.
Complete OCI producer/consumer/wire implementation, cold-runner compatibility,
Walking action-boundary proof and Independent Re-QA remain separately gated.

## Authorized S_W diagnostic — fixed profile, no candidate promotion

Owner approvals [6508938179](https://github.com/mahmoudemad68/Your_Editor/pull/100#issuecomment-6508938179) and [6509350758](https://github.com/mahmoudemad68/Your_Editor/pull/100#issuecomment-6509350758), with [Technical Lead scope review](https://github.com/mahmoudemad68/Your_Editor/pull/100#issuecomment-6509318723), authorize one diagnostic implementation from H `5950c057b55beb51048a98ecc4af65c0a992d59f`. No production linker-profile decision is made here. Earlier scope-blocked work did not execute a size experiment.

### Exact six-path plan and immutable profile

Only `build-weed.sh`, `security-build.lock.json`, `image-reference.sh`, the existing loader, its architecture test file and this operations document change. Dockerfile, verifier, workflow files, integration helpers, source/module pins, scanner policies, held files and protected evidence remain unchanged.

The fixed `seaweedfs-go-s-w-diagnostic-v1` profile adds only `-s -w` to the existing linker argument. No arbitrary flags, environment-driven profile, post-build strip or other optimization is supported. Go 1.26.10, upstream commit `ffa87c25fdf587178b1521ad87f2a4a72a02e584`, go-jose/v4 4.1.6, Go Brotli 1.2.7, native Brotli 1.2.1-r0, target settings, source/module authentication and offline compilation stay pinned. E0 is not rebuilt.

The unchanged Dockerfile invokes the modified build script. Each of its two weed builds first verifies an independently empty compile cache. The build helper records ELF sections/program headers, file bytes, compiler, complete module/replacement/checksum metadata, settings, the exact fixed invocation and a diagnostic marker inside the existing two build reports. The marker binds the profile, source, compiler, flag hash and actual ELF hash; no new runtime file is introduced. Different ELF hashes fail the existing `cmp` gate. Program-header checks reject an interpreter or writable/executable segment. Runtime PC tables and Go build information must remain; DWARF and conventional symbol tables must be absent.

The pinned Go tool intentionally omits embedded `-ldflags` under `-trimpath`; the actual fixed invocation is recorded separately without changing that setting. Full real `go version -m` output is retained. E0 section sizes remain UNKNOWN. Reduced conventional debugger/core visibility is an accepted diagnostic tradeoff only, not production acceptance.

### Supported operator-path rejection

Both `image-reference.sh built` and `live` resolve immutable image IDs, then run the unchanged archive/layer/actual-Go verifier before checking provenance. Only after that authentication does an inline strict Python reader examine the image's two ELF-bound diagnostic markers. Consistent diagnostic evidence is rejected; malformed, missing-required, conflicting or unknown evidence fails closed. A caller environment, mutable tag, label, receipt, or identical image/checkout diagnostic locks cannot grant operator authorization. Removing the marker cannot disguise E1: the legacy unmarked path also requires the exact measured normal E0 hash `6b48572984287dcf64ed09a9080a720e65d4bf5c810c2282782fb4e5da8aa3c8`. Ordinary normal images still undergo the original verifier and CI receipt checks.

The guard executes before an ID is printed and before normal startup reaches secret preparation or container creation/start. Tests execute the real resolver and startup shell scripts with the actual Python guard, with instrumented external image-verification/Docker I/O; independent archive controls execute the unchanged verifier's real layer parser. These are software controls, not claims of a real Docker qualification on Windows. The native diagnostic additionally runs both selectors against E1 with all four CI-flag states. An isolated private Compose project contains only stopped, networkless, unprivileged containers for the live selector; no service, secret, port or volume is started. A temporary local tag is refused if already present and removed afterward. These negative controls do not admit or promote a candidate. Manual `docker run` outside supported project startup is not an enforced OS-level boundary.

### Native diagnostic and scanner evidence

Normal native PR workflows build E1 using the unchanged image recipe. The diagnostic also runs the existing scoped architecture and FFmpeg-download tests on Linux, recording genuine TAP counts; Windows FFmpeg shell-path limitations are not interpreted as Linux acceptance. In the Supply image job, the loader independently inspects the actual extracted ELF with a bounded Python standard-library reader, compares its section inventory with both build reports and uses the unchanged verifier before and after archive round-trip. It checks full module/native inventory equality across fresh pinned Trivy 0.75.0 and Syft 1.54.0, actual linked source-verified modules and the frozen E0 inventory. Baseline report hashes and normalized inventory hashes are bound in the lock (244 Go/stdlib records and 29 Alpine records, source H `6a780965f2b490859a213470b9a2995e5e156d5e`). Missing packages or sums fail even with zero findings. The complete component lists and evidence hashes are recorded.

The candidate requires zero HIGH/CRITICAL and the exact fixed Go/native Brotli versions. The original pinned donor is separately scanned as a known go-jose HIGH positive control; it is not executed. Existing isolated RSA/JWK/default-4096-bit-cap, malformed/valid Brotli and upstream test controls run with the same restricted parameters before the terminal diagnostic gate. The later workflow crypto step cannot run after that gate, so direct diagnostic execution preserves those actual controls without altering workflow ordering.

`DIAGNOSTIC_REAL_SERVICE_E2E=NOT_RUN_BY_DESIGN`: no qualified receipt is fabricated. Full S3, mTLS/firewall lifecycle, backup/recovery, browser-to-export and Walking product execution remain later promotable-image requirements. Native runtime file/UID/entrypoint/Rust identity checks and supported resolver rejection remain applicable now.

### Exact accounting and hard terminal boundary

Only the existing complete Docker-save archive/XZ preset 6 is encoded, once. No old OCI/filter diagnostic callback, alternate codec, repeat or parameter sweep is invoked. The diagnostic records raw/C hashes and bytes, independent decode equality, image/config/ordered DiffIDs, build/encoder/decoder time and RSS, visible cgroup observations, scratch availability and expansion. Existing bounds remain: encoder address space 1 GiB, default-profile CPU 540 seconds/wall 600 seconds, bounded decoder address space/dictionary 256 MiB, expansion 4 GiB and unchanged job deadlines. Twelve GiB free scratch is required before encoding. Hidden host-ancestor resources are not attested.

All six finalized provenance streams, including final diagnostic verdict/budget evidence, are physically measured in private scratch. A fixed JSON whitespace envelope, sized from actual observations with 16 KiB of headroom rounded to 4 KiB, includes the final budget and verdict without recursive length oscillation. Every padding byte is physically written and counted in R; an exhausted envelope fails without resizing. This is metadata serialization, not an additional compression attempt. `R_total=2*R+65536`; enforce C <=125829120, R_total <=16777216 and 2*C+R_total <=268435456 bytes; retention remains one day. Compressed savings are measured rather than inferred from ELF size. Actual GitHub service ZIP/wire and cross-job transfer are NOT_PROVEN because diagnostic upload is prohibited.

The loader never writes the workflow's candidate upload directory in diagnostic mode. A terminal non-retryable `S_W_DIAGNOSTIC_NON_PROMOTABLE` exception is raised even when the reported verdict is `S_W_BUILD_FEASIBILITY=MET_DIAGNOSTIC_ONLY`. Seal/admit/load/promoted/final/verify-local commands are blocked for this profile. Tests prove synthetic capacity/scanner PASS cannot reach promotion, including forged approval fields. Required aggregates remain genuinely failed; no synthetic success, candidate archive/seal upload or consumer admission is authorized. Normal scanner/evidence artifacts retain their unchanged workflow behavior.

Machine-readable diagnostic observations are emitted in bounded `S_W_DIAGNOSTIC_PART` frames with index/count and full-report SHA-256. Reassembly requires every index exactly once and the matching digest; missing/truncated frames are insufficient evidence. There is no executable/media payload in these frames. The final exact-H policy inventory remains `REVIEW_REQUIRED_NOT_APPROVED`; no self-approval is generated. Publish one native-attempt checkpoint with actual measurements, gaps and run identities, then stop. RELEASE_HOLD remains ACTIVE; SAFE_TO_MERGE and READY_FOR_INDEPENDENT_RE_QA remain NO.

## PC100 local production-candidate implementation checkpoint

This working-tree implementation adds the distinct
`seaweedfs-go-s-w-production-candidate-v1` profile. It is **not a qualified
production image**. The historical `seaweedfs-go-s-w-diagnostic-v1` path remains
non-promotable. No new ELF, image, artifact, seal, workflow result or exact-source
approval is implied by local tests.

The build keeps the fixed `-s -w` invocation, Go 1.26.10, authenticated module
archives, independent empty caches and offline compilation. The new immutable
build contract K excludes Git/run/output measurements and the exact lock hash L,
which avoids a circular hash. Each production build marker instead binds K, L,
actual ELF digest, source/compiler, fixed flags and cache label. Archive
verification authenticates all layers and reads actual Go metadata before the
marker is used. The corrected SHT_NOBITS inspector and scanner inventory
comparison are shared with the diagnostic path.

The versioned bundle, seal and admission validators bind the exact H/B/M/TH/TM,
original producer run/attempt, policy comment/record hash, K/L, actual image/ELF,
six ordered DiffIDs, inner archive and each report. Duplicate JSON keys, invalid
UTF-8, unknown fields, missing measurements and edited/ambiguous/revoked approvals
fail closed. The scope authorization is never parsed as an exact-source approval.
The native producer checks independent policy before building the candidate.

The bounded adapter is a local Node24 Action delegating to the reviewed immutable
upload/download implementations. It verifies the compiled entry, package metadata
and Action metadata hashes before execution; no npm install or alternative SDK is
used. Closed roles fix artifact names, seven/eight-file bundles, retention=1,
archive=true, STORE compression=0, exact artifact IDs, skip-decompress=true and
digest-mismatch=error. Raw output must be one regular file with the expected
physical byte count and SHA-256. The parser then checks local/central ZIP headers,
CRC, offsets, duplicates, link types, expansion and closed member sets before
extracting. Interrupted or failed official Actions do not return usable outputs.
SDK output is private and bounded; inherited preload/proxy/caller-token inputs
are removed. Cross-run reads use the already scoped read credential; same-run
Walking reads retain the contents-only model and use runner artifact credentials.

Linux child execution fixes address space=8 GiB, CPU=120 s, wall=180 s,
old-space=256 MiB, per-file limits, scratch observation/rejection and process-group
cleanup. These are implementation limits, **not new hosted compatibility claims**.
The previously passing isolated Ubuntu resource preflight establishes the kernel
primitives; it does not qualify this new adapter. Node22 repository scripts require
an existing root-owned Node24 toolcache executable for delegated downloads; absence
or untrustworthy ownership fails closed without installation. The actual hosted
runner's toolcache layout and SDK behavior still need isolated verification.

The byte predicates remain C<=125829120, R_total=2*R+65536<=16777216 and
2*C+R_total<=268435456. `physicalBudget` additionally validates measured ZIP rows,
closed roles, unique artifact IDs, individual envelope caps, cumulative P/O and a
complete final ledger. The 53490-byte client model is not a GitHub measurement.
Automatic post-completion collection of the entire multi-workflow wire ledger is
now implemented below. Actual hosted wire bytes remain unmeasured; per-artifact
checks must not be presented as final global proof.

Operator built/live resolution authenticates the actual image and requires
production admission regardless of GITHUB_ACTIONS. Startup rejects missing
admission before build/secret preparation. The current verifier requires the
native authenticated admission context; portable non-runner operator receipt
acceptance still needs integration and tests. A copied JSON receipt alone cannot
activate the image.

Local tests deliberately separate genuine shell/parser execution from instrumented
Docker I/O. They establish software rejection behavior, not actual S3/mTLS, native
ASR, security scan, browser/export or GitHub Artifact qualification. No candidate
services or workflows are started in this phase. The focused Linux command is:

```sh
# Existing genuine Node24 on an authorized GitHub-hosted Ubuntu executor.
node --version
node --test --test-name-pattern='PC100 Linux bounded' tests/architecture/seaweedfs-security-build.test.mjs
```

Next steps are independent source review and isolated execution of the actual
bounded delegation/raw ZIP contracts. Off-runner operator authentication is a
separate deferred release feature, not a PR-candidate blocker. Real candidate/MinIO journeys, all six ASR shards, fresh
scans, whole-Supply completion and exact-head CI/Walking remain later qualification
work. Local source inventory is REVIEW_REQUIRED_NOT_APPROVED. Code remains
uncommitted; RELEASE_HOLD=ACTIVE, SAFE_TO_MERGE=NO and
READY_FOR_INDEPENDENT_RE_QA=NO.

## PC100 final wire reconciliation — local implementation

The automatic reconciler is implemented in the existing loader. It is a
**read-only post-completion checkpoint**, not a new workflow/controller or a
CI↔Walking dependency. Native `final` steps establish identity and explicitly
report that global wire measurement is still required. Neither consumer waits
for the other. No final wire/QA qualification may be claimed from identity-only
steps or the earlier diagnostic size measurement.

After BOTH genuine consumer workflows have completed successfully, from the
reviewed immutable product/merge checkout and an already authorized read-only
GitHub environment, run:

```sh
node tools/test/load-qualified-storage.mjs wire-ledger CI_RUN_ID:WALKING_RUN_ID
```

Replace the two numeric run IDs. This command does not rerun them. The default
output is `.local/issue99/final-wire-ledger.json`; it refuses to overwrite prior
evidence. An optional output filename must remain directly under
`.local/issue99/`. It creates no receipt, artifact, image, Git ref or service.
The reconciler has no standalone operator authorization path.

It re-establishes live PR H/B/M/TH/TM, exact merge parents and equal trees,
independent source-policy hashes/K/L, whole-Supply success, both completed native
consumer runs and genuine aggregate check associations. It enumerates all
retained artifacts from the original source and both consumer runs, including
all attempts' outcome artifacts. Every attempted upload is reconciled with its
actual job/step record: a completed upload with a missing API artifact is a
failure, while a verified skipped upload is explicit absence evidence. Unknown,
duplicate, wrong-attempt, expired, partially measured or inconsistent artifacts
fail closed. Extra outcomes are enumerated/accounted even when current retry
policy rejects them; they cannot be hidden from P/O.

Every retained transfer ZIP is independently downloaded read-only with bounded
HTTP size/time, matched to API ID/digest/physical bytes, then parsed through the
strict STORE ZIP verifier. C/R come from measured source bundle files; all seven
Walking source files must be byte-identical. Seal, separate CI/Walking receipts,
source manifest and outcome identities must agree. Large bundle files are
removed after hashing before the next bundle is downloaded, keeping a single
raw ZIP/extracted bundle in scratch. Scanner/product artifacts are enumerated
as non-transfer inventory rather than silently included or silently hidden.

Final accounting uses actual bytes: `P=Zs+Zw+Zseal+Zci+Zother` and
`O=max(0,Zs-C-R)+max(0,Zw-C-R)+Zseal+Zci+Zother`. All original C/R/P/O predicates
and retention remain unchanged. The API inventory, live PR, policy and run
attempts are reread before writing a successful ledger. Any incomplete read
produces failure evidence with `fully_measured=false`, observed rows and partial
accounting (or null); missing bytes are never replaced with zero. The output is
wire evidence only, not release approval or an Independent QA verdict.

**Standalone operator authentication is deferred**, as directed by Technical
Lead #6518204248. Current native-context receipt requirements and fail-before-
secrets behavior remain intact; this release feature is not a PR-candidate
implementation blocker.

The existing test file also prepares credential-free tests of the actual new
adapter supervisor: bounded Node24 startup/file-size rejection, measured CPU
termination, child-group timeout/cleanup and genuine nonzero exit propagation.
Run on genuine Linux Node24 with:

```sh
node --test --test-name-pattern='PC100 Linux' tests/architecture/seaweedfs-security-build.test.mjs
```

These tests use actual child processes with stricter test-only CPU/wall bounds;
production defaults remain 120/180 seconds. Test bounds cannot exceed them and
are not Action inputs or environment overrides. Windows reports explicit skips.
No isolated workflow, test commit or Linux result is created by this local
implementation. Technical Lead must inspect the frozen full patch first and
execute the tests on an independently published immutable isolated test commit.
The old generic Ubuntu preflight does not qualify the new adapter, SDK transfers,
actual ZIP overhead, candidate image or browser-to-export path.

## Independent source-review corrections — 2 November 2026

Technical Lead disposition #6568961298 requested two local corrections. The
original 1 November source package, patch and inventories are preserved unchanged.
No production source publication or new policy approval is implied.

**Walking authentication:** public provenance reads now use an explicit,
closed metadata-only REST mode. It never inherits an ambient GITHUB_TOKEN or
GH_TOKEN; a private, missing, denied or rate-limited response fails closed without
credential fallback. Protected API reads and raw cross-run artifact downloads
still require the existing authorized GITHUB_TOKEN. Anonymous mode cannot read a
ZIP or an arbitrary REST route. This fixes the ambiguous authentication-class
coupling without adding Actions-read to the contents-only downstream Walking job.

The same-run adapter additionally checks the promoted artifact's real API
ID/name/digest/bytes/run/attempt and the completed preparation upload step before
SDK delegation. The official SDK requires runner-issued runtime credentials and
an approved GitHub results-service origin; same-run inputs cannot inherit an
Owner token or switch to another run. The subsequent promoted ZIP path retains
live identity/policy/producer checks and verifies the exact preparation receipt,
manifest and compressed bytes before any image operation. No copied JSON flag
replaces these checks. The shared pre-load verifier is exercised directly by the
new deterministic path test.

**Ledger classification:** unfamiliar artifact names are now rejected. A retained
artifact can be excluded only through a closed evidence-name/workflow mapping
AND actual completed job/upload-step provenance for the correct run/attempt and
creation window. The evidence classes cover the current dependency/scan/SBOM,
CI summary/coverage/ASR/product and Walking diagnostic uploads. Missing, ambiguous,
wrong-job, wrong-attempt, duplicate-name or unclassified evidence fails closed.
The final collector supplies real attempt/job records; a caller manifest's
classification claim is insufficient. Transfer C/R/R_total/P/O ceilings and all
retained-outcome accounting are unchanged.

The Windows tests instrument only external Git/HTTP inputs, exercise actual
admission/header/ZIP/pre-load checks and explicitly use synthetic identities.
They issue no real approval and execute no official SDK transfer or candidate.
Actual anonymous metadata availability/rate limits, official Artifact roundtrips,
ZIP envelopes and the new adapter's Linux resource behavior remain subject to
isolated hosted execution and later native qualification. The three existing
Linux adapter tests are prepared, not executed on Windows. Public API failure
must stop the path, never grant extra permissions or silently accept stale data.

The new complete review package has its own explicit inventory and SHA-256s;
the original package remains the immutable historical review input. PR #100
remains Draft, all code local/uncommitted, POLICY_APPROVAL=NOT_GRANTED,
RELEASE_HOLD=ACTIVE and SAFE_TO_MERGE=NO.

## Automated development source verification

Development admission now consumes a genuine successful GitHub check from
`pc100-source-verifier.yml`, executed from protected `main` after the isolated
artifact integration workflow completes. It never checks out or executes PR
code, writes statuses, issues Owner approvals or grants release authority.
It compares the 31 security-relevant Git blobs with a fixed immutable baseline,
and the five verifier/integration files with protected-default source. It checks
live PR/head/base/merge/tree identities, upstream run/attempt, complete Git trees
and actual blob hashes. Consumers independently verify the workflow, run, check
association, annotation, source hashes and live identities. Version-3 manifests,
seals and receipts bind the actual verifier run instead of a human comment ID.

The verifier must first be installed on protected `main` through the repository's
normal protected review process. Its presence in this PR provides no independent
trust. That installation must also enforce the genuine GitHub Actions
`PC100 trusted source verification` required check through protected repository
controls. A PR-controlled consumer cannot be the enforcement root for its own
code: a modified client must still be rejected by the protected-default checker
and its required-check binding. Neither installation nor repository settings are
changed by this PR. Until installation and genuine successful verification, admission fails
with `TRUSTED_VERIFIER_NOT_INSTALLED`; the Supply aggregate fails before image
builds. This bootstrap dependency cannot be satisfied by a PR-authored manifest.
Existing scanner pins, vulnerability policies, artifact budgets, release hold,
diagnostic rejection and production authorization remain unchanged.

The isolated `PC100 artifact integration` workflow uses a disposable 64-KiB
fixture, official pinned upload Action and the actual shell REST download path.
It performs no image build or service startup. Its pass is transport evidence,
not full Supply/CI/Walking or production qualification.

Source-verdict readiness is reconciled through bounded read-only observations
within the original admission attempt (maximum 120 seconds). Failed preflights,
ambiguous completed verdicts, identity drift and deadline expiry are terminal;
no workflow is retried. Downstream Walking retains contents-only permissions and
uses an explicit separate metadata credential for closed public GETs, avoiding
the unauthenticated API quota. This credential is never used for archive REST
downloads or inherited by the official same-run Artifact SDK child.
