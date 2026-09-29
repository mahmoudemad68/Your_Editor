# ADR-007 — Trunk-based development with short-lived branches

- **Status:** Proposed
- **Date:** 2026-09-29
- **Deciders:** Not yet accepted. Pending team review (US-103 AC2).

## Context

The roadmap's working agreement is trunk-based development. Integration happens on `main`. Long-lived feature branches would hide breaks in the module boundaries and in the TypeScript/Python contract until late in a sprint. The team is small, and review needs a predictable path.

## Decision

- `main` is the trunk. It stays releasable.
- Work happens on short-lived branches cut from `main`.
- Every change reaches `main` through a pull request.
- The pull request runs the automated checks, receives review, and is merged. Security-sensitive modules (auth, tool executor, sandbox, acquisition) need two approvals once those modules exist. The repository does not invent reviewers.
- Commit messages follow Conventional Commits.
- Branches are deleted after merge.
- Release branches and long-lived environment branches are not part of the model.

Branch protection, required CI, and the merge queue are US-112. This ADR sets the practice. It does not configure GitHub rulesets.

## Rationale

Short branches keep the architecture checks and the contract tests on the same trunk the team demos. Conventional Commits make the history readable and let later changelog tooling run without a second convention. Requiring a pull request gives the DoD a place to be checked.

## Consequences

- Contributors rebase or merge `main` into short-lived branches instead of stacking large forks.
- A story that cannot merge within a sprint is split or returned to the backlog. It is not parked on a long branch.
- This repository's foundation work follows the same practice: one short-lived branch and an open pull request. The pull request is not merged by the author of the ADRs.
- Until US-112 lands, the checks are local commands documented in the root README. The absence of branch protection is a known gap, not a silent exception to this decision.

## Alternatives considered

- **GitFlow (develop plus release branches).** Rejected. Two long-lived branches double the integration work for a team that deploys `main`.
- **Trunk commits with no pull request.** Rejected. The Definition of Done requires review, and architecture rules need a diff where they can be discussed.
- **One branch per sprint.** Rejected. It recreates a long-lived branch and delays integration until the sprint review.
