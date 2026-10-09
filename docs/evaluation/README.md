# Evaluation baseline operator guide

US-110 provides 12 licensed sources, six **Owner-approved human reference reels**, empty annotation
templates and eight metric definitions. It currently reports `BLOCKED_ON_OWNER_GOLD`; it is not a
completed gold dataset. The Owner personally watched the six prepared sources and intentionally
retained each 00:00–00:30 reference interval. Those editorial decisions are recorded as human edits;
the Owner has also personally watched and explicitly approved all six exact rendered reels.
Approval evidence uses the stable reviewer ID `project-owner` and each verified reel SHA-256.
Follow the Owner steps below to complete at least three hand-labelled silence/word clips and
configure approved durable storage. Human-gold and release completeness remain false.

## Offline validation

```sh
pnpm install --frozen-lockfile
pnpm evaluation:validate
pnpm evaluation:test
pnpm evaluation:validate --require-gold
```

The first command needs normal package installation; metadata validation/tests thereafter require no
network, bucket credentials, downloaded media or GPU. The ordinary validation command exits zero
only for structural validity and prints `US110_GOLD_COMPLETE: false` until both genuine human quotas and durable-storage verification pass. `HUMAN_GOLD_COMPLETE` reports the 6/3/3 quotas separately from `GOLD_STORAGE_DURABLE`.
`--require-gold` exits nonzero when six approved human references, three approved silence clips or
three approved word-aligned clips are missing, or durable storage evidence is absent/stale. CI checks structure/document drift, not a fake gold
completion. JSON Schemas live in `packages/schemas/src/evaluation-*.schema.json`; no generated
bindings are maintained. `pnpm evaluation:docs` regenerates METRICS.md from metrics.json.

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

## Hand label silence and words

Gold annotations cover explicit bounded **clips**, not whole source videos or the 30-second
reference reels. Each word/silence pair has a provisional 60-second viewing scope. These offsets are
machine candidates prepared for selection, **not a claim of suitable speech or an Owner decision**.
The Owner must listen, confirm/change them, and choose roughly 45–60 seconds of useful speech with
boundaries between words. No semantic selection or human labelling has happened yet.

| Source ID        | Language | Published title                                                                                       | Source duration (s) | Candidate start (s) | Candidate end (s) | Clip duration (s) |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------- | ------------------: | ------------------: | ----------------: | ----------------: |
| commons-28956463 | en       | What is a web science unMooc?.webm                                                                    |             125.382 |                  30 |                90 |                60 |
| commons-98650286 | en       | Katherine Maher's message on the occasion of Wikipedia 20.webm                                        |             350.434 |                  30 |                90 |                60 |
| commons-82236797 | ar       | Wikimedia Strategy 2030 - Diversity - Interview Walaa Abdelmanaem (AR) - لقاء مع ولاء عبد المنعم.webm |             626.744 |                  30 |                90 |                60 |

1. Obtain sources, inspect the source in a local player, and view the exact candidate windows:

```sh
pnpm evaluation:annotation-clip commons-28956463 --root .local/evaluation
pnpm evaluation:annotation-clip commons-98650286 --root .local/evaluation
pnpm evaluation:annotation-clip commons-82236797 --root .local/evaluation
```

The local helper verifies source SHA/size, decodes local files with FFmpeg argument arrays, and
prints the title, language, scope and output path. Open that MP4 in an ordinary video player. It
never changes annotations, selects gold, records approval or accesses media URLs through FFmpeg.
It refuses overwriting an existing local viewing clip. Delete only that helper output to regenerate.

2. In each pair's readable `silence-labels.json` and `word-alignment.json`, confirm/change
   `scope.startUs` and `scope.endUs`, then record `scope.selection="owner_confirmed"` **yourself after
   listening**. Keep the pair's scopes equal to use the helper, or document intentionally separate
   word/silence windows. Each independent annotation is validated against its own explicit scope.

3. Hand label only that chosen window. Canonical timestamps are **SOURCE coordinates**, decimal
   integer microseconds. A local extracted player's 0:05 corresponds to `scope.startUs + 5000000`.
   Silence uses half-open `[startUs,endUs)`; words retain original text, case, punctuation and Unicode.
   Every label must satisfy `scope.startUs <= startUs < endUs <= scope.endUs`; ranges are ordered and
   nonoverlapping. The scope must satisfy `0 <= startUs < endUs <= source.durationUs`.

4. Record actual methods/checks in `annotationNotes` and set `createdBy=human` only after your hand
   labelling. Confirm the gold scope and review both text and boundaries. No ASR/VAD output is gold.
   Then use the existing explicit Owner review commands:

```sh
pnpm evaluation:review commons-82236797-silence-labels \
  --decision approved --reviewer owner-stable-id \
  --notes 'Actual listening and boundary-review details' --attest-human-review
pnpm evaluation:review commons-82236797-word-alignment \
  --decision approved --reviewer owner-stable-id \
  --notes 'Actual Arabic word and timestamp review details' --attest-human-review
pnpm evaluation:validate
pnpm evaluation:sync --root .local/evaluation --dry-run
pnpm evaluation:sync --root .local/evaluation
pnpm evaluation:deep
```

Empty templates are not completed annotations and cannot count. Approval fingerprints make later
content changes detectable. No private reviewer information or consent documents are required in
git; use a stable non-secret pseudonym. Counts must reach 6/3/3 through real Owner work. Empty **approved** annotations and unconfirmed
scopes fail validation, rather than count as gold. Counts are distinct licensed source IDs for each
artifact type (one word artifact and one silence artifact per source); duplicate windows/IDs cannot
inflate quotas. Two English plus one Arabic template are prepared, but all remain unlabelled.

## Durable completion and release lifecycle

Local SeaweedFS is **not a durable team archive**. No durable target is currently configured:
`GOLD_STORAGE_DURABLE=false` and release `US110_GOLD_COMPLETE=false`, even if human quotas later pass.
Before Independent QA, the Owner must configure a real approved team S3-compatible destination
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

Lifecycle: **unreleased v1 → human edits/labels → approval → strict validation → durable sync/deep
verification → Independent QA → merge/release**. After QA/authorized release, freeze the snapshot by
setting manifest `release.status="published"` and `release.frozenDatasetSha256` to the
`DATASET_SHA256` canonical fingerprint printed by `pnpm evaluation:validate`.
This bookkeeping does not alter that fingerprint. A published snapshot cannot validate if its meaning
changes or gold/storage evidence is incomplete. Render/review refuse a published snapshot.
No publication or freeze is performed by the Coding Agent in this Draft PR.

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
