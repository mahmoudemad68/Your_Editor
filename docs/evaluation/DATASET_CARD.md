# Your Editor evaluation dataset

## Purpose and release status

`evaluation-dataset-v1` establishes the licensed source inventory and stable gold/metric contracts
for US-110 and later perception/editing evaluation. It is an **unreleased candidate baseline**, not a
completed human-gold benchmark. The Owner confirmed that no existing reviewed assets are available.
The Owner has now personally watched the six prepared sources and intentionally retained each
00:00–00:30 interval as a human editorial selection. No human annotation, consent or final
rendered-artifact approval is claimed in this release.

There are 12 distinct downloaded source representations, two in each category: podcast, educational,
talking head, interview, gaming and technical tutorial. Six first-30-second excerpts are rendered
Owner-selected references, all `awaiting_human_review`. Three silence templates and three word-alignment
templates are empty and awaiting hand labelling; neither templates nor candidates satisfy T2.
Validation reports structural validity, human-gold quotas and durable-storage completion separately. The six/three/three quotas are unchanged.

## Scope and languages

Six sources are English, three Arabic and three `zxx` (no linguistic content). The word/silence
review subset includes two English sources and one Arabic interview. Their annotation templates have explicit provisional 30–90s machine-candidate scopes (60 seconds each), awaiting Owner selection. Full source durations are distinct from gold clip duration; no whole-source labelling is required. Language metadata follows the
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

A machine selected the initial first 30 seconds solely to make review possible. The Owner has since
personally watched all six prepared sources and explicitly chosen to retain the same intervals.
The human edit specifications record that genuine editorial decision, and have been rerendered
without changing the recipe. They are not yet approved human-gold references: the Owner must watch
the exact newly rendered reels, then approve or reject their hashes. Recording `createdBy=human`
requires an actual human decision; retaining a suggestion qualifies only when the Owner intentionally
selects it after watching the source. Approval evidence records the Owner identifier, role, UTC time,
decision, notes, explicit human attestation, content fingerprint and reviewed reel hash.

Gold word/silence artifacts require listening and hand timing by a human. Empty templates, model
predictions and unapproved artifacts never count. Each annotation declares a bounded scope in SOURCE coordinates, with every label inside that window. The Owner must confirm/change the provisional scope before approval; scope and selection are included in the reviewed fingerprint. WER/sync use only approved word scope; silence F1 uses only approved silence scope. Prediction inclusion/intersection rules are explicit in METRICS.md. Silence uses sorted, nonoverlapping half-open
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
workspace/volume. Owner-selected durable team storage and migration are still required. `GOLD_STORAGE_DURABLE` is currently false. Human quota completion alone cannot make release `US110_GOLD_COMPLETE` true; exact sync/deep verification, enabled native versioning and a current receipt for an actually Owner-approved durable target are required before Independent QA. No endpoint
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

The uploaded v1 is still **unreleased**. First genuine human edits, scoped labels and reviews may
complete in v1 without a version fork. Uploading machine candidates does not freeze semantic meaning.
Lifecycle: candidates → human decisions/labels → approvals → strict validation → durable storage
sync/deep verification → Independent QA → merge/release. No human work, release or freeze has occurred.
Approved gold cannot be silently revised. Within unreleased v1, the Owner may preserve the prior
approval in git, explicitly invalidate current review, revise and rerender, then genuinely review
again without a version fork. Changed or reopened artifacts do not count until new approval; other
unapproved v1 artifacts can still receive their first gold. At release, manifest `release.status=published` and a frozen canonical
dataset fingerprint protect the approved snapshot. Published render/review and semantic mutation
fail closed. Only later changes to frozen meaning require a later dataset version. The version tool
archives metadata/evidence, changes prefix/version, clears reviews/verification and leaves the new
snapshot unreleased. Bucket objects are immutable, content-addressed and versioned. Historical
source/reel objects are never deleted. Retain archived manifest and git commit with evaluation reports.
