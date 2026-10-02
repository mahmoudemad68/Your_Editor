# Sprint 1 and Sprint 2 board checklist

Expected values come from `docs/roadmap/export/backlog-full.csv` and `docs/roadmap/export/jira-import.csv`. They match
the YAML backlog. This checklist does not change them.

**Tracker observation: `TRACKER_SETUP_PENDING`.** Every "Seen on board" cell is `NOT OBSERVED`. Do not mark a cell
passed from this file alone. After the import in [tracker-import.md](tracker-import.md), replace `NOT OBSERVED` with
what Jira shows, including the issue key.

Jira parent is the epic. Feature id is a label, not the Jira parent. Component is the lane name, not a person.
Person assignees stay empty until [team-approval-record.md](team-approval-record.md) names them.

`P0` maps to Jira priority Highest. `P1` maps to High. Sprint 1 is 17 stories and 50 SP. Sprint 2 is 14 stories and
48 SP. Both totals are inside the 52 SP cap. Sprint 1 is above the 48 SP velocity baseline and remains as committed.

## Sprint 1

| ID     | SP  | Priority     | Lane | Component                            | Depends on | Jira parent | Feature | Seen on board |
| ------ | --- | ------------ | ---- | ------------------------------------ | ---------- | ----------- | ------- | ------------- |
| US-101 | 5   | P0 / Highest | ALL  | Whole team                           | —          | EP-01       | FT-01.1 | NOT OBSERVED  |
| US-102 | 2   | P0 / Highest | ALL  | Whole team                           | —          | EP-01       | FT-01.1 | NOT OBSERVED  |
| US-103 | 5   | P0 / Highest | BE   | Backend Engineer                     | —          | EP-01       | FT-01.2 | NOT OBSERVED  |
| US-104 | 2   | P0 / Highest | BE   | Backend Engineer                     | US-102     | EP-01       | FT-01.2 | NOT OBSERVED  |
| US-105 | 3   | P0 / Highest | AI   | AI / Agent Engineer                  | —          | EP-01       | FT-01.3 | NOT OBSERVED  |
| US-106 | 2   | P0 / Highest | GEN  | Generative Video / Remotion Engineer | —          | EP-01       | FT-01.3 | NOT OBSERVED  |
| US-107 | 2   | P0 / Highest | AI   | AI / Agent Engineer                  | —          | EP-01       | FT-01.3 | NOT OBSERVED  |
| US-108 | 2   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-103     | EP-01       | FT-01.3 | NOT OBSERVED  |
| US-109 | 1   | P0 / Highest | ALL  | Whole team                           | —          | EP-01       | FT-01.4 | NOT OBSERVED  |
| US-111 | 5   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-103     | EP-02       | FT-02.1 | NOT OBSERVED  |
| US-112 | 3   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-111     | EP-02       | FT-02.2 | NOT OBSERVED  |
| US-114 | 5   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-111     | EP-02       | FT-02.3 | NOT OBSERVED  |
| US-120 | 2   | P0 / Highest | BE   | Backend Engineer                     | US-104     | EP-03       | FT-03.2 | NOT OBSERVED  |
| US-121 | 3   | P0 / Highest | FE   | Frontend Engineer                    | US-111     | EP-03       | FT-03.2 | NOT OBSERVED  |
| US-122 | 3   | P0 / Highest | BE   | Backend Engineer                     | US-120     | EP-04       | FT-04.1 | NOT OBSERVED  |
| US-124 | 2   | P0 / Highest | FE   | Frontend Engineer                    | US-121     | EP-04       | FT-04.1 | NOT OBSERVED  |
| US-126 | 3   | P0 / Highest | MM   | Multimedia Engineer                  | US-111     | EP-04       | FT-04.2 | NOT OBSERVED  |

Sprint 1 total: **50 SP**. Seen total: **NOT OBSERVED**.

## Sprint 2

| ID     | SP  | Priority     | Lane | Component                            | Depends on             | Jira parent | Feature | Seen on board |
| ------ | --- | ------------ | ---- | ------------------------------------ | ---------------------- | ----------- | ------- | ------------- |
| US-110 | 3   | P0 / Highest | AI   | AI / Agent Engineer                  | US-101                 | EP-01       | FT-01.3 | NOT OBSERVED  |
| US-113 | 3   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-112, US-114         | EP-02       | FT-02.2 | NOT OBSERVED  |
| US-115 | 3   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-114                 | EP-02       | FT-02.3 | NOT OBSERVED  |
| US-116 | 3   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-111                 | EP-02       | FT-02.4 | NOT OBSERVED  |
| US-117 | 2   | P0 / Highest | OPS  | DevOps & QA (shared)                 | US-116, US-126, US-124 | EP-02       | FT-02.4 | NOT OBSERVED  |
| US-118 | 5   | P0 / Highest | BE   | Backend Engineer                     | US-120                 | EP-03       | FT-03.1 | NOT OBSERVED  |
| US-119 | 3   | P0 / Highest | FE   | Frontend Engineer                    | US-118, US-121         | EP-03       | FT-03.1 | NOT OBSERVED  |
| US-123 | 3   | P1 / High    | FE   | Frontend Engineer                    | US-122                 | EP-04       | FT-04.1 | NOT OBSERVED  |
| US-125 | 3   | P0 / Highest | FE   | Frontend Engineer                    | US-128, US-124         | EP-04       | FT-04.1 | NOT OBSERVED  |
| US-127 | 5   | P0 / Highest | MM   | Multimedia Engineer                  | US-126, US-129         | EP-04       | FT-04.2 | NOT OBSERVED  |
| US-128 | 5   | P0 / Highest | MM   | Multimedia Engineer                  | US-126, US-129         | EP-04       | FT-04.2 | NOT OBSERVED  |
| US-129 | 5   | P0 / Highest | BE   | Backend Engineer                     | US-114                 | EP-05       | FT-05.1 | NOT OBSERVED  |
| US-130 | 3   | P0 / Highest | GEN  | Generative Video / Remotion Engineer | US-129                 | EP-05       | FT-05.1 | NOT OBSERVED  |
| US-131 | 2   | P0 / Highest | FE   | Frontend Engineer                    | US-130                 | EP-05       | FT-05.1 | NOT OBSERVED  |

Sprint 2 total: **48 SP**. Seen total: **NOT OBSERVED**.

## After import

For each row, record:

- The Jira issue key and the summary, which should start with the story id.
- Story points equal to the SP column.
- Sprint equal to Sprint 1 or Sprint 2.
- Component equal to the Component column.
- Parent epic equal to the Jira parent column.
- `Depends on:` in the description, then an issue link once that follow-up step is done.
- Assignee blank, unless the approval record has named that lane.

Also confirm sub-task `US-109-T4` exists, its parent is `US-109`, and its summary is
`Commit docs/process/working-agreements.md`.
