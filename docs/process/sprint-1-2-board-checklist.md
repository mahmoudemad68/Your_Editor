# Sprint 1 and Sprint 2 board checklist

Expected ids, points, lanes, epics, and dependencies come from `docs/roadmap/export/backlog-full.csv`. They match the YAML backlog. This checklist does not change them.

GitHub is the active tracker. `jira-import.csv` is a legacy generated export and is not imported.

**GitHub Project: not created.** On 2026-10-02, `cursor[bot]` could not create a Project for `mahmoudemad68` (`createProjectV2` permission denied). No issues were created. Every "Seen on project" cell is `NOT OBSERVED`. US-109 AC1 stays **BLOCKED** until the cards are visible and lane owners are confirmed.

Two columns are different facts. **Implementation PR** records whether the change that implemented the story is on `main`. **Story acceptance** records whether the acceptance criteria and the Definition of Done are satisfied. A merged pull request does not establish story acceptance. A story id that only appears as a dependency is not an implementation.

When the card is created later, do not move a merged implementation back to Backlog. Do not set its Status to Done until story acceptance is established. Until then the card stays In Review. US-106 is the explicit case: PR #12 merged the rendering spike, and CP1 remains **NOT_VERIFIED**.

Lane owners are **PENDING**. Lane is the single-select field. It is not an assignee.

Sprint 1 is 17 stories and 50 SP. Sprint 2 is 14 stories and 48 SP. Both totals are inside the 52 SP cap. Sprint 1 is above the 48 SP velocity baseline and stays as committed.

Parent epics to create for traceability, with no extra story points: `EP-01`, `EP-02`, `EP-03`, `EP-04`, `EP-05`.

## Sprint 1

| ID     | SP  | Priority | Lane | Epic  | Depends on | Implementation PR        | Story acceptance             | Seen on project |
| ------ | --- | -------- | ---- | ----- | ---------- | ------------------------ | ---------------------------- | --------------- |
| US-101 | 5   | P0       | ALL  | EP-01 | —          | Merged, PR #3            | Not established by the merge | NOT OBSERVED    |
| US-102 | 2   | P0       | ALL  | EP-01 | —          | Merged, PR #3            | Not established by the merge | NOT OBSERVED    |
| US-103 | 5   | P0       | BE   | EP-01 | —          | Merged, PR #2            | Not established by the merge | NOT OBSERVED    |
| US-104 | 2   | P0       | BE   | EP-01 | US-102     | Merged, PR #6            | Not established by the merge | NOT OBSERVED    |
| US-105 | 3   | P0       | AI   | EP-01 | —          | None                     | Not started                  | NOT OBSERVED    |
| US-106 | 2   | P0       | GEN  | EP-01 | —          | Merged, PR #12           | CP1 NOT_VERIFIED             | NOT OBSERVED    |
| US-107 | 2   | P0       | AI   | EP-01 | —          | None                     | Not started                  | NOT OBSERVED    |
| US-108 | 2   | P0       | OPS  | EP-01 | US-103     | Merged, PR #5            | Not established by the merge | NOT OBSERVED    |
| US-109 | 1   | P0       | ALL  | EP-01 | —          | Draft PR #13, not merged | AC1 BLOCKED, AC2 BLOCKED     | NOT OBSERVED    |
| US-111 | 5   | P0       | OPS  | EP-02 | US-103     | Merged, PR #2            | Not established by the merge | NOT OBSERVED    |
| US-112 | 3   | P0       | OPS  | EP-02 | US-111     | Merged, PR #4            | Not established by the merge | NOT OBSERVED    |
| US-114 | 5   | P0       | OPS  | EP-02 | US-111     | Merged, PR #5            | Not established by the merge | NOT OBSERVED    |
| US-120 | 2   | P0       | BE   | EP-03 | US-104     | Merged, PR #7            | Not established by the merge | NOT OBSERVED    |
| US-121 | 3   | P0       | FE   | EP-03 | US-111     | Merged, PR #10           | Not established by the merge | NOT OBSERVED    |
| US-122 | 3   | P0       | BE   | EP-04 | US-120     | Merged, PR #8            | Not established by the merge | NOT OBSERVED    |
| US-124 | 2   | P0       | FE   | EP-04 | US-121     | Merged, PR #11           | Not established by the merge | NOT OBSERVED    |
| US-126 | 3   | P0       | MM   | EP-04 | US-111     | Merged, PR #9            | Not established by the merge | NOT OBSERVED    |

Sprint 1 total: **50 SP**. Seen total: **NOT OBSERVED**.

## Sprint 2

| ID     | SP  | Priority | Lane | Epic  | Depends on             | Implementation PR | Story acceptance | Seen on project |
| ------ | --- | -------- | ---- | ----- | ---------------------- | ----------------- | ---------------- | --------------- |
| US-110 | 3   | P0       | AI   | EP-01 | US-101                 | None              | Not started      | NOT OBSERVED    |
| US-113 | 3   | P0       | OPS  | EP-02 | US-112, US-114         | None              | Not started      | NOT OBSERVED    |
| US-115 | 3   | P0       | OPS  | EP-02 | US-114                 | None              | Not started      | NOT OBSERVED    |
| US-116 | 3   | P0       | OPS  | EP-02 | US-111                 | None              | Not started      | NOT OBSERVED    |
| US-117 | 2   | P0       | OPS  | EP-02 | US-116, US-126, US-124 | None              | Not started      | NOT OBSERVED    |
| US-118 | 5   | P0       | BE   | EP-03 | US-120                 | None              | Not started      | NOT OBSERVED    |
| US-119 | 3   | P0       | FE   | EP-03 | US-118, US-121         | None              | Not started      | NOT OBSERVED    |
| US-123 | 3   | P1       | FE   | EP-04 | US-122                 | None              | Not started      | NOT OBSERVED    |
| US-125 | 3   | P0       | FE   | EP-04 | US-128, US-124         | None              | Not started      | NOT OBSERVED    |
| US-127 | 5   | P0       | MM   | EP-04 | US-126, US-129         | None              | Not started      | NOT OBSERVED    |
| US-128 | 5   | P0       | MM   | EP-04 | US-126, US-129         | None              | Not started      | NOT OBSERVED    |
| US-129 | 5   | P0       | BE   | EP-05 | US-114                 | None              | Not started      | NOT OBSERVED    |
| US-130 | 3   | P0       | GEN  | EP-05 | US-129                 | None              | Not started      | NOT OBSERVED    |
| US-131 | 2   | P0       | FE   | EP-05 | US-130                 | None              | Not started      | NOT OBSERVED    |

Sprint 2 total: **48 SP**. Seen total: **NOT OBSERVED**.

## After the project exists

For each row, record the GitHub issue number and confirm:

- The title starts with the story id.
- Story Points equal the SP column.
- Priority and Lane equal the columns.
- The epic issue exists and the body names it.
- Depends on matches the column.
- Implementation PR matches that column. Story acceptance matches that column. Do not set Status to Done from the implementation column alone.
- Assignee is empty until a lane owner is confirmed.

US-109 is not accepted while AC1 and AC2 are BLOCKED. Merging PR #13 would record the implementation. It would not by itself satisfy AC2, and approving the pull request does not approve the working agreements. US-106 stays short of story acceptance while CP1 is NOT_VERIFIED.
