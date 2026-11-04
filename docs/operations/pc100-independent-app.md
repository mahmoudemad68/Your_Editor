# PC100 independently issued admission check

The issuer is a dedicated GitHub App on an Owner-controlled **external Linux
host**, never a PR runner. `pc100-admission-app.mjs` polls the actual PR, reads the
protected-main registry and complete source inventory, authenticates the current
native preflight run, and publishes only its own check on the exact product HEAD. Every other open main
PR receives the same context with an authenticated neutral NOT_APPLICABLE record
bound to live PR number/H/B/M and main, explicitly denying candidate/release admission.
This includes registry, Dependabot and ordinary PRs, before and after PR100 merges.
Only PR100 can enter candidate evaluation; neutral/skipped checks cannot authorize it.
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

Before each evaluation the issuer marks its previous exact-H check failed; it
updates it only after current policy succeeds. It revalidates policy after writing
success and marks failure on close/undraft/merge, H/B/M drift or policy revocation.
The watch cycle covers every open main PR and tracks old heads, invalidating those
checks on transitions. Installed-main drift invalidates tracked checks and exits.
API or token outage can prevent revocation; a restarted process cannot recover
all historic observations. Old-head checks cannot authorize a new HEAD, and
consumers independently reject changed main, policy, H/B/M/trees and expired proof.

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
the merge ref M for `GITHUB_SHA` and `GITHUB_WORKFLOW_SHA`; checkout of trusted B
does not change those variables. The diagnostic validates this real environment,
logs only H/B/M/workflow/checkout SHAs, then invokes protected-main code only for
PR100. The actual required source is the external App, never this Actions check.

## Protected-main bootstrap deadlock

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
