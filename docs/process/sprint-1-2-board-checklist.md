# Sprint 1 and Sprint 2 board checklist

Expected ids, points, lanes, epics, and dependencies come from `docs/roadmap/export/backlog-full.csv`. They match the YAML backlog. This checklist does not change them.

GitHub is the active tracker. `jira-import.csv` is a legacy generated export and is not imported.

**GitHub Project: not created.** On 2026-10-02, `cursor[bot]` could not create a Project for `mahmoudemad68` (`createProjectV2` permission denied). No issues were created. Every "Seen on project" cell is `NOT OBSERVED`. US-109 AC1 stays **BLOCKED** until the cards are visible and lane owners are confirmed.

The "Merged pull request" column is evidence from merged pull requests on 2026-10-02. It is the status to set when the owner creates the card. A new card for a merged story is Done. It is not put back in Backlog because the card did not exist when the code merged. A story id that only appears as a dependency or a later plan is not Done.

Lane owners are **PENDING**. Lane is the single-select field. It is not an assignee.

Sprint 1 is 17 stories and 50 SP. Sprint 2 is 14 stories and 48 SP. Both totals are inside the 52 SP cap. Sprint 1 is above the 48 SP velocity baseline and stays as committed.

Parent epics to create for traceability, with no extra story points: `EP-01`, `EP-02`, `EP-03`, `EP-04`, `EP-05`.

## Sprint 1

| ID     | SP  | Priority | Lane | Epic  | Depends on | Merged pull request                    | Seen on project |
| ------ | --- | -------- | ---- | ----- | ---------- | -------------------------------------- | --------------- |
| US-101 | 5   | P0       | ALL  | EP-01 | —          | Done (PR #3 merged)                    | NOT OBSERVED    |
| US-102 | 2   | P0       | ALL  | EP-01 | —          | Done (PR #3 merged)                    | NOT OBSERVED    |
| US-103 | 5   | P0       | BE   | EP-01 | —          | Done (PR #2 merged)                    | NOT OBSERVED    |
| US-104 | 2   | P0       | BE   | EP-01 | US-102     | Done (PR #6 merged)                    | NOT OBSERVED    |
| US-105 | 3   | P0       | AI   | EP-01 | —          | Not started                            | NOT OBSERVED    |
| US-106 | 2   | P0       | GEN  | EP-01 | —          | Done (PR #12 merged)                   | NOT OBSERVED    |
| US-107 | 2   | P0       | AI   | EP-01 | —          | Not started                            | NOT OBSERVED    |
| US-108 | 2   | P0       | OPS  | EP-01 | US-103     | Done (PR #5 merged)                    | NOT OBSERVED    |
| US-109 | 1   | P0       | ALL  | EP-01 | —          | In Progress (PR #13 draft, not merged) | NOT OBSERVED    |
| US-111 | 5   | P0       | OPS  | EP-02 | US-103     | Done (PR #2 merged)                    | NOT OBSERVED    |
| US-112 | 3   | P0       | OPS  | EP-02 | US-111     | Done (PR #4 merged)                    | NOT OBSERVED    |
| US-114 | 5   | P0       | OPS  | EP-02 | US-111     | Done (PR #5 merged)                    | NOT OBSERVED    |
| US-120 | 2   | P0       | BE   | EP-03 | US-104     | Done (PR #7 merged)                    | NOT OBSERVED    |
| US-121 | 3   | P0       | FE   | EP-03 | US-111     | Done (PR #10 merged)                   | NOT OBSERVED    |
| US-122 | 3   | P0       | BE   | EP-04 | US-120     | Done (PR #8 merged)                    | NOT OBSERVED    |
| US-124 | 2   | P0       | FE   | EP-04 | US-121     | Done (PR #11 merged)                   | NOT OBSERVED    |
| US-126 | 3   | P0       | MM   | EP-04 | US-111     | Done (PR #9 merged)                    | NOT OBSERVED    |

Sprint 1 total: **50 SP**. Seen total: **NOT OBSERVED**.

## Sprint 2

| ID     | SP  | Priority | Lane | Epic  | Depends on             | Merged pull request | Seen on project |
| ------ | --- | -------- | ---- | ----- | ---------------------- | ------------------- | --------------- |
| US-110 | 3   | P0       | AI   | EP-01 | US-101                 | Not started         | NOT OBSERVED    |
| US-113 | 3   | P0       | OPS  | EP-02 | US-112, US-114         | Not started         | NOT OBSERVED    |
| US-115 | 3   | P0       | OPS  | EP-02 | US-114                 | Not started         | NOT OBSERVED    |
| US-116 | 3   | P0       | OPS  | EP-02 | US-111                 | Not started         | NOT OBSERVED    |
| US-117 | 2   | P0       | OPS  | EP-02 | US-116, US-126, US-124 | Not started         | NOT OBSERVED    |
| US-118 | 5   | P0       | BE   | EP-03 | US-120                 | Not started         | NOT OBSERVED    |
| US-119 | 3   | P0       | FE   | EP-03 | US-118, US-121         | Not started         | NOT OBSERVED    |
| US-123 | 3   | P1       | FE   | EP-04 | US-122                 | Not started         | NOT OBSERVED    |
| US-125 | 3   | P0       | FE   | EP-04 | US-128, US-124         | Not started         | NOT OBSERVED    |
| US-127 | 5   | P0       | MM   | EP-04 | US-126, US-129         | Not started         | NOT OBSERVED    |
| US-128 | 5   | P0       | MM   | EP-04 | US-126, US-129         | Not started         | NOT OBSERVED    |
| US-129 | 5   | P0       | BE   | EP-05 | US-114                 | Not started         | NOT OBSERVED    |
| US-130 | 3   | P0       | GEN  | EP-05 | US-129                 | Not started         | NOT OBSERVED    |
| US-131 | 2   | P0       | FE   | EP-05 | US-130                 | Not started         | NOT OBSERVED    |

Sprint 2 total: **48 SP**. Seen total: **NOT OBSERVED**.

## After the project exists

For each row, record the GitHub issue number and confirm:

- The title starts with the story id.
- Story Points equal the SP column.
- Priority and Lane equal the columns.
- The epic issue exists and the body names it.
- Depends on matches the column.
- Status matches the merged-pull-request column, unless a newer merged pull request has changed it.
- Assignee is empty until a lane owner is confirmed.

US-109 moves to Done only when this pull request is merged. Approving the pull request does not by itself approve the working agreements.
