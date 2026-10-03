"""Check the GitHub issue mapping against the generated backlog.

The YAML backlog remains the source of truth. GitHub Issues plus one GitHub
Project are the active tracker. export/jira-import.csv is a legacy file the
roadmap generator still writes. This script checks that legacy file only so it
cannot drift from backlog-full.csv. A passing run does not mean a GitHub
Project exists and does not mean a Jira import is required.
"""

from __future__ import annotations

import csv
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JIRA_PATH = ROOT / "docs" / "roadmap" / "export" / "jira-import.csv"
FULL_PATH = ROOT / "docs" / "roadmap" / "export" / "backlog-full.csv"

FIBONACCI = {"1", "2", "3", "5", "8", "13"}
PRIORITY_TO_JIRA = {"P0": "Highest", "P1": "High", "P2": "Medium", "P3": "Low"}
LANE_TO_COMPONENT = {
    "AI": "AI / Agent Engineer",
    "MM": "Multimedia Engineer",
    "GEN": "Generative Video / Remotion Engineer",
    "BE": "Backend Engineer",
    "FE": "Frontend Engineer",
    "OPS": "DevOps & QA (shared)",
    "ALL": "Whole team",
}
FULL_PARENT = {
    "Phase": "",
    "Epic": "Phase",
    "Feature": "Epic",
    "Story": "Feature",
    "Task": "Story",
}
JIRA_PARENT = {"Epic": "", "Story": "Epic", "Sub-task": "Story"}


def read_dicts(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def read_rows(path: Path) -> list[list[str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.reader(handle))


def main() -> int:
    errors: list[str] = []
    jira = read_dicts(JIRA_PATH)
    full = read_dicts(FULL_PATH)
    raw_jira = read_rows(JIRA_PATH)
    header = raw_jira[0]
    if header.count("Labels") != 4:
        errors.append(
            f"jira header should repeat Labels four times, found {header.count('Labels')}"
        )

    jira_ids = [row["Issue Id"] for row in jira]
    full_ids = [row["ID"] for row in full]
    for label, values in (("jira", jira_ids), ("full", full_ids)):
        duplicates = [item for item, count in Counter(values).items() if count > 1]
        if duplicates:
            errors.append(f"{label} duplicate ids: {duplicates[:8]}")

    jira_by_id = {row["Issue Id"]: row for row in jira}
    full_by_id = {row["ID"]: row for row in full}
    for row in jira:
        kind = row["Issue Type"]
        parent_kind = JIRA_PARENT.get(kind)
        if parent_kind is None:
            errors.append(f"{row['Issue Id']}: unknown Jira type {kind}")
            continue
        parent = row["Parent Id"]
        if parent_kind == "":
            if parent:
                errors.append(f"{row['Issue Id']}: epic has parent {parent}")
            continue
        if parent not in jira_by_id:
            errors.append(f"{row['Issue Id']}: missing parent {parent}")
        elif jira_by_id[parent]["Issue Type"] != parent_kind:
            errors.append(f"{row['Issue Id']}: parent {parent} is not a {parent_kind}")

    for row in full:
        kind = row["Type"]
        expected = FULL_PARENT.get(kind)
        if expected is None:
            errors.append(f"{row['ID']}: unknown type {kind}")
            continue
        parent = row["Parent ID"]
        if expected == "":
            if parent:
                errors.append(f"{row['ID']}: phase has parent {parent}")
            continue
        if parent not in full_by_id:
            errors.append(f"{row['ID']}: missing parent {parent}")
        elif full_by_id[parent]["Type"] != expected:
            errors.append(f"{row['ID']}: parent {parent} is not a {expected}")

    jira_stories = {
        row["Issue Id"]: row for row in jira if row["Issue Type"] == "Story"
    }
    full_stories = {row["ID"]: row for row in full if row["Type"] == "Story"}
    if set(jira_stories) != set(full_stories):
        errors.append("story ids differ between jira-import.csv and backlog-full.csv")

    label_indexes = [index for index, name in enumerate(header) if name == "Labels"]
    duplicate_label_rows = 0
    for row in raw_jira[1:]:
        labels = [
            row[index] for index in label_indexes if index < len(row) and row[index]
        ]
        if len(labels) != len(set(labels)):
            duplicate_label_rows += 1
            if duplicate_label_rows <= 5:
                errors.append(f"{row[0]}: duplicate labels {labels}")

    above_eight = 0
    for story_id, story in full_stories.items():
        jira_story = jira_stories.get(story_id)
        if jira_story is None:
            continue
        points = story["Story Points"]
        if points not in FIBONACCI:
            errors.append(
                f"{story_id}: story points {points} are outside the Fibonacci scale"
            )
        elif int(points) > 8 and story["Sprint"] != "Stretch":
            above_eight += 1
        if jira_story["Story Points"] != points:
            errors.append(
                f"{story_id}: points differ ({points} vs {jira_story['Story Points']})"
            )
        if jira_story["Parent Id"] != story["Epic"]:
            errors.append(f"{story_id}: Jira parent is not epic {story['Epic']}")
        component = LANE_TO_COMPONENT.get(story["Lane"])
        if component is None:
            errors.append(f"{story_id}: unknown lane {story['Lane']}")
        elif jira_story["Component/s"] != component:
            errors.append(
                f"{story_id}: component {jira_story['Component/s']} != {component}"
            )
        jira_priority = PRIORITY_TO_JIRA.get(story["Priority"])
        if jira_priority is None:
            errors.append(f"{story_id}: unknown priority {story['Priority']}")
        elif jira_story["Priority"] != jira_priority:
            errors.append(
                f"{story_id}: Jira priority {jira_story['Priority']} != {jira_priority}"
            )
        if story["Sprint"] == "Stretch":
            if jira_story["Sprint"]:
                errors.append(
                    f"{story_id}: stretch story has Jira sprint {jira_story['Sprint']}"
                )
        elif jira_story["Sprint"] != story["Sprint"]:
            errors.append(
                f"{story_id}: sprint {story['Sprint']} != {jira_story['Sprint']}"
            )
        dependencies = [item for item in story["Depends On"].split(";") if item]
        if dependencies:
            expected = "Depends on: " + ", ".join(dependencies)
            if expected not in jira_story["Description"]:
                errors.append(f"{story_id}: Jira description is missing {expected}")
            for dependency in dependencies:
                if dependency not in full_stories:
                    errors.append(f"{story_id}: depends on unknown story {dependency}")

    for row in jira:
        if row["Issue Type"] != "Sub-task":
            continue
        if row["Story Points"].strip():
            errors.append(f"{row['Issue Id']}: sub-task carries story points")
        parent = jira_by_id.get(row["Parent Id"])
        if parent and parent["Sprint"] != row["Sprint"]:
            errors.append(f"{row['Issue Id']}: sprint differs from its story")
        if parent and parent["Component/s"] != row["Component/s"]:
            errors.append(f"{row['Issue Id']}: component differs from its story")

    expected_sprints = {1: (17, 50), 2: (14, 48)}
    parent_epics: set[str] = set()
    for number, (expected_count, expected_points) in expected_sprints.items():
        stories = [
            row for row in full_stories.values() if row["Sprint"] == f"Sprint {number}"
        ]
        points = sum(int(row["Story Points"]) for row in stories)
        print(f"Sprint {number}: {len(stories)} stories, {points} SP")
        if (len(stories), points) != (expected_count, expected_points):
            errors.append(
                f"Sprint {number}: expected {expected_count} stories and "
                f"{expected_points} SP, found {len(stories)} and {points}"
            )
        for story in stories:
            story_id = story["ID"]
            parent_epics.add(story["Epic"])
            if not story["Title"].strip():
                errors.append(f"{story_id}: missing title")
            if "Acceptance criteria:" not in story["Description"]:
                errors.append(f"{story_id}: description has no acceptance criteria")
            if story["Lane"] not in LANE_TO_COMPONENT:
                errors.append(f"{story_id}: lane {story['Lane']} is not a GitHub lane")
            if story["Priority"] not in PRIORITY_TO_JIRA:
                errors.append(f"{story_id}: priority {story['Priority']} is not mapped")
            if (
                story["Epic"] not in full_by_id
                or full_by_id[story["Epic"]]["Type"] != "Epic"
            ):
                errors.append(f"{story_id}: epic {story['Epic']} is missing")
            for dependency in [item for item in story["Depends On"].split(";") if item]:
                if dependency not in full_stories:
                    errors.append(f"{story_id}: depends on unknown story {dependency}")

    print(f"sprint 1-2 parent epics: {', '.join(sorted(parent_epics))}")
    print(f"legacy jira rows: {len(jira)}")
    print(f"full rows: {len(full)}")
    print(f"stories: {len(full_stories)}")
    print(f"scheduled stories above 8 SP: {above_eight}")
    print(f"rows with duplicate labels: {duplicate_label_rows}")
    if errors:
        print(f"FAILED {len(errors)}")
        for error in errors:
            print(f"- {error}")
        return 1
    print("ACTIVE_TRACKER: github")
    print("LEGACY_JIRA_EXPORT: consistent, not the active tracker")
    print("GITHUB_MAPPING: PASS")
    print("GITHUB_PROJECT: NOT_OBSERVED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
