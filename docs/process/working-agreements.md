# Working agreements

Written for [US-109](../roadmap/phases/phase-1-foundation.md#us-109---product-backlog-board-and-team-working-agreements).
This page records the planning rules already in the [roadmap](../roadmap/README.md#6-scrum-process) and the pull-request
path in [pull-requests.md](pull-requests.md). It does not replace those pages, and it does not change story points,
sprint assignments, or scope.

**Approval status: not approved.** No team member has signed
[team-approval-record.md](team-approval-record.md). US-109 AC2 stays **BLOCKED** until every member does.

**Tracker status: `TRACKER_SETUP_PENDING`.** Sprint 1 and Sprint 2 are represented in the repository CSV files and
checked by `tools/roadmap/check_tracker_export.py`. They have not been observed on a Jira board. US-109 AC1 stays
**BLOCKED** until that import is seen. See [tracker-import.md](tracker-import.md).

WIP numbers and named people below are proposals. The GitHub sequence and the existing Definition of Ready and
Definition of Done are the repository's current practice.

## Planning

| Rule              | Value                                              | Status                                                                |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| Sprint length     | 2 weeks, 12 sprints                                | Already in `docs/roadmap/backlog/plan.yaml`                           |
| Estimation scale  | Fibonacci: 1, 2, 3, 5, 8, 13                       | Already in the roadmap                                                |
| Split rule        | A story above 8 SP is split before it enters Ready | Already in the roadmap                                                |
| Velocity baseline | 48 SP per sprint                                   | Already in the roadmap                                                |
| Capacity cap      | 52 SP per sprint                                   | Already in the roadmap. The generator rejects a sprint above this cap |

Sprint 1 is already committed at 50 SP. Sprint 2 is committed at 48 SP. Both are inside the cap. This document does
not add or remove stories from either sprint. A later planning change goes through the YAML backlog and a pull request.

The current export has no scheduled story above 8 SP. A 13 SP estimate may exist only long enough to be split. It does
not enter Ready and it is not committed to a sprint.

## Board

The board columns, in order, are:

**Backlog → Ready → In Progress → In Review → Done.**

The import mapping for those columns is in [tracker-import.md](tracker-import.md). The board itself is not configured
until the Jira workspace exists.

### Proposed WIP limits

These numbers are a **proposal**. They are not in force until the approval record says the team accepted them.

| Column      | Proposed limit | Rule                                                                                                              |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Backlog     | No cap         | Holding area. Work here is not started.                                                                           |
| Ready       | 52 SP          | At most one sprint of ready work, matching the capacity cap.                                                      |
| In Progress | 5              | One story for each person who is writing code. A person who covers several lanes still has one story in progress. |
| In Review   | 5              | Review capacity matches the writing capacity.                                                                     |
| Done        | No cap         | Stories that meet the story Definition of Done.                                                                   |

The headcount behind the In Progress and In Review limits is the planning assumption of five engineers. If the owner
confirms four or six people, replace 5 with that headcount. That confirmation is **PENDING**.

A developer does not move a new story to In Progress in either of these cases:

- A story they opened is still In Review.
- The In Review column is already at its limit.

The next action in both cases is to review, or to return the waiting story to In Progress with the requested changes.
Starting a different story does not clear the review queue.

Done is not a place for unfinished work. A story that misses the Definition of Done returns to the backlog at the
sprint boundary. It is estimated and committed again at the next planning session. It is not left "almost done".

## Definition of Ready

A story enters Ready when every line below is true. The dependency and test lines keep the stricter rules already in
the roadmap.

- The description is clear and uses the form "As a …, I want …, so that …".
- Acceptance criteria are written, and they are specific enough to test.
- Story points are estimated on the Fibonacci scale, and the estimate is 8 SP or less.
- Dependencies are identified. They are done, or the contract (schema, API, or interface) is agreed so work can start
  against a stub.
- The owner lane is assigned: AI, MM, GEN, BE, FE, OPS, or ALL.
- The test approach is known: unit, integration, end-to-end, or an evaluation metric.
- Required resources are identified: credentials, sample media, a GPU, or a staging environment. Missing access is a
  blocker, not a silent assumption.

## Definition of Done

This is the story Definition of Done from the roadmap and the
[pull request template](../../.github/PULL_REQUEST_TEMPLATE.md). A story is done when all of the following hold:

- [ ] Implementation complete and every acceptance criterion demonstrated
- [ ] Unit tests pass; integration tests pass where the story crosses a module, worker, or external service boundary
- [ ] Error handling and structured logging (with correlation IDs) implemented
- [ ] Architecture dependency rules, lint, and type checks pass; schemas and prompts versioned
- [ ] Code review completed (two approvals for security-sensitive modules)
- [ ] Documentation updated (module README, API spec, guides touched by the change)
- [ ] No critical or high security findings from CI scanners
- [ ] Merged to `main`, CI pipeline green, and deployed to staging
- [ ] The user scenario tested end-to-end on staging (automated E2E where one exists)

Operational meaning of the checks already required on `main`:

- The required status check is `ci`. It runs the roadmap check, install, build, lint, architecture, typecheck, and
  test. Lint includes ESLint, Prettier, dependency-cruiser, Ruff, and import-linter.
- The branch is up to date with `main` before merge. The active ruleset uses a strict required status check.
- One approving human review is required by the repository ruleset. Auth, the tool executor, the sandbox, and
  acquisition still need a second approval. That second approval is the Definition of Done practice.
  `require_code_owner_review` is off, and the [CODEOWNERS](../../.github/CODEOWNERS) entries are placeholder team
  slugs, not people.
- Independent QA, described below, passes on the exact HEAD before the pull request is marked ready for review.
- Merge is manual. Automatic merge is disabled on this repository (`allow_auto_merge` is false, observed 2026-10-02).

The sprint Definition of Done in the roadmap still applies at Sprint Review: the increment is demonstrated, unfinished
stories return to the backlog, nightly failures are ticketed, and retrospective actions become backlog items.

## GitHub workflow

Observed repository rules for `main` on 2026-10-02, ruleset `main`:

- The branch cannot be deleted, and history cannot be rewritten with a force push.
- Pull requests are required.
- The status check `ci` is required, and it must be green on the latest `main`.
- One approving review is required. Code-owner review is not required by GitHub.
- Merge commit, squash, and rebase are allowed. Automatic merge is off.

The path a change follows:

1. Agent A creates a feature branch from the latest `main`.
2. Agent A opens a **draft** pull request and fills in the template.
3. The required `ci` check runs on that HEAD.
4. Independent QA, who did not author the change, tests that exact HEAD in a read-only pass.
5. A failure is repaired on the **same** pull request.
6. Independent QA retests the new HEAD.
7. The author marks the pull request ready for review only after that pass.
8. Human reviewers approve it. One approval is required. Security-sensitive modules need two.
9. The repository owner performs a **manual merge**.

There is no automatic merge. A green check does not merge the pull request. Independent QA does not replace human
approval. The owner account that is allowed to merge is **PENDING** confirmation.

## Team collaboration

Lanes name the primary owner of a story. They are not exclusive silos. Pairing is expected, especially on OPS and on
integration stories. One person may cover more than one lane. The person for each lane is **PENDING**.

| Lane                                 | Code | Primary work                                                          | Development owner                                           | Review buddy               |
| ------------------------------------ | ---- | --------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| AI / Agent Engineer                  | AI   | Agent, perception models, evaluation                                  | PENDING                                                     | PENDING, from another lane |
| Multimedia Engineer                  | MM   | Media, FFmpeg, audio and visual analysis                              | PENDING                                                     | PENDING, from another lane |
| Generative Video / Remotion Engineer | GEN  | Remotion, motion graphics, render strategies                          | PENDING                                                     | PENDING, from another lane |
| Backend Engineer                     | BE   | API, domain, persistence, queue                                       | PENDING                                                     | PENDING, from another lane |
| Frontend Engineer                    | FE   | Web application                                                       | PENDING                                                     | PENDING, from another lane |
| DevOps & QA (shared)                 | OPS  | CI, environments, security baseline, test harnesses                   | PENDING. A sixth member takes this lane if the team has one | PENDING, from another lane |
| Whole team                           | ALL  | Shared stories such as the SRS, this agreement, release, and the demo | Every member                                                | PENDING facilitator        |

The review buddy is the expected first human reviewer and is not the author. Reviews are due within one working day.
That response time is already in the roadmap and in [pull-requests.md](pull-requests.md).

Independent QA is a separate read-only pass on the exact HEAD. The QA assignee is **PENDING** and is not the author of
the change under test.

### Blockers

- The person who is blocked says so at that day's stand-up and moves the card only when the column still matches the
  work.
- If the blocker is still there at the next stand-up, the lane owner escalates it to the whole team.
- Who has the authority to unblock cross-lane work is **PENDING** owner confirmation.

### Daily progress

Progress is reported at the daily stand-up: 15 minutes, board-driven, blockers first. The card column matches what the
person reports. A separate written daily log is **PENDING** if the team wants one in addition to the stand-up.

### Ceremonies

Times below are the cadence already in the roadmap. Clock time and the facilitator are **PENDING**.

| When             | Ceremony                                                                                                                                         | Duration                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Day 1            | Sprint Planning. Confirm the sprint goal, commit stories that are Ready, and break them into tasks. The committed total stays at or under 52 SP. | 2 hours                             |
| Each working day | Stand-up, by lane group                                                                                                                          | 15 minutes                          |
| Days 2–3         | Contract review for cross-lane stories (schemas, OpenAPI, tool manifests)                                                                        | As needed for the contracts in play |
| Day 6            | Backlog refinement. Make the next sprint's stories Ready. Split anything above 8 SP.                                                             | 1 hour                              |
| Day 8            | Integration day. Merge to `main` behind feature flags and dry-run the demo on staging                                                            | The working day                     |
| Day 10           | Sprint Review, with the supervisor at milestones                                                                                                 | 1 hour                              |
| Day 10           | Retrospective. Actions become backlog items                                                                                                      | 45 minutes                          |

### Carry-over

A committed story that does not meet the story Definition of Done returns to the backlog. It is not carried in
In Progress or In Review into the next sprint. The next Sprint Planning estimates it again and may commit it again.
The sprint goal is not rewritten to call unfinished work done.

## Responsibility matrix

Actual names require owner confirmation. Until then every person cell stays **PENDING**.

| Responsibility                     | AI                                                                                                                                                                                                   | MM      | GEN     | BE      | FE      | OPS     | Whole team          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- | ------- | ------- | ------- | ------------------- |
| Development of that lane's stories | PENDING                                                                                                                                                                                              | PENDING | PENDING | PENDING | PENDING | PENDING | Shared ALL stories  |
| Review buddy for that lane         | PENDING                                                                                                                                                                                              | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING facilitator |
| Independent QA                     | A non-author. Named assignee PENDING. One person may cover QA for several lanes.                                                                                                                     |         |         |         |         |         |                     |
| Approval                           | One human approval on every pull request. A second human approval for auth, the tool executor, the sandbox, and acquisition. Named approvers PENDING.                                                |         |         |         |         |         |                     |
| Release                            | The repository owner merges manually after `ci` is green, the required approvals are present, and the branch is up to date. The GitHub account is PENDING confirmation. There is no automatic merge. |         |         |         |         |         |                     |

## Related documents

| Document                                                       | Contents                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [tracker-import.md](tracker-import.md)                         | Jira field mapping, import runbook, and the local validation result                               |
| [sprint-1-2-board-checklist.md](sprint-1-2-board-checklist.md) | Sprint 1 and Sprint 2 ids, points, lanes, and dependencies, with tracker columns still unobserved |
| [team-approval-record.md](team-approval-record.md)             | Signature template. Empty until the team signs                                                    |
| [pull-requests.md](pull-requests.md)                           | Required `ci` check, one approval, and the up-to-date branch rule                                 |
| [Roadmap Scrum process](../roadmap/README.md#6-scrum-process)  | Cadence, Definition of Ready, and Definition of Done                                              |
