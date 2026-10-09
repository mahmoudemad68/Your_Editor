# Timeline domain contract (US-214)

The canonical `Project` aggregate still owns membership, audit and soft deletion. `Timeline`
refers to its Project ID. `serializeProject`/`deserializeProject` compose both values into
`project.json` v1; they do not create a second Project model or change repository ports.
The schema is `packages/schemas/src/project.schema.json`. The domain uses no schema library:
shape checks and domain construction independently reject invalid loaded state. Boundary
consumers must use both JSON Schema and domain construction, since schema alone cannot
prove cross-reference, temporal or ordered transition-join uniqueness invariants. Offline integration tests check agreement.

All media times are nonnegative bigint microseconds in memory and canonical decimal strings
in JSON (ADR-008). JSON numbers, fractional/nonfinite/unsafe numbers and noncanonical strings
are rejected. Bigint values above Number.MAX_SAFE_INTEGER remain exact. Durations of clips and
sources are positive. An empty composition may have zero duration; every placed item must end
inside its explicit composition duration. Source catalog entries are immutable references to
canonical MediaAsset IDs, kind and verified duration, not another MediaAsset aggregate.

Media clips play 1:1: duration = outPoint - inPoint and timeline end = placement + duration.
Their source ranges cannot exceed the catalog duration. Captions and graphics use intrinsic
ranges from zero; Caption preserves Unicode text and ComponentInstance references a canonical
Component ID. Component pack resolution and rendering belong to later stories. Track kinds
are video, overlay, graphics, caption and audio. AudioClip may reference audio from video or an
audio asset; visual clips may reference video/image sources with an explicit duration.

The SRS FR-017 and roadmap do not specify detailed same-track overlap exceptions. This MVP
uses the smallest safe rule: every track has exclusive half-open clip ranges [start,end).
Touching clips are legal. Overlap across separate tracks is legal for compositing/mixing.
Overlapping layers/captions/audio on one track require a later explicit policy, rather than
silently acquiring product semantics here. Tracks retain semantic layer order; clips sort by
placement then canonical ID, and source catalogs sort by ID. All graph entity IDs (timeline,
tracks, clips, effects, transitions) are unique within a Timeline; external asset/component IDs
are references in separate namespaces. Multiple references to one source are legal.

Effects currently carry bounded opacity/gain values without rendering code. A cut transition
has zero duration; a dissolve has a positive bounded duration and links adjacent touching
visual clips. Each ordered (fromClipId, toClipId) join has at most one transition, regardless
of transition ID or kind. This semantic invariant lives in Track construction and is enforced
by restore/project parsing; JSON Schema validates the transition structure. It describes the join without allowing overlapping source placements. Commands
must preserve a valid join or reject atomically. Actual transition rendering is outside scope.

Composition dimensions are bounded positive integers; FPS is a positive rational at most 60
(SRS section 6). Frame conversion derives every position from its absolute integer frame index.
`snapToFrame` chooses the nearest rational frame, with exact half ties toward the later frame,
then rounds that frame's absolute microseconds half up. There is no accumulated floating-point
frame duration. Snapping is explicit; loading or editing does not silently alter source time.

Values, nested entities and collection arrays are frozen. Deserialization accepts only explicit
plain-data fields, known variants and lowercase UUIDv7 IDs (uppercase/mixed case reject,
without normalization); prototype-shaped extra properties reject.
All text validated by the editing text boundary must be well-formed Unicode: lone UTF-16
surrogates reject without replacement; Arabic, emoji and valid surrogate pairs are preserved.
JSON Schema covers meaningful text shape; the domain parser enforces UTF-16 well-formedness.
Identity entropy/time is supplied by existing UUIDv7 adapters, never a domain random singleton.
The pinned fast-check dev dependency is used only by tests for deterministic seeded generation.
It adds no runtime domain dependency.
