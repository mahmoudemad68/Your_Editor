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
still empty and `candidate-app.json` deliberately contains null identities.
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
   node tools/test/pc100-admission-app.mjs --once /secure/external/pc100-app.pem
   node tools/test/pc100-admission-app.mjs --watch /secure/external/pc100-app.pem
   ```

   A missing candidate policy produces a **failure**, never bootstrap success.
   Once the genuine App has issued its first check, its source can be selected in
   the GitHub UI. If the source is not selectable, leave admission blocked.

5. **Install and independently review the candidate registry BEFORE enabling any
   globally required context.** Verify ordinary, registry and Dependabot neutral
   checks on live PRs and source identity in the real UI first. Repository Settings → Rules → Rulesets → existing active `main` ruleset:
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
