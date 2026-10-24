# Safe MediaAnalysis failure reasons — Issue #62

MediaAnalysis 1.0.0/1.1.0 and their five failure codes/reasons are unchanged.
Specific operational classification lives in `analysis_tasks.failure_category`
(migration 0020). The authenticated companion GET
`/projects/:projectId/media/:mediaId/analysis/failures` returns only current-generation
terminal analyzer categories and fixed explanations. Existing readers need not call
it. No account identity, job ID, storage key, transcript, exception message or stack
is included. Legacy rows without specific evidence receive a generic explanation.

| Specific category       | Legacy code   | Meaning and retry policy                                                                                                                                      |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| authorization_revoked   | unavailable   | Current editor authority no longer permits completion; no automatic retry. An authorized editor may explicitly rerun.                                         |
| authorization_failed    | unavailable   | Publication database authorization failed; no automatic retry or account disclosure. Contact support.                                                         |
| publication_fenced      | unavailable   | A receipt is no longer current/admitted; no automatic retry. Cancellation/deadline/generation fencing remains authoritative.                                  |
| untrustworthy_alignment | unsupported   | Recognized words lack defensible complete timing with the selected model; fail closed, no automatic retry or silent model substitution.                       |
| analyzer_unavailable    | unavailable   | Known transport/service failure. Retryable only when the underlying classified failure is transient; bounded attempt and absolute deadline rules still apply. |
| cancelled               | unavailable   | Cancellation is distinct from input failure/timeout; no automatic retry. Job status remains Cancelled.                                                        |
| timeout                 | timeout       | Inference/staging/absolute deadline expired; no additional attempt after exhaustion.                                                                          |
| invalid_input           | invalid_input | Explicit envelope, source-identity or input-bound violation. Arbitrary ValueError is not proof of invalid user input.                                         |
| internal                | internal      | Unknown failure; generic bounded explanation, no raw exception output and no inferred retryability.                                                           |

The database retains the existing deferrable receipt trigger, runtime-identity,
source, generation, attempt, deadline, cancellation and membership checks. It adds
only a stable `EA001` SQLSTATE for revoked authorization instead of classifying a
generic check violation by its text. No permission predicate was removed. The
worker projects categories to the frozen legacy failure object and emits only
allowlisted explanations into the durable job/audit path. Successful sibling
sections survive partial failures and analyzer-specific retries.

The companion read follows the same private media authorization as the document,
then rechecks membership after retrieving details. Unknown/private/revoked resources
remain opaque 404 (unauthenticated callers 401). Analysis reads of inconsistent
membership snapshots also return opaque 404 rather than exposing domain errors
through a distinguishable 400. This does not change the project-wide DomainError
400 contract for unrelated commands. The BFF forwards credentials to a fixed API
path, uses private/no-store and reconstructs explanations from the shared allowlist.
The UI clears fetched content if companion authorization is revoked during refresh.
If an optional companion detail cannot be obtained for operational reasons, the
validated legacy failure remains the fallback; unknown codes never expose upstream text.

Focused tests cover typed alignment rejection (including Tiny fallback exhaustion),
SQLSTATE versus raw-message classification, transient retry policy, cancellation,
timeout priority, unknown failures, schema compatibility, malformed companion data,
auth revocation during receipt commit and sidecar reads, persisted classifications,
safe job reasons and preservation of successful analysis sections. Native/service
tests use the existing Linux CI runner and real PG/Redis/BullMQ/S3/AI worker; portable
unit tests and WSL diagnostics are identified separately in the handoff.
