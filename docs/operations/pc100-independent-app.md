# PC100 independently issued admission check

The issuer is a dedicated GitHub App on an Owner-controlled **external Linux
host**, never a PR runner. `pc100-admission-app.mjs` polls the actual PR, reads the
protected-main registry and complete source inventory, authenticates the current
native preflight run, and publishes only its own check on the exact product HEAD.
Candidate qualification is separate from release authorization. The registry is
still empty and `candidate-app.json` deliberately contains null identities.
Publishing these files does not install or approve this gate.

## One-time Owner installation

1. In personal Settings → Developer settings → GitHub Apps, create a private App
   for this account. Disable webhooks (the controller polls). Give only repository
   Contents **read**, Pull requests **read**, Actions **read**, Checks **write** and
   the mandatory Metadata **read**. No user, organization, workflow-write,
   contents-write, administration, deployment or secret permissions are needed.
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

5. Repository Settings → Rules → Rulesets → existing active `main` ruleset:
   preserve all current rules and required checks; add
   **`PC100 independent security admission`**, explicitly selecting this dedicated
   App as expected source. Enable strict up-to-date checks. **Any source** and
   **GitHub Actions** are invalid. The consumer checks the effective public rules
   API for this exact context/integration ID and strict policy; absence or
   unsupported/inaccessible enforcement fails closed.
6. Independently review the actual candidate source/ELF/policy and install its
   registry entry on protected main. Never copy candidate-provided hashes into
   the registry as an approval. Reconcile PR controls with the reviewed main
   installation without altering reviewed product files.

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
