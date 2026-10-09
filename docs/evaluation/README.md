# Evaluation baseline operator guide

US-110 provides 12 licensed sources, six genuinely human-created and Owner-approved reference
reels, three generated word-alignment clips, three generated silence clips and eight metric
definitions. The Project Owner explicitly waived additional manual hand-labelling and accepts
technically verified generated annotations as the project baseline. See [OWNER_DECISION.md](OWNER_DECISION.md).
Annotation `createdBy=machine_generated` preserves real producer provenance; `project-owner`
approved the generated approach/artifacts through the explicit deviation. No annotation is claimed
as manually hand-labelled. The 6/3/3 quotas remain unchanged.

Gold acceptance for QA and durable release readiness are separate. Local private versioned storage
is not a durable team archive; the Owner authorized QA preparation while that finding remains open.

## Offline validation

```sh
pnpm install --frozen-lockfile
pnpm evaluation:validate
pnpm evaluation:test
pnpm evaluation:validate --require-gold
```

The first command needs normal package installation; metadata validation/tests thereafter require no
network, bucket credentials, model downloads or GPU. Ordinary validation checks structure and prints
human-created, Owner-approved, durable-storage and release states separately.
`--require-gold` accepts the exact documented Owner deviation for this project; `--require-human-gold`
continues to fail because manual annotation quotas are unmet. `--require-release` continues to fail
until durable versioned storage is verified. Without an explicit valid Owner deviation, generated
annotations cannot satisfy the gate and the original human-created/durable requirements remain.

JSON Schemas live in `packages/schemas/src/evaluation-*.schema.json`; no generated bindings are maintained.
`pnpm evaluation:docs` regenerates METRICS.md from metrics.json. Optional inference dependencies are
isolated in the environment described below; offline CI does not import or install them.

## Obtain sources and inspect storage

```sh
python3 tools/evaluation/obtain.py --root .local/evaluation
```

Read manifest source/licensing evidence before acquisition. This command downloads only the pinned
HTTPS Wikimedia representations, checks exact sizes and SHA-256, and reuses existing matching
files. External content is untrusted; it is never executed. Downloads are bounded; decoder commands
allow local files and approved container formats, never remote FFmpeg fetching or playlists.

Configure through environment, never chat, command-line credentials or checked-in files:

```sh
export EVALUATION_S3_ENDPOINT=https://your-private-s3-endpoint.example
export EVALUATION_S3_BUCKET=your-editor-evaluation
export EVALUATION_S3_REGION=us-east-1
# Set EVALUATION_S3_ACCESS_KEY_ID and EVALUATION_S3_SECRET_ACCESS_KEY via your secret manager.
pnpm evaluation:sync --root .local/evaluation --dry-run
pnpm evaluation:sync --root .local/evaluation
pnpm evaluation:deep
```

Create a private S3-compatible bucket and enable native object versioning beforehand using trusted
operator tooling. Sync does not create buckets, alter policies, enable versioning or delete objects.
Missing configuration, mismatched bucket, disabled versioning and checksum conflicts fail closed.
HTTP is accepted only for local loopback development; remote endpoints require HTTPS. Dry-run checks
local file identity and prints planned safe keys without making storage requests. Actual sync/deep
verification checks every object byte, size and version ID. Exact objects are reused; conditional
writes prevent overwriting an existing content-addressed name. No credentials or signed URLs are
logged. Use scoped read/write permissions to this evaluation prefix in shared environments.

For this implementation, the chosen bucket is a **local persistent development bucket**, at loopback
port 9001, backed by `us110-evaluation-data`. Credentials and source/reel files are in ignored
`.local/` directories. This is implementation evidence, not deployment. A durable team-hosted bucket
must be configured before handing the data to other developers. Obtain public sources independently
with the command above; migrate source/reel bytes and committed metadata with sync. Do not commit
videos, reference MP4s, private consent documents, secrets or presigned URLs, including through LFS.

## Render and complete human references

Each source's `referenceArtifacts` points to JSON metadata and private objects. Artifacts inherit their
source category and applicable source license/attribution; reel entries record their own rendered
`durationUs`, independently of full-source duration. Edit specifications
contain source ID/hash, dataset version, ordered source intervals and contiguous output offsets,
all in decimal integer microseconds. Current approvals protect the reviewed content; published edits are frozen. A render receipt ties source,
editorial fingerprint, output SHA, duration and FFmpeg/ffprobe versions together. Review bookkeeping
is excluded from the canonical sorted-key editorial fingerprint; segments and decision notes are
included. The manifest also checks the full metadata-file SHA.

The active `evaluation-dataset-v1` is **unreleased**. Complete its first genuine human edits,
annotations and approvals in v1; uploading machine candidates did not publish/freeze the dataset.
No v2 fork is required for this first Owner work. The six current human edit specifications record
the Owner's explicit decision to retain 00:00–00:30 after personally watching the sources. All six
reels have been rerendered with current edit fingerprints and personally watched and approved by
the Owner. Their status is `approved`, with explicit Owner attestation, review notes, the current
edit fingerprint and exact rendered-reel hash recorded through the existing review tool.
The next Owner work is annotation gold and approved durable storage. For future revisions within unreleased v1:

1. Watch each full source and its candidate; source files are in the obtain directory and candidate
   reels are `<source-id>-reference-reel.mp4`. Use an ordinary local video player.
2. Make real editorial decisions for at least six sources. Edit the readable JSON `segments` and
   `decisionNotes`, then set `createdBy` to `human`. First-30-second suggestions are only starting
   points; do not approve them without making/documenting actual human decisions.
3. Render the current specification and watch source plus resulting reel:

```sh
pnpm evaluation:render commons-82236797 --root .local/evaluation
```

4. Record your own review (these commands are examples; the six current approvals were recorded
   by the Coding Agent only after the Owner explicitly supplied genuine review and authorization):

```sh
pnpm evaluation:review commons-82236797-edit-spec \
  --decision approved --reviewer owner-stable-id \
  --notes 'Explain your actual editorial review and decisions here' \
  --attest-human-review --root .local/evaluation
```

Use `--decision rejected` to record rejection and notes. The tool verifies that the exact current
human edit was rendered and the local reel matches its receipt; it refuses machine-only edits,
unattested reviews and stale renders. The CLI records an explicit Owner attestation, not external
identity authentication or cryptographic proof of watching. Keep review audit access controlled.
Rejected artifacts may be revised/rerendered and reviewed again in the unreleased version; a
unreleased approval must be explicitly invalidated before revision, as described below. The other unapproved artifacts can receive their first gold inside v1.

## Generated annotation baseline under the Owner deviation

The Owner explicitly accepts the existing 30–90 second scopes for two English clips and one Arabic
clip. Labels use SOURCE coordinates, decimal integer microseconds, ordered nonoverlapping ranges.
Word/silence gold covers these 60-second windows, not full source videos or reference reels.

| Source ID        | Language | Source duration (s) | Scope start (s) | Scope end (s) | Clip duration (s) |
| ---------------- | -------- | ------------------: | --------------: | ------------: | ----------------: |
| commons-28956463 | en       |             125.382 |              30 |            90 |                60 |
| commons-98650286 | en       |             350.434 |              30 |            90 |                60 |
| commons-82236797 | ar       |             626.744 |              30 |            90 |                60 |

The existing `evaluation:annotation-clip` helper can extract each window for local viewing. It
never changes labels or approval. The isolated generator uses benchmark-compatible Faster-Whisper
and its bundled Silero ONNX model; it is not a production worker or a change to US-105's Draft PR.
No WER/F1 quality score or CP2 pass is claimed against this generated baseline.

Install optional pinned tooling outside production dependencies:

```sh
uv venv --python 3.11 .local/evaluation-tools/.venv
uv pip install --python .local/evaluation-tools/.venv/bin/python \
  -r tools/evaluation/requirements-generation.txt
```

The existing Supply Chain Python audit also audits this optional requirements file and retains
`python-evaluation-audit.json` separately. Its HIGH/CRITICAL findings, unknown severity or scanner
failure fail closed. These exact-version optional packages do not enter production images or
worker dependency graphs. Package hashes are not pinned in this repair: generating a complete
cross-platform wheel/source hash lock would add disproportionate churn to the existing 23-package
optional pin set. Known-vulnerability auditing is mandatory and now runs in CI/Supply Chain.

Download the immutable multilingual model (public MIT weights; keep them outside git):

```sh
HF_HUB_DISABLE_XET=1 .local/evaluation-tools/.venv/bin/python - <<'PYMODEL'
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="Systran/faster-whisper-small",
    revision="536b0662742c02347bc0e980a01041f333bce120",
    local_dir=".local/evaluation-tools/model-small",
    allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.*"],
)
PYMODEL
.local/evaluation-tools/.venv/bin/python tools/evaluation/generate.py \
  --root .local/evaluation --model .local/evaluation-tools/model-small \
  --output .local/evaluation-generated
```

The generator verifies pinned model weights and source identity, extracts local-only PCM using
FFmpeg argument arrays, and makes real model calls. No network media URLs reach FFmpeg.
Word times are decimal half-up microseconds; VAD sample times use integer floor conversion.
Scope offsets produce SOURCE coordinates. Empty/zero-duration model words are omitted with raw
provenance, never assigned invented durations; overlaps fail rather than get silently repaired.
Raw inference, PCM and model weights remain outside git. Artifact generation fields retain
exact model/tool/recipe/audio/raw-result identities and settings. Two producer-machine passes
matched during implementation, but bit-exact regeneration is not guaranteed across hardware or
even every same-machine run. QA measured approximately 1% English / 17% Arabic cross-hardware
differences and one substantially degenerated Arabic pass. CTranslate2, CPU/ISA and threading may
affect output. Committed word gold is frozen by content identity and must not be treated as
independently reproducible ground truth. Do not overwrite approved labels to chase regeneration.

Preserve the exact original producer bytes, without inference or re-approval:

```sh
pnpm evaluation:archive-evidence --root .local/evaluation-generated \\
  --media-root .local/evaluation --dry-run
pnpm evaluation:archive-evidence --root .local/evaluation-generated \\
  --media-root .local/evaluation
pnpm evaluation:sync --root .local/evaluation
pnpm evaluation:deep
```

This verifies the hashes already recorded in the approved annotations, independently checks
raw-to-label conversions and stages nine existing files: three scoped WAVs, three joint raw JSON
word/Silero outputs, and three original conversion records. `producerEvidence` in the manifest
binds their source SHA, scope, annotation IDs, dataset version, SHA, size and content-addressed
private object keys. Sync/deep include this evidence, require enabled native bucket versioning
and verify exact bytes. A missing/mismatched original fails; regenerating a substitute is not
archival. Model weights are identified by hash and are not included in these nine evidence objects.

For a _new unapproved_ annotation snapshot, import and technically validate before approval:

```sh
pnpm evaluation:import-generated --root .local/evaluation --output .local/evaluation-generated
pnpm evaluation:validate
```

These generation/import examples describe new, unapproved snapshots; the current approved gold
must not be regenerated or overwritten. Its original bytes, not another inference pass, are the
archival source of truth.

The importer replays conversions against raw inference and verifies every source/input/result before
writing any annotation. It refuses approved artifacts; preserve provenance and explicitly invalidate
review before a genuine authorized revision. Never silently mutate approved data. The current six
annotations already have actual Owner approach acceptance; that authorization was supplied explicitly
in the implementation conversation, not inferred by the Coding Agent.

The review tool requires the manifest's exact deviation, accepted source/scope, stable reviewer,
notes, attestation and explicit generated-baseline flag. This example records approach acceptance,
not hand-labelling or a claim of watching every generated label:

```sh
pnpm evaluation:review commons-82236797-word-alignment \
  --decision approved --reviewer project-owner \
  --notes 'The Project Owner explicitly reviewed the evaluation approach and accepts this generated annotation artifact as the project gold baseline. The Owner waived additional manual hand-labelling for US-110.' \
  --attest-human-review --accept-generated-baseline
```

Approval records `approvalBasis=owner_accepted_generated` and the deviation ID. Machine candidates,
missing generation identity, empty labels, wrong scope/source or stale fingerprints cannot count.
All approved artifacts require the exact `project-owner` reviewer. The reviewed manifest's
`ownerDecision.acceptedArtifacts` freezes the expected producer and content/generation hashes
for these six generated artifacts. Their provenance cannot be removed by recomputing an unsigned
annotation fingerprint. Scoped metric consumers must pass `manifest.ownerDecision` (or explicit
`null` from a validated version with no deviation); never choose authority from annotation fields.
Later version forks clear the decision and keep the original producer archive tied to its old
snapshot, allowing genuine human replacements in the new version.
Generated gold requires the recorded Owner decision when calling `scopedMetricInputs`; returned
provenance distinguishes it from human-created gold. Metrics retain their formulas and CP2 thresholds.

An independently hand-labelled baseline remains a future option: only genuine manual production
may use `createdBy=human`, and it must receive its own real approval. The current generated artifacts
must never be relabelled as human-created to make the original gate pass.

## Durable completion and release lifecycle

Local SeaweedFS is **not a durable team archive**. No durable target is currently configured:
`GOLD_STORAGE_DURABLE=false` and `US110_RELEASE_COMPLETE=false`. The Owner decision permits QA preparation with this storage finding; project `US110_GOLD_COMPLETE` reports Owner-accepted gold separately.
For durable release readiness, the Owner must configure a real approved team S3-compatible destination
(or explicitly approve another durable Project target), keep it private and enable native versioning.
Do not invent a destination. In manifest `storage.durableTarget`, record non-secret `endpoint`
(HTTPS), `approvedBy` (stable Owner ID), `approvedAt` (UTC) and `notes` explaining the actual durable
Project target approval. Set endpoint/bucket/credentials via environment; if the bucket name changes,
update manifest storage before syncing. Endpoint alone is not a durability claim.

```sh
pnpm evaluation:sync --root .local/evaluation --dry-run
pnpm evaluation:sync --root .local/evaluation
pnpm evaluation:deep
pnpm evaluation:certify --root .local/evaluation
pnpm evaluation:validate --require-gold
```

`certify` requires the Owner-approved target to match configured HTTPS storage. It idempotently
syncs exact content, then performs a separate full-object GET/checksum/version pass and writes
`docs/evaluation/storage-verification.json`. This non-secret receipt binds every ID, key, exact SHA,
size and non-null native version ID to the dataset/metrics fingerprint and target. Offline validation
checks receipt consistency without bucket access; a metadata/target change invalidates the receipt.
Run certification again after all gold changes. These receipts are operator evidence, not a signed
provider guarantee of durability; the Owner must actually approve and maintain the archive.

The original lifecycle requires human-created labels and durable storage. Under the documented
Owner decision, verified generated labels and explicit Owner approval allow Independent QA with
the local-storage finding; durable sync/deep verification is still required before a published
release. After QA/authorized release, freeze the snapshot by
setting manifest `release.status="published"` and `release.frozenDatasetSha256` to the
`DATASET_SHA256` canonical fingerprint printed by `pnpm evaluation:validate`.
This bookkeeping does not alter that fingerprint. A published snapshot cannot validate if its meaning
changes or approved gold/durable-storage evidence is incomplete. Render/review refuse a published snapshot.
No publication or freeze is performed by the Coding Agent in this Draft PR. Forking clears the active Owner waiver; a later version needs its own genuine acceptance.

Before publication, the Owner can revise approved v1 gold **without a version fork**: preserve the
approved metadata/receipt in git first, then explicitly replace that artifact's `review` object with
`{"status":"awaiting_human_review"}` (removing the old current `evidence`). Make the real human changes,
rerender edits, and run the explicit review CLI again. Never retain an old approval over changed
content; validation rejects stale fingerprints and the tools refuse implicitly reopening an approved
artifact. Resetting review makes it count as zero until a fresh genuine review passes. Old git
records and immutable content-addressed bucket objects preserve the previous provenance.

Only changes to an approved snapshot **after its published freeze** require a later version:

```sh
pnpm evaluation:version evaluation-dataset-v2
```

The tool archives old metadata/evidence, selects a new prefix/version, clears reviews and durable
verification, and leaves the new snapshot unreleased. Historical objects are never overwritten or
deleted. Approved artifacts remain immutable within a published version. Update the new dataset
card honestly; archived documentation remains unchanged.

## Reporting and future consumers

[DATASET_CARD.md](DATASET_CARD.md) states actual scope, licensing, storage and biases.
[METRICS.md](METRICS.md) is generated from [metrics.json](metrics.json). Each report should identify
dataset/schema version, manifest commit/SHA, gold artifact hashes, scorer/tool versions, language,
sample/coverage counts and missing inputs. US-201 consumes word gold for WER/timing; US-202 and US-204
consume silence gold. Later editing/render stories consume reference specs/reels and metric contracts.
This story does not implement production ASR/VAD, a timeline, rendering services or an AI editing agent.

Security scan attribution and the 342 → 343 HIGH-row advisory drift are recorded in
[SECURITY_BASELINE.md](SECURITY_BASELINE.md); absolute scanner totals and PR-attributable changes
are reported separately.
