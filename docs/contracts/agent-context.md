# Prompt registry and safe context substrate

Issue #83 implements US-302 and US-304 for future planner composition. It does
not enable US-301/305, call a provider, execute a tool, or alter AgentRun events.
Production still stops at Planning with `PLANNER_NOT_CONFIGURED`. No provider
key is needed. CP1 is NOT_VERIFIED, CP2 NOT_MET, Tiny Arabic NOT_QUALIFIED.

## Reviewed prompt assets

`prompts/<id>@<semantic-version>.prompt` contains LF text: `---`, a single compact
JSON front-matter line, `---`, and a bounded plain-text body. The metadata schema
is [prompt-metadata.schema.json](prompt-metadata.schema.json), version 1.0.0.
Compact JSON is required so duplicate keys and noncanonical numeric spellings
cannot be hidden by the JSON parser. Names, versions, fields and features are
strictly allowlisted. There is no YAML execution, include, expression, callback,
environment expansion, arbitrary path or runtime download.

Author changes by adding a new pinned version and reviewing purpose, variable
types/trust, wording and tests. Do not overwrite an existing released version.
An intentional behavior change requires a new version. Existing pins remain
explicit; there is no `latest` default. Body placeholders are exactly `{{name}}`;
single JSON braces are literal. Undeclared, unknown, mistyped or missing required
variables fail with bounded errors. Optional absent values are explicit; trusted
enum variables admit only reviewed strings. All creator/transcript text is data.

`PromptRegistry.load(id, version).render(variables)` returns immutable instructions,
separate untrusted variables and ID/version/template SHA-256/rendering provenance.
The template hash covers exact UTF-8 file bytes. Untrusted values never interpolate
into instructions: placeholders become fixed data references. `isolatedJson` quotes
data and escapes angle brackets, ampersands and bidi controls. Delimiters in data
cannot create a second system/developer field. This structural boundary is not a
claim that an LLM will resist all persuasion; ToolExecutor must still authorize
every future call. Registry templates are deployment-owned code, never user input.

The build validates and packages assets into agent-core's `dist/prompts`. Docker
builds copy the source assets. The production agent-image gate loads the deployed
registry offline/non-root/read-only and verifies absent bundles fail closed. A
targeted AST lint rejects long prompt-bearing literals in agent/API production
code; it excludes UI copy, test fixtures, generated clients and dependencies.

No current AgentRun has rendered a prompt. Future planner integration must record
the returned provenance with its actual decision receipt; it must not manufacture
an existing prompt-use event or actual provider usage.

## Context authority and compatibility

`buildAgentContext(source, registry, request)` is a narrow typed library interface,
not a new public route or tool. It returns a discriminated success or bounded
failure. Actor identity must come from the existing authenticated server boundary.
`PostgresAgentContextSource` checks current membership, run ownership and project,
locks membership/project/run/media rows for the read transaction, and uses the
run's durable original Timeline snapshot/hash. It never loads the mutable Timeline
for context or changes state. A changed expected version fails as `stale_source`.
Revocation/deletion serializes against protected reads. A later planner must again
check session, membership, current source and generation at every decision/effect;
a context is not a lasting access grant.

Only snapshot source assets in that project can be included. Persisted analysis
must match the asset hash, identity and duration. MediaAnalysis 1.0/1.1/1.2 parsers
remain unchanged. Every source document and exact original Timeline is hashed.
Missing/failed sections report unavailable with safe reason codes; only measured
speech, acoustic silence, scenes and face observations enter data. No synthetic
scores, annotations or multilingual labels are introduced. Acoustic silence never
authorizes automatic cuts, and is distinct from NON_SPEECH.

Tool pins and creativity restrictions are trusted composition policy. Names,
versions, parameter schemas, relational validation rules and fingerprints come
from the existing ToolRegistry; each candidate is checked through the existing
PostgresToolAuthority. The output is their intersection, not permissions extracted
from descriptions or creator text. This initial substrate binds timeline-resource
tools only. Empty or denied sets remain empty. There is no SDK execution or
EditCommand in context generation. Normal ToolExecutor checks remain mandatory.

## Budget, source coordinates and privacy

The deterministic estimator is UTF-8 bytes plus 256 framing units. It is a
conservative estimate for byte-based tokenization, not a provider tokenizer or
actual measured usage. Effective allowance is context window minus reserved response
and tool margins. Future model adapters must independently verify their tokenizer.
The final serialized envelope, instructions, tools, references and omission metadata
are included in this check. If mandatory headers cannot fit, the build fails.

Remaining allowance uses fixed priority shares: Timeline 20%, transcript 50%, speech
10%, silence 5%, scenes 10%, faces 5%. Selection is deterministic and prefix-oriented;
unused shares are not reassigned. Transcript excerpts retain original segment/word
indices, unchanged measured microsecond intervals and confidence, in groups of at
most 16 words. Excerpt grouping is context-only and never rewrites a transcript.
Oversize units are explicitly omitted, never cut through a lexical/time unit. Each
unit is bounded to 4096 encoded bytes. Creator fields are at most 4096 bytes each.
At most 16 source assets, 4096 clips, 32 tools, 8MiB per document, 600000 hash nodes
and a 262144-unit context window are accepted; invalid/oversize input fails closed.

Omission counts, first missing category index, original word indices, input hashes
and timecodes support future authorized retrieval. `executionAvailable=false`
explicitly identifies references; `get_transcript_range` is not implemented or
advertised as live. Timeline IDs, clip IDs, source in/out coordinates and rational
frame rate are preserved exactly; no conversion to floating-point seconds occurs.

Output is privileged bounded context, never an audit payload. Do not log it.
Only the returned allowlisted summary/provenance is suitable for later audit use.
Filenames, storage keys, arbitrary media metadata and raw errors are excluded.
Credential/URL-looking text is defensively redacted in data, with the immutable
original input hash retained. This cannot identify every arbitrary secret: secret
material must never be supplied to content fields. Existing artifact auditing and
security review still apply. Security-sensitive review is required for the template,
untrusted-data, permission-filtering and context/redaction boundaries before merge.

## Qualification

Portable tests cover pinned templates, missing variables, injection-like input,
hour-long bilingual data, deterministic hashes, strict budgets, whole-unit truncation,
historical analysis versions, invalid sources and safe errors. Constructed fixtures
are not independent speech ground truth or provider qualification.

The real PostgreSQL/API lifecycle suite additionally persists MediaAnalysis, reads
the original AgentRun snapshot, checks actual Tool SDK permissions and zero new
tool/audit effects, tests foreign/revoked identities and preserves existing lifecycle
recovery. The production image probe and exact-head CI/Walking Skeleton/Supply Chain
remain mandatory. The final handoff records actual executed results separately from
these executable test definitions. Independent QA is assigned separately.
