# PC100 independently issued admission check

The issuer is a dedicated GitHub App on an Owner-controlled **external Linux
host**, never a PR runner. `pc100-admission-app.mjs` polls the actual PR, reads the
protected-main registry and complete source inventory, authenticates the current
native preflight run, and publishes its own check on the exact product HEAD.
PR numbers, authors and fork status do not exempt source. An authenticated neutral
NOT_APPLICABLE is permitted only when the complete tracked path/mode/blob inventory
is identical to protected main, with an immutable source-inventory digest and
candidate/release authorization false. Every tracked file is conservatively in
scope; unfamiliar extensions, additions and renamed dependencies are not exemptions.
An otherwise ordinary changed-source PR remains blocked until its applicable
independent source authorization exists. This conservative behavior must not be
reported as qualified automatic classification of arbitrary unrelated source changes.
All open PRs are paginated and grouped by actual head SHA. A fork alias at the
canonical candidate SHA reuses the canonical source evaluation, not a fork policy
or a competing failure/neutral. Changed source never acquires approval from its
own hashes. Only PR100's reviewed registry path grants candidate qualification;
neutral/skipped checks cannot authorize a candidate. Draft and Ready are lifecycle
metadata, not policy approvals; exact source and security checks remain mandatory.
This is App/source-verifier lifecycle support. PR100's separate consumer still
has Draft-only admission gates; its future Ready integration is not qualified by
this PR103 change, and no PR is being transitioned to Ready here.
Candidate qualification is separate from release authorization. The registry is
still empty. Public App/installation IDs are Owner-reported in `candidate-app.json`;
identity, installation scope and permissions are NOT independently authenticated.
Both consumer feature flags are false and the independent source authority is null.
Publishing these files does not install or approve this gate.

## One-time Owner installation

1. In personal Settings → Developer settings → GitHub Apps, create a private App
   for this account. Disable webhooks (the controller polls). Give only repository
   Contents **read**, Pull requests **read**, Actions **read**, Checks **write** and
   the mandatory Metadata **read** are the runtime operations. GitHub's ruleset
   documentation additionally specifies installed App **Commit statuses: write**,
   a recently submitted check run and pre-existing required-check association
   before selecting an expected source. `checks:write` alone is NOT a verified UI
   recipe. The installation token is separately narrowed to the original runtime
   permissions: no statuses-write token is requested or accepted.
   Protection/bypass inspection is a separate capability: branch protection may
   require Administration read, and ruleset bypass actors are omitted without
   write access to the ruleset. The current narrow token cannot be assumed to see
   these fields. Do NOT silently expand it to administration-write, supply an
   Owner PAT or treat omitted actors as empty. If the App cannot independently
   read complete protection evidence, admission remains BLOCKED pending a specific
   Owner-reviewed least-privilege visibility decision. No broader scope is granted
   by this documentation or implementation.
2. Install it on **only** `mahmoudemad68/Your_Editor`. Record its actual App ID,
   installation ID and slug in `infra/seaweedfs/candidate-app.json` through normal
   independent source review. These public IDs are not credentials. Neither a PAT
   nor GitHub's shared Actions App is an acceptable issuer.
3. Generate the private key through the App settings. Store it outside every
   repository on the separate host, owned by the controller account, mode `0600`,
   no links. Never place it in Actions secrets, PR runners, artifacts, logs, chat,
   source, `GITHUB_TOKEN`, or an environment variable. Do not run a PR checkout
   with that key. No private key has been provisioned by the Coding Agent.
4. The controller/verifier/config/registry must be independently reviewed and
   installed on protected main through the ordinary reviewed process. The agent
   is not authorized to merge/install them. Start the controller from a clean
   checkout of that exact protected-main commit, with no GitHub runner/credential
   environment. The controller authenticates its own source before reading a key:

   ```sh
   # Future Owner-only commands, after separate first-issuance authorization.
   env -i HOME="$HOME" PATH="$PATH" node tools/test/pc100-admission-app.mjs --once /secure/external/issuer.pem /secure/external/reader.pem
   env -i HOME="$HOME" PATH="$PATH" node tools/test/pc100-admission-app.mjs --watch /secure/external/issuer.pem /secure/external/reader.pem
   ```

   A missing candidate policy produces a **failure**, never bootstrap success.
   Once the genuine App has issued its first check, its source can be selected in
   the GitHub UI. If the source is not selectable, leave admission blocked.

5. **Install and independently review the candidate registry BEFORE enabling any
   globally required context.** Verify independently authorized ordinary, registry and Dependabot source-change
   success checks and source identity first. Neutral is only for a complete source
   tree identical to main. Do not enable a global check while the independent
   source-authority contract is unapproved: changed-source PRs will fail closed. Repository Settings → Rules → Rulesets → existing active `main` ruleset:
   preserve all current rules and required checks; add
   **`PC100 independent security admission`**, explicitly selecting this dedicated
   App as expected source. Enable strict up-to-date checks. **Any source** and
   **GitHub Actions** are invalid. The consumer checks the effective public rules
   API for this exact context/integration ID and strict policy; absence or
   unsupported/inaccessible enforcement fails closed.
6. Record the Owner-reviewed before/after protection JSON and rollback plan.
   Removal/rollback of the added App context is an Owner-controlled settings action,
   preserving existing required checks, reviews and admin enforcement. No controller
   code changes settings or removes a required context on failure. Withhold merges
   if the issuer/visibility is unavailable; do not install a global context first
   and hope to merge its own registry afterward.

The external service must remain supervised. Every cycle revalidates main and
source; a base change requires an updated clean checkout/restart. Consumers also
verify exact H/B/M/trees, upstream run/attempt, check suite/issuer, record digest,
and a ten-minute evidence age. A HEAD race during publication invalidates the
check. Duplicate checks, failed/missing policies and changed source never yield
success. This is not a transactional GitHub merge/release authorization; keep the
release hold and independent QA requirements. No deployment, installation,
required-check configuration, live App issuance or production admission has been
performed by this implementation.

## Verification

`node --test tests/architecture/pc100-admission-app.test.mjs
tests/architecture/pc100-candidate-policy.test.mjs` exercises real RS256 signing
with ephemeral test keys, source-policy evaluation, issuer/scope rejection and
head-race invalidation against hermetic API fixtures. It does **not** establish
live App installation or branch protection. Live acceptance must additionally
prove that removing/replacing a PR workflow cannot remove this check, and a check
from another App cannot satisfy the required source.

## Stale checks and hard limits

Every poll revalidates source/policy. Stable valid checks are left untouched until
the five-minute evidence refresh; no failure-to-success flip is emitted each poll.
Failures revoke the previous positive, and a post-publication race is rechecked.
Merged PRs end their lifecycle without creating failure checks. Closed unmerged
or changed-head contexts are reconciled; shared-head aliases evaluate once.

Before publishing a verdict, the Linux controller persists its context in a bounded
owner-private journal beside the external key (`pc100-<app-id>-<installation-id>.checks.json`). Its parent
must be owned by the controller, mode 0700; the journal is a regular single-link
0600 file. Writes use an exclusive lock, unique temporary file, fsync and atomic
rename. Busy/corrupt/unwritable journals prevent publication. Startup reconciles
previously observed heads before new decisions, including after loss of in-memory
tracking. SIGTERM/SIGINT attempt explicit revocation before stopping. A stale lock
or unavailable API fails closed; it is not proof that remote revocation happened.
The journal is tracking, never source approval or a substitute for App identity.
Historical checks issued before this version without journal entries are not
magically recovered and require independent audit before activating the issuer.

Consumers independently reject changed main/policy/H/B/M/trees and expired proof.
GitHub required checks have NO application-defined ten-minute native expiry.
The consumer's ten-minute TTL does not expire GitHub's merge gate. There is a
non-atomic window between API reads/writes, main/policy changes and merging, and
an offline issuer may leave a stale positive on the same H. Strict up-to-date
checks help but are not a transaction or a universal TTL. Keep the release hold,
Owner merge authorization and independent QA; withhold merges on outage/drift
until the genuine App has explicitly failed/revalidated the check. Live enforcement
and UI source selection remain NOT_VERIFIED until independently exercised.

## Native PR diagnostic workflow

`pc100-required-admission.yml` is named **PC100 admission diagnostics**. It is
PR-controlled and is never the independent authority. A native pull_request uses
the actual merge ref M for `GITHUB_SHA` and `GITHUB_WORKFLOW_SHA`. The synchronize
event payload `pull_request.merge_commit_sha` can still carry the previous M; it
is logged as an annotation only. Read-only fetching the actual immutable workflow
commit proves parents [B,H] and TREE(M)=TREE(H), without checking out/executing PR
source. Protected-main candidate verification independently checks current live M.
Checkout of trusted B
does not change those variables. The diagnostic validates this real environment,
logs only H/B/M/workflow/checkout SHAs, then invokes protected-main code only for
PR100. The actual required source is the external App, never this Actions check.

## Historical protected-main bootstrap deadlock

The inherited-CI prerequisite described in this section is now resolved by the
official PR105 merge `edad78d3431c976c0e8e79f5d58527c948fb53eb`. Preserve this
history; use the post-Route-A section below for current integration and gates.

Run the read-only, fail-closed executable diagnostic (no key or settings write):

```sh
node tools/test/pc100-bootstrap-preflight.mjs
```

It uses an existing read-capable GH_TOKEN/GITHUB_TOKEN, inspects live protected
main, admin enforcement, full effective rulesets and the actual test-merge checks
for PR103 and PR100. Missing API visibility returns nonzero. Red required checks
return `BLOCKED_REQUIRED_CHECKS`, not an approval. Never log the token.

At the inspected main `5cdb1d794d347a36d869027947bb62504dddff92`, classic protection
requires strict `ci`, one review and enforce_admins=true. Active repository ruleset
24207418 additionally requires `supply-chain-security` and has bypass_actors=[].
PR103 inherits the unqualified Ubuntu26 speed-edit/render failures and SeaweedFS
Brotli scanner failure. PR100 requires the uninstalled protected-main trust source.
No permitted code change in this bootstrap scope can make that circular dependency
an authorized merge. No protection setting has been changed.

The protection-preserving resolution is a separately Owner-authorized isolated
prerequisite remediation, carrying only the host/render/security repairs needed
by main, with real existing `ci` and `supply-chain-security` SUCCESS and independent
review before ordinary merge. The accepted PR100 repairs are evidence, not permission
to create/merge that prerequisite here. Exact follow-through commands after that
separate assignment: `gh pr checks <prerequisite-number> --required --watch`, then
re-run this preflight against the new live base and qualify the updated bootstrap.
Do not create that PR, alter settings, merge or use admin bypass under this task.
The alternative time-bounded settings route requires a separate explicit Owner
choice with before/after capture and immediate restoration; it is not authorized.

Sources: [GitHub required checks and expected App source](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[neutral/skipped semantics](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
[bypass-actor visibility](https://docs.github.com/en/rest/repos/rules).

## N1–N6 repair qualification boundary

The content, alias, Ready, polling and restart regressions are automated software
checks. N2 live protection visibility remains BLOCKED: the shipped emitter token
is still exactly contents/pull_requests/actions read and checks write (metadata
read). It cannot be described as an Administration-read token. GitHub's branch
protection GET requires Administration read, while full ruleset bypass visibility
is separately restricted to write access to the ruleset. No Administration-write,
PAT, omitted-bypass fallback, App permission change or live installation is added.
The Owner must authorize a narrow independent read-only visibility boundary and
its real authenticated responses must pass the existing complete rule/bypass
checks before LIVE_A6_ENFORCED can be YES. If GitHub cannot expose those fields
through that boundary, keep admission blocked; this code does not solve it by
weakening checks. No native ten-minute merge TTL is claimed: issuer outage still
leaves a residual non-atomic merge window requiring explicit Owner disposition.

Route A is separately Owner-authorized on PR105 (now Ready for human review). Its native checks and QA
are separate evidence, not an authorization to merge it, change protection or
install this App. PR103's inherited main checks remain independently required.

## N2 separate read-only protection reader (code only; not installed)

`candidate-app.json` now has an optional `protection_reader`, shipped **null**.
The external controller can use a second, separately Owner-authorized private App
whose **entire App and installation permissions** are exactly Administration read
and Metadata read, installed on this repository only. The check-writing App keeps
its existing token scopes. A narrowed token from a broader reader App is rejected.
No App, installation, permission, host or key has been created by this change.

The reader descriptor is a closed `pc100-protection-reader-v1` object containing
`repository_id`, distinct `app_id`, distinct `installation_id`, and `slug`. It is
read from the independently reviewed protected-main configuration, not a PR.
The constructor authenticates `/app`, the exact selected/suspended installation,
the exact token scopes and lifetime, and the token's single repository. Its
capability permits only GET of main, main protection, effective main rules and
exact ruleset IDs; responses are capped at 2 MiB with 15-second timeouts and no
redirects. It cannot write a check or settings. The writer routes those reads
only through the authenticated reader capability, including source revalidation;
a missing/forged/mismatched reader cannot fall back to writer credentials.

After independent installation of the reviewed code/config on protected main,
an Owner-controlled external Linux host can perform a **visibility-only** probe:

```sh
node tools/test/pc100-admission-app.mjs --probe-protection /secure/external/reader.pem
# Only after complete independently observed visibility and issuer configuration:
node tools/test/pc100-admission-app.mjs --once /secure/external/issuer.pem /secure/external/reader.pem
```

Both files must satisfy the existing Linux ownership, 0600, non-link,
outside-checkout guards. The CLI rejects identical paths/keys. Neither private
key nor installation token belongs in Actions, source, artifacts or logs.
The probe compares protected main before/after all reads, emits bounded public
identity/count fields only, and explicitly returns candidate/release/live-A6
authorization **false**. HTTP 401/403/404, hidden bypass actors, incomplete pages,
unexpected permissions, nonempty bypass lists and base drift all fail closed.

**Unresolved real API capability:** [branch protection GET](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)
requires Administration read; [ruleset GET](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)
documents that `bypass_actors` is returned only with write access to the ruleset.
Therefore an Administration-read App is **not proven** to expose complete bypass
actors. Missing actors never mean an empty list. Owner authorization of the separate
read-only App and an actual successful authenticated probe are required; if GitHub
hides the field, N2 remains blocked on an independently authorized trustworthy
read-only visibility source. No automatic Administration-write or Owner-PAT
workaround is implemented or requested by the software.

**Consumer integration boundary:** the Actions-side candidate-policy evaluator
also currently reads private protection metadata. Its contents/actions-read
`GITHUB_TOKEN` does not acquire the external reader's authority from this patch.
No reader key/token will be passed into Actions. A future independently reviewed
consumer integration must authenticate the real external App's exact-source,
current-base enforcement evidence without re-issuing it as a PR-controlled claim.
Until then, full candidate admission remains blocked even if the external probe
succeeds. These tests establish software separation, not live A6 or deployment
authorization. `LIVE_A6_ENFORCED=NO`, registry unapproved, release hold active.

## Historical PR105 release-hold observation and proposed integration

This is the pre-merge observation. It is superseded by the merged case-exact Node
preflight, not by the case-insensitive variable comparisons proposed below.
Do not copy those historical expressions as a secure release guard.

Read-only inspection on 2026-11-05 found PR105 at
`4d2b73bc48fada4fe44b96e8efb91703b1afd846`, base
`5cdb1d794d347a36d869027947bb62504dddff92`. Required CI and Supply Chain and
Walking E2E are successful; Molomo9's human review remains requested. Classic
protection requires one approval/admin enforcement/strict ci; ruleset 24207418
adds strict supply-chain-security, stale-review dismissal, resolved threads and
no bypass actors. QA is PASS_WITH_FINDINGS, not release approval. Historical
scan evidence has zero CRITICAL but **380 HIGH package occurrences** across the
image set; SeaweedFS retains a HIGH go-jose finding. This is not zero HIGH/CRITICAL.

The PR105 Supply Chain main-push path publishes ten scanned images to GHCR with
both immutable `sha-<fullsha>` and mutable `main` tags, then generates release
manifest/bundle artifacts. This is not a GitHub Release API creation. Publication
has packages-write and depends on Supply Chain, not separately on CI/Walking.
There is **no RELEASE_HOLD guard**. Staging separately requires its enable flag,
the staging environment, reviewer/prevent-self-review checks, serialized deploys
and pinned SSH host verification. Repository API inspection found **zero
environments and zero Actions variables**; staging is currently disabled, but
GHCR publication/release artifacts are not.

Minimal proposal only (not applied): require both `vars.RELEASE_HOLD == 'false'`
and `vars.RELEASE_PUBLICATION_ENABLED == 'true'` on the scanned release-image
save/upload steps and publish/release/staging jobs. Unset/malformed values must
disable publication, while all scans and required checks continue. Staging must
also retain its separate flag/protected environment and independently verified
reviewer, prevent-self-review and admin-bypass settings. Changing variables alone
cannot fix a workflow with no gate. Separate Owner authorization and exact-head
regression/review are required before editing that workflow/settings. No merge
should occur while the release hold and this unconditional publication conflict.

Read-only three-way merge inspection from the common base found:

| Pair                                | Overlapping paths | Text conflict regions |
| ----------------------------------- | ----------------: | --------------------: |
| PR105 / PR103 at cce1f3c            |                 0 |                     0 |
| PR105 / PR100 at fe270e1            |                11 |                    17 |
| PR103 at cce1f3c / PR100 at fe270e1 |                17 |                    48 |

These are dry-run observations, not an executed merge or a guarantee for later
heads. PR105/PR100 overlap spans ci/e2e/supply workflows, FFmpeg worker/download
controls, SeaweedFS Dockerfile/object-storage/S3 tests, Walking runner and Issue99
operations documentation. PR103/PR100 overlap includes all verifier/admission
workflows and scripts, App/policy configuration, fixtures/tests and App operations
documentation. Preserve Route A's Ubuntu24/FFmpeg/native-Brotli fixes alongside
the separately qualified Go rebuild; never take an entire conflicting side
blindly. Do not duplicate or discard authenticated admission, six ASR shards,
security checks, storage defenses or the original MinIO journey.

Executable sequence **after separate authorized official PR105 merge**, never now:

1. Check `gh pr view 105 --json mergedAt,mergeCommit`; require a non-null merge
   commit, then `git fetch origin main` and
   `git merge-base --is-ancestor <105-merge> origin/main`. Record the new base/tree
   and genuine main checks. Abort on unexpected release activity or source drift.
2. In a clean, preserved PR103 checkout of its independently reviewed latest H,
   `git merge --no-edit origin/main` (ordinary history-preserving synchronization,
   not a force/rebase). Run all five verifier suites on Node22/24 and genuine
   Ubuntu/Windows Actions, lint/format, protection preflight, adversarial checks
   and all required CI/Supply/Walking on the resulting exact HEAD. Stop on a
   conflict/new API limitation; no security-settings bypass.
3. Independently review PR103 and its required source/Owner-only installation
   gates. Only after separate authorization and official merge, synchronize
   PR100 with new main by ordinary merge. Resolve the enumerated overlaps by
   inspecting each contract, including reader compatibility and receipt/evidence
   IDs. Any new base invalidates earlier H/B/M/tree policy/producer/receipt proofs.
4. Recompute complete source inventory (blob/mode/SHA-256), review the unapproved
   candidate registry independently, and prove actual expected-App enforcement.
   Then run exact-head complete producer before consumer admission, bounded REST
   and same-run artifact transfer/wire accounting, six ASR shards, real SeaweedFS
   JWT/S3/firewall/backup/restore and Small-ASR/captions/edit/undo/restart/export,
   plus the original MinIO browser journey. Independent QA and eventual Owner
   Ready/Merge decisions remain separate. No production-volume migration.

## Post-Route-A integration (2026-11-05)

The official main merge is `edad78d3431c976c0e8e79f5d58527c948fb53eb`, with
PR105 product head `e2b37a5a142a93e41ccab223201675347e534ba2`. Main was fetched
with an explicit remote-tracking refspec because this checkout's narrow fetch
configuration did not refresh `origin/main` with a plain named fetch. No remote
or local main branch was changed. No commits intervene after the official merge
at this checkpoint.

The authorized ordinary PR103 integration starts from
`c1aa0c5b08460e987419a7ca29ab6b22c1b65908`, retaining both histories. The staged
merge has **zero conflicted paths**; all 13 imported Route A paths are byte-for-byte
identical to official main. They include Ubuntu24 CI/Walking/Supply, the pinned
FFmpeg source and bounded authenticated HTTPS retry/fallback controls, native
Brotli1.2.1-r0, disposable recovery ownership checks, the case-exact release
preflight and its regression tests. Supply workflow blob remains exactly
`2aac344887c0b2a8e7e74acf19acf518ec24ed83`. No manual conflict resolution or
security-policy substitution was necessary. The final handoff records the actual
merge commit, tree, source inventory and new native checks; earlier PR103 checks
cannot qualify the new merged source.

The read-only bootstrap diagnostic no longer always requests authorization for
another prerequisite PR. It identifies stale-base evidence even when that old
base had green checks, rechecks main after inspection, and reports the currently
blocked checks or remaining independent-review/installation gates. Every result
still explicitly denies settings mutation, candidate admission, release and live
A6 enforcement. This diagnostic observes the identity of its actual read caller;
an Owner Git token with broader visibility is **not** proof of the separate App's
permissions. No new trust authority or credential is created.

GitHub currently reports PR100 as conflicted with a null test-merge SHA. The
diagnostic records that unavailable identity as blocked/missing checks; it never
queries `commits/null` or substitutes an old positive HEAD result. That dependency
does not prevent inspection of PR103's own checks, and it does not authorize
touching PR100.

### N2/A6 hard boundary after integration

`candidate-app.json` still has null issuer/installation/reader identities, and
the candidate registry remains empty. The actual read-only reader App/host/key is
not provisioned or independently authorized. PR103 controller and policy code
are not yet installed on protected main. Consequently there is no genuine
independently issued expected-App check or live reader visibility proof.

The existing consumer path is precise: `observeCandidateAdmission()` calls
`snapshot()`, which authenticates protected-main control files and calls
`verifyEnforcement()`. That function requires complete private branch-protection
and effective ruleset bypass evidence before registry/evidence acceptance. The
workflow's contents/actions-read token cannot substitute for the external reader.
Missing/omitted actors remain a rejection. No App token/key or Owner PAT is passed
to Actions, and no mocked App response is described as live qualification.

Secure delegation would need an independently reviewed protection-attestation
contract issued by the real authorized App: bind repository, H/B/M/TH/TM,
protected-main verifier/policy/blob identities, expected App/check/suite/run and
attempt, complete rule/bypass snapshot digest, observation freshness and source
revocation. Consumers would have to authenticate that evidence using a protected
trust anchor without executing PR code or weakening stale/missing/ambiguous proof
rejection. Replacing the current direct private inspection with that delegated
authority is a **consumer trust-anchor/contract change**. Under this assignment,
that subtask stops here for separate Owner review; no such authority or schema
is silently enabled by this merge.

Separate Owner actions are required for (1) independently reviewed installation
of trusted controller/policy source on main through the normal process, (2) an
authorized App/installation/external host and key arrangement with demonstrably
complete read-only protection visibility, and (3) review of the attestation and
expected-source enforcement/consumer trust contract. Branch-protection GET needs
Administration read, while GitHub documents ruleset bypass actors only for an
identity with write access to the ruleset. If read-only access hides that field,
the intended capability is blocked; do not grant Administration-write or infer
an empty list. No App install, permission expansion, settings change, infrastructure
provision, source-policy approval or positive candidate receipt is performed.

`LIVE_A6_ENFORCED=NO`, `N2_LIVE_VISIBILITY=NOT_VERIFIED`,
`ACTIONS_CONSUMER_INTEGRATION=BLOCKED_OWNER_TRUST_CONTRACT`,
`CANDIDATE_REGISTRY=UNAPPROVED`, `PR103_SAFE_TO_MERGE=NO`.

### Preserved release risks and PR100 forecast

Keep the merged guard unchanged and no-publication mode active. PR105 F7
authorization-snapshot revocation, F2 alternate publisher, F3 historical reruns,
F8 stale-review configuration, F9 mutation-test gaps and F10 transitive js-yaml
remain disclosed follow-up risks; integration is not permission to fix unrelated
release policy or claim those risks solved. Staging remains unqualified until
actual protected environment/enablement evidence exists. Fresh exact-head scans
determine HIGH counts; the historical401 is not a constant or a vulnerability
waiver. Existing critical-only scanner thresholds remain unchanged.

PR100 remains untouched at `fe270e1905ee709de64121d18dd2e04206286194`.
Its old source/base/policy/receipt proofs cannot qualify the new main. Only after
separate authorization and an official PR103 merge may that branch be synchronized.
Forecast conflicts include CI/Supply/Walking, FFmpeg, SeaweedFS image/storage
helpers and the verifier/admission contracts. Preserve Route A outcomes and the
independently reviewed candidate constraints when those conflicts are eventually
resolved, then recompute complete inventories and rerun real candidate/MinIO/S3,
crypto, recovery, browser-export, six-ASR and physical-wire qualification. Do not
merge or modify that branch during this assignment. Production migration and
release remain forbidden.

## A6 source-only bootstrap implementation (2026-11-06)

This isolated bootstrap is based on protected main and imports only the 17 closed
A6 dependencies from PR103 `f0566b91eb09ce9eb2404fb465de50fb6327d590`, plus the
attestation module/test, disabled trust configuration and future service template.
It does not import PR103 CI, FFmpeg, credential-audit or sanitizer changes, any
PR100 candidate transport, an approved registry, keys or tokens. A/B source code
is included here with disabled defaults; there is no second prerequisite PR or
self-referential approval of this bootstrap. Current native ci and supply-chain
checks and independent human reviews govern this PR. Merging/activation is NOT
an action authorized to the Coding Agent.

### Independently authorized ordinary source changes

`AUTHORIZED_SOURCE_CHANGE` is distinct from `NOT_APPLICABLE`. The former emits
success with candidate/release authorization false; the latter can only be neutral
when every tracked path, mode and blob is identical to main. Neither exempts docs,
lockfiles, registry, descriptors, new files, PR numbers, authors or review labels.
PR100 candidate authorization is always a separate registry decision.

A detached Ed25519 source-review record binds repository ID, PR, H/B/M, TH/TB/TM (TH=TM and merge parents [B,H]), the
SHA-256 of the complete path/mode/blob inventory, exact protected-main policy
snapshot, a nonce and a maximum ten-minute expiry with 30-second clock skew. The
verifier recomputes the full inventory, verifies the independent signature,
rejects revoked/noncanonical/extra-field records and same-head PR aliases, then
revalidates after publication. Source inventories and trust objects are deeply
immutable. A PR's hashes alone, or a check from GitHub Actions, confer no authority.

**Exact remaining Owner trust-contract decision:** independently select and
approve the source-review signing authority and custody, its public Ed25519
key/key ID, the bounded review/signing procedure and revocation responsibilities.
The signing authority must not be the Coding/QA agent, the PR author or Actions.
Even with consumer attestations disabled, the host revalidates complete private
read-only N2 visibility and inherited protections before and after an authorized
source-change check. A signature never substitutes for missing bypass visibility.
This pre-install source check does not require itself to be a required context;
candidate consumers still require the exact installed App source and strict policy.
The public root must be independently reviewed on main and deployed as part of
the exact reviewed controller source on the separate trusted host. No automatic
main update or controller pull is allowed. The current `source_authority: null`
keeps authority enabling BLOCKED; no public root is invented or approved here.
Synthetic test keys establish software behavior only.

After that future decision, the controller reads a public signed review record
`<H>-<B>-<M>-<PR>.source-review.json` in root-owned `/var/lib/pc100-reviews`,
separate from the private key/journal directory. The controller accepts only
bounded root-owned regular files in that read-only directory;
file contents are signed public source decisions, not App credentials. They
cannot approve PR100, release or deployment. Missing records or authority fail.
The independent source-review private key is NEVER loaded by the controller.

### Versioned Actions consumer path

`observeAuthenticatedCandidateAdmission` is the new Actions entry. It authenticates
App-issued check/suite evidence using immutable protected-main descriptors,
policies and full control-source path/mode/blob identities. It reads public
rules and contents/actions metadata, never private branch-protection or ruleset
endpoints with a GITHUB_TOKEN. It verifies H/B/M/TH/TB/TM, issuer and reader IDs,
check external ID/digest, run/attempt/workflow/PR associations, complete visible
empty-bypass attestation and digest, strict expected-App source, expiry and
revocation, and repeats checks after policy/source validation. It requires the
whole Supply Chain workflow SUCCESS before candidate-consumer admission; callers
cannot remove that requirement. A raw verified attestation grants no candidate or
release permission; the existing independent registry/source/lock/scanner policy
engine must additionally succeed. The registry remains empty here.

The external controller can emit the versioned check summary only if BOTH
`consumer_attestation` in the descriptor and `consumer_attestation_enabled` in
app-trust.json are enabled through independent review. Its authenticated private
reader supplies visibility; missing or nonempty bypass actors still reject.
The consumer never receives the external App key or installation token.
Its default transport accepts only the job's `GITHUB_TOKEN`; it never inherits
`PC100_METADATA_TOKEN` or `GH_TOKEN` and never falls back after a 403. Public check
metadata can be read without additional Checks permissions for this public repo
([GitHub check API permissions](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)).
Real App consumer qualification is still NOT_VERIFIED; hermetic HTTP tests are
not proof of live App, private-repository or protection visibility compatibility.

Legacy `observeCandidateAdmission` / `readCandidateAdmission` use private-reader
semantics and remain for external-controller/backward-compatibility tests; they
are not supported Actions paths. PR100 is deliberately untouched. Its future
consumer/receipt integration must migrate to the versioned entry and be tested
before either flag is enabled. No fallback from missing new evidence to legacy
private inspection or a PR assertion is permitted. These are concrete remaining
integration/activation gates, not an assertion of live consumer qualification.

### Future independent host and service lifecycle

`infra/seaweedfs/pc100-admission.service` is an UNINSTALLED template. It runs
Node24 under a dedicated pc100 user with `env -i`, empty capabilities, no-new-
privileges, read-only reviewed code and a 0077 umask. No PR checkout or agent may
have access to this host. Source/Node installation is root-owned, not writable by
the service account; `/var/lib/pc100-private` must be controller-owned mode 0700,
and separate issuer/reader key files mode 0600, single-link and outside checkout.
The Windows/WSL/shared Administrator environment is explicitly untrusted and must
never receive real keys. The template does not provision a host or install Node.

Before the FIRST real `--once` or `--watch`, the Owner must explicitly authorize
check issuance to **all open base-main PRs**, not just PR100, on a separately
controlled host. N2 must first authenticate read-only complete bypass visibility.
Omitted actors, inaccessible protection or unknown App scope remain BLOCKED.
No permission expansion, Owner PAT substitution or settings change is a fallback.

After a reviewed main advance: stop the service; withhold merges; independently
inspect the new exact main/source policy; Owner deploys that clean immutable
checkout without exposing keys; restart against the same private journal; verify
reconciliation/revocation of old heads before resuming. The controller itself
never updates Git. A base drift halts it; restart attempts are bounded by systemd.
On outage it reports unconfirmed revocation instead of claiming old checks expired.
GitHub native checks have no TTL. Consumers reject expired evidence, but native
merge safety still requires withholding merges on issuer outage/drift.

LIVE_A6_ENFORCED=NO. TRUSTED_CONTROLLER_HOST_READY=NO.
N2_READER_VISIBILITY=NOT_VERIFIED. POLICY_APPROVAL=NOT_GRANTED.
RELEASE_HOLD=ACTIVE. No services were started, real keys read, checks activated,
cloud resources created, policies approved, PRs merged or releases deployed.

## PR107 Independent QA remediation: source protocol, NOT activation

QA baseline `28efec1d426960c165222753dd748de74c7ba25c` and the independent report
remain immutable. The following are software changes tested with synthetic
credentials. `source_authority` is still null, both consumer flags false and the
candidate registry empty. None of these tests authenticates the real Reader App,
resolves live merge freeze or authorizes installing this source on main.

### Authoritative bypass evidence (BLOCKER-1)

Probe, ordinary-source authorization and attestation collection now use one
strict `collectProtectionEvidence` predicate. Missing is never empty. Explicit
REST PR-bypass allowances must have empty users/teams/apps. When the restricted
Reader capability is selected, the source-fixed `PC100BranchBypass` GraphQL query
corroborates the legacy branch-rule evidence (including explicit REST evidence).
The writer cannot supply its token, URL, arbitrary query or a PAT fallback.
A literal QA field-omitting REST replay is committed as a regression fixture.

The query binds repository database/node identity, name, `refs/heads/main`, exact
stable B, applicable rule ID/database ID/pattern and actual matching refs. Every
queried connection must have consistent count/nodes/edges/cursors and complete
pageInfo. Non-null zero bypass count is mandatory. The implementation deliberately
rejects more than 100 rules/refs/allowances or more than one applicable legacy
rule: those cases require explicit future support, not an unrelated empty count.
Null/partial/error/unauthorized GraphQL results reject. Main, REST protection,
complete effective rules, ruleset records and GraphQL corroboration are reread
before evidence is accepted; any B, rule or policy change rejects.

Ruleset `bypass_actors` remains a separate complete, explicitly empty requirement;
branch-rule GraphQL does not replace it. No extra App permission is requested.
Official API semantics: [branch protection REST](https://docs.github.com/en/rest/branches/branch-protection),
[GraphQL BranchProtectionRule](https://docs.github.com/en/graphql/reference/branches#branchprotectionrule)
and [Ref](https://docs.github.com/en/graphql/reference/git#ref).
The sanitized v2 snapshot binds B and the corroboration source/rule/digest, never
raw actors or credentials. Consumers authenticate that App-issued snapshot and
its exact protected-main source; they do not call these private endpoints.

Hermetic outcomes are **MOCK_READY**, not LIVE/N2 verification. Administration
READ access to the exact GraphQL connection and complete ruleset actors with the
same real Reader installation token remains **NOT_VERIFIED/BLOCKED**. A later
Owner-only independent-host probe must establish both or activation must stop.

### Per-PR isolation and alias policy (HIGH-1, MED-1, LOW-4)

Deleted forks, retargeted or malformed PRs and duplicate list IDs are locally
quarantined with fixed reason codes. They cannot create positive authorization or
terminate unrelated-head polling. Old journaled checks for the affected head are
invalidated and removed. Authoritative detail, not the list's optional `merged`
field, controls a valid PR. A persistence failure, global protection/credential
outage, source/main drift or unconfirmed revocation remains a global stop: the
controller does not disguise those as harmless quarantines or auto-clear locks.

GitHub checks attach to SHAs, not individual PRs. Changed ordinary PRs with a
same-H alias remain denied; fork changed-source review is unsupported. Native
same-H ambiguity is not solved by ignoring foreign PRs. A canonical PR100 head
can only be evaluated under the independent candidate policy, never borrowed
ordinary review. Alias journal bookkeeping does not manufacture a separate
positive authorization. Same-H availability/griefing remains an Owner disposition
and activation blocker; this repair only prevents unrelated-head/global denial.

### Ordinary signer boundary and recovery (HIGH-2, MED-5, LOW-3/5)

A single ordinary source signature cannot change the control plane. The enforced
boundary includes `.github`, `infra`, `tools`, `tests`, hidden root configuration,
operational/evaluation policy documents, all dependency/lock/build configuration,
Docker/Compose inputs and non-100644 modes (including executable changes). The
full before/after path/mode/blob inventory detects additions, removals and renames.
Controller, verifier, signature validation, App descriptors, roots and CI policy
cannot approve themselves through this ordinary path. Their updates fail with
`SOURCE_CONTROL_CHANGE_REQUIRES_INDEPENDENT_REVIEW` even if signed by the ordinary
key. Unrecognized or missing source roots still reject, with no neutral fallback.

No higher-assurance signer is enabled. A separately reviewed protected-main
control-plane process is required before enabling any authority. A conservative
future proposal is a source-anchored 2-of-3 independent reviewer quorum, distinct
from PR authors, agents, QA, Actions, controller and each other, with exact
repo/H/B/M/trees/diff/scope/time binding. Changing quorum membership or roots must
require the previous quorum plus independent protected-main human review. This is
an unimplemented Owner trust-contract decision, not permission granted here.
There is no hidden administrative success override.

Ordinary review signatures use canonical unpadded base64url encoding and one
canonical audit digest. Both merge parents [B,H] and TH=TM are checked against
live Git objects and the PR's current M before and after issuance. Null,
recreated, conflicted or stale merge metadata fails closed; a newly computed M
requires a fresh independently signed record. Signatures expire within ten
minutes, with bounded skew. They bind B, so main advance also invalidates them.
GitHub native checks themselves have **no TTL**; outage can leave a stale native
positive. Withhold merges on issuer outage and revalidate externally before any
future activation. Consumers' freshness rejection does not erase native checks.

Public records are delivered by the independent host's root operator to
`/var/lib/pc100-reviews` (root:root,0755), as atomic, single-link root-owned files
(0644). The service has read-only access. This delivery does not grant the signer
access to App keys or journals. The source-signing private key is never on this
host. Signature production/custody, renewal cadence and human independence are
still BLOCKED pending explicit Owner review; no personnel or live delivery is
arranged by these source changes.

Key loss/compromise/rotation is not repaired by silently removing a required
context. Stop issuance and withhold merges; independently verify affected checks
and source. While activation is still off, install any newly reviewed trust
configuration only through normal protected-main review. After activation,
ordinary control-plane rotation is deliberately unsupported: obtain the reviewed
higher-assurance recovery/quorum procedure first, retaining branch protection.
No signature from a lost ordinary key, PR label, shared GitHub credential or
self-authored comment is a recovery authority. Until that contract exists, stop.

### Documented read-only installation prerequisites (MED-2, LOW-7)

These are instructions for a FUTURE separately authorized independent host, not
commands run by the Coding Agent. Do not install credentials or start a service
on the shared Windows/agent environment. The Owner first reviews an exact main
commit and installs a standalone, clean root-owned checkout (no worktrees,
symlinks, object alternates, agent-writable code or embedded clone credentials)
at `/opt/pc100/reviewed-main`, plus the reviewed actual Node24 executable at
`/opt/pc100/node24/bin/node`. Keep source and Node files root-owned and not writable
by group/others. Never recursively change their owner to the service account.

Before any service startup, prepare an exact protected Git configuration:

```sh
# Independent host root, only after source/host installation authorization.
install -d -o root -g root -m 0755 /etc/pc100 /var/lib/pc100-reviews
printf '[safe]\n\tdirectory = /opt/pc100/reviewed-main\n' > /etc/pc100/gitconfig
chown root:root /etc/pc100/gitconfig
chmod 0644 /etc/pc100/gitconfig
```

The startup helper verifies ownership/modes, canonical paths and no symlinks for
Node, checkout, Git metadata and ancestors, enforces this exact config content,
rejects shared object stores, pins HEAD to independently authenticated main B and
requires a clean tree. Git receives this system config only, no global config,
no inherited Git overrides or optional index writes. No `safe.directory=*` is
permitted. The source account stays read-only; the private key/journal directory
alone is service-owned0700, with distinct0600 key files. No `--once` is authorized
by installing these templates. It would issue checks for every open base-main PR.

The Linux regression creates a disposable root-owned synthetic checkout/config,
then executes the actual startup/public-record helpers as `nobody` inside a real
transient systemd unit with the template's hardening and no network. It verifies
startup, inability to edit source/config and rejection of wildcard trust and
symlinked checkout. It uses existing Node/Git binaries, no App keys/API/service
activation, account creation or persistent unit. This tests the documented
filesystem prerequisite path, NOT full real-host/controller operation.

The template additionally sets PrivateDevices, ProtectClock, ProtectKernelLogs,
RestrictNamespaces, LockPersonality, RestrictRealtime and native syscall
architecture. MemoryDenyWriteExecute is deliberately omitted because Node/V8 JIT
needs executable memory transitions; a source change that enables it requires
native qualification. Production PrivateNetwork would block required GitHub
HTTPS, so only the synthetic unit uses it. No new host sandbox permissions are
assumed from a Windows test. Full independent-host hardening remains unqualified.

### Supply evidence and lifecycle handling (MED-4/6/7)

Run success alone is insufficient. The consumer binds attempt1, immutable run,
workflow and source, then reads the entire bounded paginated attempt job list.
The supported protected-main Supply workflow is bound to SHA256
`2c54849ebbbf401538572dab86e6466d888218e3d7fb936aaa8afa165708a4a9`.
Its exact profile requires dependencies, release guard, all11 named images and
security aggregate success; release/publish/staging jobs must be skipped on the
PR event. All job/check/suite GitHub App, H, run and attempt associations must
match. Missing, failed, skipped-required, duplicate, additional, cross-attempt or
racing evidence rejects. Unknown workflow bytes require a new independent control
review. No retry protocol beyond original attempt1 is approved. The existing424
HIGH findings remain unwaived; this code changes no scanners or severity policy.

A leftover journal `.lock` deliberately blocks restart. Never remove it because
of age, mtime or a PID alone, and never build an adversary-triggered unlock path.
Safe MANUAL recovery requires the independent host Owner to stop/fence every
controller, prove exclusive local journal storage and that no live controller or
credential can mutate it (or keep the host stopped if exclusivity is unproven),
preserve the private journal/lock and filesystem metadata in a private backup,
validate the journal against the exact reviewed source and actual issued checks,
and independently authorize removal of only that known lock. Do not publish this
backup. Reconcile/revoke recorded old checks before resuming merges. If ownership,
corruption, unconfirmed writes or another host is possible, do not unlock.
A persistent storage failure stays a global stop, not a per-PR exception.

After main advances, stop/fence the old unit and withhold merges. Independently
review the new main SHA/control inventory and obtain explicit Owner source-pin
rollover authorization; install the clean new root-owned checkout and matching
config. Keep the existing private journal for old-head reconciliation. Verify
complete source/protection visibility, revoke stale checks and observe a clean
cycle before resuming. No auto-pull, timestamp-based source rollover or claim that
old native checks expired is permitted.

LOW-1 fixtures now capture one clock instant per signature window. LOW-2 rejects
alternate encodings of identical signature bytes. LOW-6 CLI failures use a closed
safe outcome instead of echoing uppercase SDK/exception text. Focused mutant
regressions cover authority key ID/capability, inventory, expiry, bypass visibility,
external ID, suite integration, head/merge equality, parent order and verified
consumer-proof capability. All App transports and credentials in these tests are
synthetic; actual N2, source custody and independent QA are still required.

PR107_INDEPENDENT_SOURCE_QA=FAIL until fresh independent review.
PR107_BOOTSTRAP_SAFE_TO_MERGE=NO. A6_MERGE_FREEZE_RESOLVED=NO (live).
A6_CONSUMER_ATTESTATION_CODE_READY=NO. N2_READER_VISIBILITY=NOT_VERIFIED.
LIVE_A6_ENFORCED=NO. RELEASE_HOLD=ACTIVE. PR100/PR103 remain untouched.
