# Your Editor evaluation dataset

## Purpose and release status

`evaluation-dataset-v1` establishes the licensed source inventory and stable gold/metric contracts
for US-110 and later perception/editing evaluation. It is an **unreleased candidate baseline**, not a
completed human-gold benchmark. The Owner confirmed that no existing reviewed assets are available.
No human annotation, editorial decision, consent or approval is claimed in this release.

There are 12 distinct downloaded source representations, two in each category: podcast, educational,
talking head, interview, gaming and technical tutorial. Six first-30-second excerpts are rendered
viewing candidates, all `awaiting_human_review`. Three silence templates and three word-alignment
templates are empty and awaiting hand labelling; neither templates nor candidates satisfy T2.
Validation reports structural validity separately from the unchanged six/three/three gold quotas.

## Scope and languages

Six sources are English, three Arabic and three `zxx` (no linguistic content). The word/silence
review subset includes two English sources and one Arabic interview. Language metadata follows the
published source descriptions/context; speech quality and full language coverage still need Owner
review. Arabic Unicode is preserved in source titles and future gold words.

Gaming comprises two distinct official 0 A.D. gameplay/release videos, not commentator gameplay.
Educational material comprises a microscopy recording and a web-science explanatory talk.
Technical tutorials concern Wikidata. Podcast recordings are the NPS Spring Podcast and Wikimania's
Village Pump closing podcast. This is category coverage, not representative sampling of every genre.

## Collection and licensing

Sources were acquired from Wikimedia Commons on 2026-10-08. Every source has a canonical file page,
pinned page revision, credited creator, license URL, rights assertion, attribution, allowed-use
rationale, download representation URL, actual byte SHA-256 and probed integer-microsecond duration
in [manifest.json](manifest.json). Full webpages are not copied into git. Licensed public source
pages remain the independent evidence; Commons is a distribution source, not a blanket license.

Acquired representations are Wikimedia's 480p VP9 transcodes where available, otherwise the original;
there is exactly one acquired representation per source. Transcode hashes identify these actual
bytes, not the upstream original. No source is counted twice under a different category or ID.
No arbitrary YouTube downloads, scraped social media or private-consent sources were used.

Licenses are CC0, CC BY 3.0, CC BY-SA 3.0/4.0 and public domain. The two Arabic interviews have
published Commons license-review evidence. The NPS video was independently verified against its
official Flickr public-domain mark and NPS government-work policy, including exceptions. 0 A.D.'s
art/sound ShareAlike licensing was independently checked against the developer's project overview.
No unknown, NonCommercial or NoDerivatives license enters the inventory.

ShareAlike adaptations must retain the applicable compatible license; ship each source's attribution
and indicate excerpt/transcode/edit changes whenever distributing a reference. Dataset metadata does
not replace individual media licenses. Do not imply Wikimedia, NPS or Wildfire Games endorsement.
Public-domain material may still contain protected marks or publicity rights; permission to copy is
not permission to misrepresent speakers or use their identities in advertising.

## Reference and annotation process

A machine selected the initial first 30 seconds solely to make review possible. These selections
are **not human-edited**. The Owner must watch the source and candidate, choose meaningful retained
segments, record their editorial decision notes, render that specification, then approve or reject
the exact reel hash. Recording `createdBy=human` requires actual human decisions, not relabelling
an untouched machine suggestion. Approval evidence records the Owner identifier, role, UTC time,
decision, notes, explicit human attestation, content fingerprint and reviewed reel hash.

Gold word/silence artifacts require listening and hand timing by a human. Empty templates, model
predictions and unapproved artifacts never count. Silence uses sorted, nonoverlapping half-open
intervals; words use ordered, nonoverlapping spans. The v1 word contract is intended for a single
sequential speech stream; overlapping dialogue needs a documented future schema extension rather
than silently discarding speakers. Preserve case, punctuation and Arabic text in raw gold; scorer
normalization lives separately in the metric registry. No machine transcript or silence detector is
implemented here.

Reference, annotation and receipt schemas are language-neutral JSON Schema 2020-12 definitions.
Decimal strings encode all microseconds, with BigInt checks for bounds, ordering and source identity.
The deterministic rendering recipe produces 640×360 H.264/AAC viewing reels (silent sources remain
silent); FFmpeg version/build and source/edit/output hashes accompany each render. Byte identity is
reproducible within the recorded toolchain, not promised across different codec builds.

## Storage and reproducibility

Large source/reel files stay outside git and Git LFS. The logical bucket is
`your-editor-evaluation`, prefix `evaluation/evaluation-dataset-v1/`. Source, reference and annotation
keys include version, stable ID and content SHA-256. Signed URLs and credentials are never manifest
fields. Small edit/annotation/receipt JSON is reviewable in git and mirrored to the bucket.

Implementation evidence uses a private, versioning-enabled SeaweedFS bucket on workspace loopback,
backed by the Docker named volume `us110-evaluation-data`. It survives container restarts/removal but
is **not a remotely hosted or team-accessible archive** and will not survive destruction of this
workspace/volume. Owner-selected durable team storage and migration are still required. No endpoint
or credentials are assumed by offline CI. Acquisition, sync and deep verification are documented in
[README.md](README.md); sync requires matching configuration and existing enabled bucket versioning.

## Quality control, limitations and bias

Offline validation checks strict schemas, provenance completeness, unique content identities,
category coverage, exact metadata hashes, source/artifact relationships, temporal bounds, review
fingerprints, render receipts and all eight metrics. Deep validation reads actual private object
bytes and checks hashes, sizes and non-null version IDs. A second sync reuses exact matching bytes;
conflicting content fails closed. Licensing cannot be proven by a schema alone: published rights
assertions and source-specific checks above are the evidence.

The two talking-head sources feature the same speaker in distinct language recordings; group repeated
speakers when designing future train/evaluation splits. The dataset is small and strongly biased toward Wikimedia/OpenKnowledge topics, formal speech and
open-source gaming. It does not represent English accents broadly, Arabic dialects broadly, noisy
consumer footage, fast conversational podcasts or modern proprietary gaming. Three sources have no
speech; those cannot measure WER. Short viewing candidates are not representative edits. No metrics
have been measured and no human quality claim is made. Content-retention required spans, blinded
acceptance ratings and correction/time observations remain future human evaluation inputs.

## Privacy, intended and prohibited use

Use for internal feature evaluation, regression fixtures and properly attributed evaluation reports.
Use pseudonymous reviewer IDs and keep private consent documents outside git if private sources are
added later. No consent identity was invented and no private personal information was collected.
Publicly licensed faces/voices remain personal data; retain only what evaluation requires and avoid
face identification, surveillance, voice cloning, misleading impersonation or advertising reuse.
Do not train production models on this collection without a separate purpose/license/privacy review.

## Updates and release policy

Before approving changes to this already-uploaded candidate snapshot, fork a new dataset version;
never replace a historical release's meaning. The version tool archives the current metadata,
changes prefix/version, clears approvals and updates dependent fingerprints. Bucket objects are
immutable, content-addressed and versioned. Rerender changed human edits, review exact hashes,
validate strictly, sync, deep-verify, and publish a version/tag only when genuine quotas pass.
Historical source/reel objects are never deleted by these tools. Retain the archived manifest and git
commit alongside reports so prior measurements remain interpretable.
