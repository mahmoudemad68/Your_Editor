# Tracker import

The selected tracker is Jira. The file to import is
[docs/roadmap/export/jira-import.csv](../roadmap/export/jira-import.csv), generated from
`docs/roadmap/backlog/*.yaml`. Do not edit the CSV by hand. Do not change story points or sprint assignments in order
to make an import easier.

**`TRACKER_SETUP_PENDING`.** On 2026-10-02 this environment had no `JIRA_BASE_URL`, `JIRA_URL`, `JIRA_TOKEN`,
`JIRA_API_TOKEN`, or `ATLASSIAN_API_TOKEN`. The repository had no GitHub issues and no GitHub Project. No import was
run. Creating GitHub issues as well as a later Jira import would duplicate the backlog, so the GitHub issue snippet in
the roadmap README stays unused while Jira is the selected tracker.

US-109 AC1 stays **BLOCKED** until someone with access imports the file once and records what they saw in
[sprint-1-2-board-checklist.md](sprint-1-2-board-checklist.md).

## Local validation

Run this before every import, after `python3 tools/roadmap/build_roadmap.py --check`:

```bash
python3 tools/roadmap/check_tracker_export.py
```

Result recorded for the CSV on `main` at the time US-109 was written:

| Check                                        | Result                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Duplicate issue ids                          | None in either CSV                                                             |
| Jira hierarchy                               | Epic (no parent) → Story (parent is the epic) → Sub-task (parent is the story) |
| Full-backlog hierarchy                       | Phase → Epic → Feature → Story → Task, every parent present                    |
| Story id sets                                | The same 152 stories in both files                                             |
| Points, lane, priority, sprint, dependencies | They match, including the dependency sentence inside the Jira description      |
| Duplicate label values on one row            | None                                                                           |
| Story points on sub-tasks                    | None. Points stay on the story                                                 |
| Scheduled stories above 8 SP                 | None                                                                           |
| Sprint 1                                     | 17 stories, 50 SP                                                              |
| Sprint 2                                     | 14 stories, 48 SP                                                              |
| Import into a live tracker                   | **Not run**                                                                    |

`backlog-full.csv` has 877 rows: 6 phases, 36 epics, 80 features, 152 stories, and 603 tasks. `jira-import.csv` has
791 rows: 36 epics, 152 stories, and 603 sub-tasks. Jira does not receive Phase or Feature rows. A story's Jira parent
is its **epic**, not its feature. The feature id is the second label on the story.

Seven stretch stories (`US-205`, `US-404`, `US-506`, `US-517`, `US-519`, `US-527`, `US-528`) have Sprint `Stretch` in
`backlog-full.csv` and a blank Sprint cell in `jira-import.csv`, with the label `stretch`. That is the generator's
mapping, not two copies of the story.

The header repeats the name `Labels` four times so Jira can map four label columns. That repeated header is not a
duplicate record.

Dependencies are text in the story description (`Depends on: US-102`). The CSV does not create Jira issue links. After
a successful import, create those links from the `Depends On` column. Until that step is observed, dependency links on
the board stay unverified.

## Field mapping

Create these Jira pieces before the CSV import:

| Jira object   | Exact values                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue types   | Epic, Story, Sub-task                                                                                                                                               |
| Components    | `AI / Agent Engineer`, `Multimedia Engineer`, `Generative Video / Remotion Engineer`, `Backend Engineer`, `Frontend Engineer`, `DevOps & QA (shared)`, `Whole team` |
| Sprints       | `Sprint 1` through `Sprint 12`                                                                                                                                      |
| Priorities    | Highest, High, Medium, Low                                                                                                                                          |
| Board columns | Backlog, Ready, In Progress, In Review, Done                                                                                                                        |

Map the columns as follows. The four `Labels` columns are separate mappings, in order.

| CSV column   | Jira field   | Rule                                                                                                                                           |
| ------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue Id     | Issue Id     | Keep `EP-01`, `US-101`, `US-101-T1`. A second import of the same ids creates duplicates. Stop if any of these ids already exist.               |
| Parent Id    | Parent       | Empty on epics. Story parent is the epic. Sub-task parent is the story.                                                                        |
| Issue Type   | Issue Type   | Epic, Story, or Sub-task                                                                                                                       |
| Summary      | Summary      | `{id} {title}` for epics and stories. Sub-task summaries are the task text, cut at 250 characters. The Description column keeps the full text. |
| Description  | Description  | Story body includes acceptance criteria, technical tasks, `Depends on:`, and parallelism.                                                      |
| Priority     | Priority     | Empty on epics. `P0` → Highest, `P1` → High, `P2` → Medium, `P3` → Low.                                                                        |
| Story Points | Story points | Stories only. Leave epics and sub-tasks blank. Do not add sub-task estimates back onto the story.                                              |
| Sprint       | Sprint       | `Sprint 1` … `Sprint 12`. Blank means the stretch backlog.                                                                                     |
| Component/s  | Component    | The lane display name in the table above. This is the lane, not a person's account.                                                            |
| Labels 1     | Labels       | Phase id (`PH1` … `PH6`)                                                                                                                       |
| Labels 2     | Labels       | Epic: `mvp`, `advanced`, or `release`. Story: feature id such as `FT-01.4`. Sub-task: task tag such as `doc`, or blank.                        |
| Labels 3     | Labels       | Story: `P0`, `P1`, `P2`, or `P3`. Otherwise blank.                                                                                             |
| Labels 4     | Labels       | Story: phase scope, or `stretch` when Sprint is blank. Otherwise blank.                                                                        |

Proposed status mapping, applied when the board is created. WIP numbers are proposals in
[working-agreements.md](working-agreements.md) and are not approved.

| Board column | Proposed Jira status | Proposed WIP |
| ------------ | -------------------- | ------------ |
| Backlog      | Backlog              | No cap       |
| Ready        | Ready                | 52 SP        |
| In Progress  | In Progress          | 5            |
| In Review    | In Review            | 5            |
| Done         | Done                 | No cap       |

Leave Assignee empty. Named owners are **PENDING** in [team-approval-record.md](team-approval-record.md).

## Runbook

1. Run `python3 tools/roadmap/build_roadmap.py --check` and `python3 tools/roadmap/check_tracker_export.py`. Both exit 0
   before an import.
2. Open the Jira project that the owner names. If that project already contains `US-101` or `EP-01`, stop. Do not
   import again.
3. Create the issue types, seven components, twelve sprints, priorities, and five board columns listed above.
4. Jira: **System → External System Import → CSV**. Map `Issue Id` and `Parent Id` so the epic / story / sub-task
   tree is kept. Map Story Points, Component/s, Sprint, Priority, and each Labels column.
5. Search for `US-101` and `US-109`. Confirm the story points, component, sprint, and parent epic. Spot-check one
   sub-task, `US-109-T4`, and confirm its parent is `US-109`.
6. Walk [sprint-1-2-board-checklist.md](sprint-1-2-board-checklist.md). Fill the observation columns from the board.
   Do not copy the expected points into the observation column without looking at Jira.
7. Create issue links from each story's `Depends on:` line. Then mark the dependency column on the checklist.
8. Set WIP on the board only after the team accepts the proposal. Until then, record WIP as not applied.
9. Assign people only after the approval record names them.

Linear and GitHub Projects remain alternate importers in the roadmap README. Use one tracker. Do not run the GitHub
`gh issue create` snippet if this Jira import has been done or is still the plan.
