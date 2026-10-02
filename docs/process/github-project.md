# GitHub Project setup

GitHub is the only project-management platform for EditAgent. One GitHub Project is the board. GitHub Issues are the story records. Pull requests stay the only path for review and merge, as written in [pull-requests.md](pull-requests.md) and [working-agreements.md](working-agreements.md). Do not keep a second board in Jira, Linear, or another GitHub Project.

`docs/roadmap/export/jira-import.csv` is still generated from the YAML backlog. It is a legacy export. Do not import it. Do not create the 791 Jira rows as GitHub issues.

The planning source is `docs/roadmap/backlog/*.yaml`, rendered to
[docs/roadmap/export/backlog-full.csv](../roadmap/export/backlog-full.csv).

## What was actually set up

On 2026-10-02 the repository had issues enabled and projects enabled, and it had no open or closed issues and no GitHub Project. Creating the project failed:

`createProjectV2`: `cursor[bot]` does not have permission to create projects on owner `mahmoudemad68` (`ownerId U_kgDODM5xtA`).

No issues were created. There is no project to attach them to, and a bulk create without that project would leave an unsynced issue list. US-109 AC1 stays **BLOCKED** until the owner creates the project and the Sprint 1 and Sprint 2 cards are visible on it, with story points and confirmed lane owners.

## Board

Columns, in order:

**Backlog → Ready → In Progress → In Review → Done.**

| Field             | GitHub type                             | Values                                                                |
| ----------------- | --------------------------------------- | --------------------------------------------------------------------- |
| Status            | Single select                           | Backlog, Ready, In Progress, In Review, Done                          |
| Sprint            | Iteration                               | Sprint 1, Sprint 2, and later sprints when the owner sets their dates |
| Story Points      | Number                                  | The roadmap points. Do not invent a second estimate                   |
| Priority          | Single select                           | P0, P1, P2, P3                                                        |
| Lane              | Single select                           | AI, MM, GEN, BE, FE, OPS, ALL                                         |
| Original story id | Text, also the start of the issue title | `US-101`, `EP-01`                                                     |

GitHub Projects does not enforce a WIP limit. The team checks the proposal by hand at the stand-up:

- Ready: the sum of Story Points is at most 52.
- In Progress: at most 5 issues.
- In Review: at most 5 issues.
- Backlog and Done: no cap.

Those numbers are still a proposal in [working-agreements.md](working-agreements.md). There is no automation that blocks a sixth card.

Iteration dates are **PENDING**. Until the owner sets them, Sprint 1 and Sprint 2 are still identified by the `Sprint` text in the issue body. Do not change a story's sprint in the YAML to fit an empty iteration field.

## Issue mapping

Create issues only for Sprint 1 and Sprint 2 stories, plus the epics those stories name. That parent set is `EP-01`, `EP-02`, `EP-03`, `EP-04`, and `EP-05`. Do not create the other epics, features, or the 603 technical tasks. Tasks stay in the story body.

Search open and closed issues for the original id before creating one. A title that already starts with `US-101` or `EP-01` is the existing record. Update that issue. Do not create a second one.

Story title: `{ID} {Title}` from `backlog-full.csv`, for example `US-101 Software Requirements Specification with measurable NFRs`.

Story body:

```text
Original ID: US-101
Epic: EP-01
Feature: FT-01.1
Lane: ALL
Priority: P0
Story Points: 5
Sprint: Sprint 1
Depends on: none

<Description column, which already contains the user story, acceptance criteria, and technical tasks>
```

Epic title: `{ID} {Title}`. Epic body records `Original ID` and the epic description. Epics are traceability parents. They are not extra sprint scope and they do not add story points.

Set Status from merged pull-request evidence, not from the fact that the card is new. A story whose implementation pull request is merged is Done. A story with only a draft pull request is In Progress. A story with no implementation pull request is not started and stays in Backlog. The evidence used on 2026-10-02 is in [sprint-1-2-board-checklist.md](sprint-1-2-board-checklist.md). Mentioning a story id in a pull request body is not enough. The pull request has to be the change that implemented that story.

Leave Assignees empty until [team-approval-record.md](team-approval-record.md) names the lane owner. Lane is not a person.

A pull-request approval does not approve the working agreements. US-109 AC2 stays a signature on the approval record.

## Runbook

1. Run `python3 tools/roadmap/build_roadmap.py --check` and `python3 tools/roadmap/check_tracker_export.py`. Both must exit 0. The second command checks the GitHub mapping. It does not create issues, and a pass does not mean the project exists.
2. The owner creates one GitHub Project on `mahmoudemad68/Your_Editor` and adds the fields in the table above. Record the project number in this file.
3. Search issues for `US-` and `EP-0`. If any Sprint 1 or Sprint 2 id already exists, reuse it.
4. Create or update the five epic issues, then the 17 Sprint 1 stories and 14 Sprint 2 stories. Set Story Points, Priority, Lane, and Status from the checklist. Set Sprint when the iteration dates exist.
5. Open the board and write the issue number into the checklist's "Seen on project" column. Do not copy the expected points into that column without reading the project.
6. Confirm the visible Sprint 1 total is 50 SP and the Sprint 2 total is 48 SP.
7. Assign people only after the approval record names them. Until then AC1 is still blocked on confirmed owners even if the cards and points are visible.

Do not run a loop that creates every story in `backlog-full.csv`. Later sprints are added in the same idempotent way when their sprint starts.
