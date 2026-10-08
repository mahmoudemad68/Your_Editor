# Evaluation baseline operator guide

US-110 provides 12 licensed sources, six **machine-created viewing candidates**, empty annotation
templates and eight metric definitions. It currently reports `BLOCKED_ON_OWNER_GOLD`; it is not a
completed gold dataset. No reviewed assets were supplied. Follow the Owner steps below to complete
six actual human edits and at least three hand-labelled silence/word clips.

## Offline validation

```sh
pnpm install --frozen-lockfile
pnpm evaluation:validate
pnpm evaluation:test
pnpm evaluation:validate --require-gold
```

The first command needs normal package installation; metadata validation/tests thereafter require no
network, bucket credentials, downloaded media or GPU. The ordinary validation command exits zero
only for structural validity and prints `US110_GOLD_COMPLETE: false` until all genuine quotas pass.
`--require-gold` exits nonzero when six approved human references, three approved silence clips or
three approved word-aligned clips are missing. CI checks structure/document drift, not a fake gold
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

Each source's `referenceArtifacts` points to JSON metadata and private objects. Edit specifications
contain source ID/hash, dataset version, ordered source intervals and contiguous output offsets,
all in decimal integer microseconds. An approved edit is frozen. A render receipt ties source,
editorial fingerprint, output SHA, duration and FFmpeg/ffprobe versions together. Review bookkeeping
is excluded from the canonical sorted-key editorial fingerprint; segments and decision notes are
included. The manifest also checks the full metadata-file SHA.

First fork the uploaded v1 snapshot before making human-gold changes:

```sh
pnpm evaluation:version evaluation-dataset-v2
pnpm evaluation:docs
```

This archives the old metadata under `docs/evaluation/releases/`, uses a fresh version/prefix, and
clears review status. No bucket deletion/overwrite occurs. Update the active dataset card and release
status to describe the new snapshot honestly; archived cards stay unchanged. Do not commit archival
media binaries.
Within the new unreleased version, the Owner should:

1. Watch each full source and its candidate; source files are in the obtain directory and candidate
   reels are `<source-id>-reference-reel.mp4`. Use an ordinary local video player.
2. Make real editorial decisions for at least six sources. Edit the readable JSON `segments` and
   `decisionNotes`, then set `createdBy` to `human`. First-30-second suggestions are only starting
   points; do not approve them without making/documenting actual human decisions.
3. Render the current specification and watch source plus resulting reel:

```sh
pnpm evaluation:render commons-82236797 --root .local/evaluation
```

4. Record your own review (these commands are examples; the Coding Agent has not run approval):

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
published or approved artifact needs another version fork.

## Hand label silence and words

The three source pairs awaiting labels are:

- `commons-28956463` — English web-science explanation.
- `commons-98650286` — English Wikipedia anniversary message.
- `commons-82236797` — Arabic interview with Walaa Abdelmanaem.

Listen to each source and fill its `silence-labels.json` and `word-alignment.json` under
`docs/evaluation/artifacts`. Label the **whole source** (templates cover the source, not just the
30-second reel). Silence ranges use `[startUs,endUs)`; words have original `text`, `startUs`, `endUs`
and optional speaker/notes. Preserve Unicode, punctuation and case; no generated alignment is gold.
Ranges must be positive, ordered, nonoverlapping and inside source duration. Explicitly note the
annotation method and reviewer checks; set `createdBy=human` only after actually hand labelling.

```sh
pnpm evaluation:review commons-82236797-silence-labels \
  --decision approved --reviewer owner-stable-id \
  --notes 'Actual listening and boundary-review details' --attest-human-review
pnpm evaluation:review commons-82236797-word-alignment \
  --decision approved --reviewer owner-stable-id \
  --notes 'Actual Arabic word and timestamp review details' --attest-human-review
pnpm evaluation:validate --require-gold
pnpm evaluation:sync --root .local/evaluation --dry-run
pnpm evaluation:sync --root .local/evaluation
pnpm evaluation:deep
```

Empty templates are not completed annotations and cannot count. Approval fingerprints make later
content changes detectable. No private reviewer information or consent documents are required in
git; use a stable non-secret pseudonym. Counts must reach 6/3/3 through real Owner work before marking
US-110 gold-complete or ready for independent QA. Arabic labelling remains explicitly outstanding.

## Reporting and future consumers

[DATASET_CARD.md](DATASET_CARD.md) states actual scope, licensing, storage and biases.
[METRICS.md](METRICS.md) is generated from [metrics.json](metrics.json). Each report should identify
dataset/schema version, manifest commit/SHA, gold artifact hashes, scorer/tool versions, language,
sample/coverage counts and missing inputs. US-201 consumes word gold for WER/timing; US-202 and US-204
consume silence gold. Later editing/render stories consume reference specs/reels and metric contracts.
This story does not implement production ASR/VAD, a timeline, rendering services or an AI editing agent.
