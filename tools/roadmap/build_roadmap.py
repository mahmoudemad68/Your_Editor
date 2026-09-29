#!/usr/bin/env python3
"""Validate the EditAgent backlog and render the roadmap documents and tracker exports.

Source of truth: docs/roadmap/backlog/*.yaml
Generated:       docs/roadmap/{phases/*.md,sprints.md,dependencies.md,milestones.md,export/*.csv}

Usage:
    python3 tools/roadmap/build_roadmap.py          # validate + write generated files
    python3 tools/roadmap/build_roadmap.py --check  # validate + fail if generated files are stale
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
from collections import defaultdict
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
ROADMAP_DIR = ROOT / "docs" / "roadmap"
DATA_DIR = ROADMAP_DIR / "backlog"

FIBONACCI = {1, 2, 3, 5, 8, 13}
STRETCH = "stretch"
TASK_TAG = re.compile(r"^\+(\w+)\s+(.*)$", re.DOTALL)
GENERATED_BANNER = (
    "<!-- GENERATED FILE - do not edit by hand. "
    "Edit docs/roadmap/backlog/*.yaml and run `python3 tools/roadmap/build_roadmap.py`. -->\n"
)


def natural_key(value: str):
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", value)]


def md_escape(text: str) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def anchor(text: str) -> str:
    slug = re.sub(r"[^\w\- ]", "", text.lower()).strip()
    return re.sub(r"[\s]+", "-", slug)


class Backlog:
    def __init__(self, plan: dict, phases: list[dict]):
        self.plan = plan
        self.meta = plan["meta"]
        self.lanes: dict[str, str] = plan["lanes"]
        self.priorities: dict[str, dict] = plan["priorities"]
        self.tags: dict[str, str] = plan["task_tags"]
        self.sprints: dict[int, dict] = {s["number"]: s for s in plan["sprints"]}
        self.milestones: list[dict] = plan["milestones"]
        self.phases = phases
        self.items: dict[str, dict] = {}
        self.epics: list[dict] = []
        self.features: list[dict] = []
        self.stories: list[dict] = []
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self._index()

    # ------------------------------------------------------------------ indexing

    def _register(self, item: dict, kind: str) -> None:
        item_id = item.get("id")
        if not item_id:
            self.errors.append(f"{kind} without id: {item.get('name') or item.get('title')}")
            return
        if item_id in self.items:
            self.errors.append(f"duplicate id {item_id}")
        item["_kind"] = kind
        self.items[item_id] = item

    def _index(self) -> None:
        for phase in self.phases:
            self._register(phase, "phase")
            for epic in phase.get("epics", []):
                epic["_phase"] = phase
                self._register(epic, "epic")
                self.epics.append(epic)
                for feature in epic.get("features", []):
                    feature["_phase"], feature["_epic"] = phase, epic
                    self._register(feature, "feature")
                    self.features.append(feature)
                    for story in feature.get("stories", []):
                        story["_phase"], story["_epic"], story["_feature"] = phase, epic, feature
                        self._register(story, "story")
                        self.stories.append(story)
        self.stories.sort(key=lambda s: natural_key(s["id"]))

    # ------------------------------------------------------------------ helpers

    def scheduled(self, story: dict) -> bool:
        return isinstance(story.get("sprint"), int)

    def stories_in_sprint(self, number: int) -> list[dict]:
        return [s for s in self.stories if s.get("sprint") == number]

    def stretch_stories(self) -> list[dict]:
        return [s for s in self.stories if s.get("sprint") == STRETCH]

    def epic_stories(self, epic: dict) -> list[dict]:
        return [s for f in epic["features"] for s in f["stories"]]

    def epic_sprints(self, epic: dict) -> list[int]:
        return sorted({s["sprint"] for s in self.epic_stories(epic) if self.scheduled(s)})

    def phase_stories(self, phase: dict) -> list[dict]:
        return [s for e in phase["epics"] for s in self.epic_stories(e)]

    def split_task(self, task: str) -> tuple[str | None, str]:
        match = TASK_TAG.match(task)
        if match and match.group(1) in self.tags:
            return match.group(1), match.group(2)
        return None, task

    def task_text(self, task: str) -> str:
        tag, text = self.split_task(task)
        return f"`{self.tags[tag]}` {text}" if tag else text

    def intra_sprint_deps(self, story: dict) -> list[str]:
        return [d for d in story.get("depends_on", []) if self.items.get(d, {}).get("sprint") == story.get("sprint")]

    def parallel_label(self, story: dict) -> str:
        if not self.scheduled(story):
            return "Stretch backlog"
        same = self.intra_sprint_deps(story)
        if same:
            return "Sequential after " + ", ".join(same) + " (same sprint; contract-first stubs allowed)"
        return "Parallel - can start on day 1 of the sprint"

    def sprint_label(self, story: dict) -> str:
        return f"Sprint {story['sprint']}" if self.scheduled(story) else "Stretch"

    def weeks(self, number: int) -> str:
        length = self.meta["sprint_length_weeks"]
        return f"Weeks {(number - 1) * length + 1}-{number * length}"

    def phase_file(self, phase: dict) -> str:
        return f"phases/{phase['file']}.md"

    def link(self, item_id: str, from_dir: str = "") -> str:
        """Markdown link to a phase/epic/feature/story heading, relative to docs/roadmap/<from_dir>."""
        item = self.items.get(item_id)
        if not item:
            return item_id
        phase = item if item["_kind"] == "phase" else item["_phase"]
        target = self.phase_file(phase)
        if from_dir == "phases":
            target = Path(target).name
        if item["_kind"] == "phase":
            return f"[{item_id}]({target})"
        title = item.get("title") or item.get("name")
        return f"[{item_id}]({target}#{anchor(f'{item_id} - {title}')})"

    # ------------------------------------------------------------------ graph analysis

    def story_deps(self, story: dict) -> list[dict]:
        return [self.items[d] for d in story.get("depends_on", []) if d in self.items]

    def epic_dependency_ids(self, epic: dict) -> tuple[list[str], list[str]]:
        explicit = list(epic.get("depends_on", []))
        derived = set()
        for story in self.epic_stories(epic):
            for dep in self.story_deps(story):
                if dep["_kind"] == "story" and dep["_epic"] is not epic:
                    derived.add(dep["_epic"]["id"])
        derived -= set(explicit)
        return explicit, sorted(derived, key=natural_key)

    def epic_closure(self) -> dict[str, set[str]]:
        direct = {}
        for epic in self.epics:
            explicit, derived = self.epic_dependency_ids(epic)
            direct[epic["id"]] = set(explicit) | set(derived)
        closure: dict[str, set[str]] = {}

        def visit(node: str, stack: set[str]) -> set[str]:
            if node in closure:
                return closure[node]
            if node in stack:
                return set()
            stack.add(node)
            result = set()
            for dep in direct.get(node, ()):
                result.add(dep)
                result |= visit(dep, stack)
            stack.discard(node)
            closure[node] = result
            return result

        for epic in self.epics:
            visit(epic["id"], set())
        return closure

    def epic_parallel_with(self, epic: dict, closure: dict[str, set[str]]) -> list[str]:
        sprints = set(self.epic_sprints(epic))
        result = []
        for other in self.epics:
            if other is epic or other["_phase"] is not epic["_phase"]:
                continue
            if not sprints & set(self.epic_sprints(other)):
                continue
            if other["id"] in closure[epic["id"]] or epic["id"] in closure[other["id"]]:
                continue
            result.append(other["id"])
        return result

    def critical_path(self) -> list[dict]:
        scheduled = [s for s in self.stories if self.scheduled(s)]
        order = sorted(scheduled, key=lambda s: (s["sprint"], natural_key(s["id"])))
        best: dict[str, tuple[int, list[dict]]] = {}
        for story in order:
            candidates = [best[d["id"]] for d in self.story_deps(story) if d["id"] in best]
            base_points, base_path = max(candidates, key=lambda c: c[0], default=(0, []))
            best[story["id"]] = (base_points + story["points"], base_path + [story])
        if not best:
            return []
        return max(best.values(), key=lambda c: (c[0], len(c[1])))[1]

    # ------------------------------------------------------------------ validation

    def validate(self) -> None:
        sprint_numbers = set(self.sprints)
        for phase in self.phases:
            for key in ("name", "objective", "sprints", "deliverables", "definition_of_done", "epics", "file"):
                if not phase.get(key):
                    self.errors.append(f"{phase.get('id')}: missing '{key}'")
            for sprint in phase.get("sprints", []):
                if sprint not in sprint_numbers:
                    self.errors.append(f"{phase['id']}: unknown sprint {sprint}")
            for dep in phase.get("depends_on", []):
                if self.items.get(dep, {}).get("_kind") != "phase":
                    self.errors.append(f"{phase['id']}: depends on unknown phase {dep}")

        for epic in self.epics:
            if not epic.get("features"):
                self.errors.append(f"{epic['id']}: epic has no features")
            for dep in epic.get("depends_on", []):
                if self.items.get(dep, {}).get("_kind") != "epic":
                    self.errors.append(f"{epic['id']}: depends on unknown epic {dep}")

        for feature in self.features:
            if not feature.get("stories"):
                self.errors.append(f"{feature['id']}: feature has no user stories")

        for story in self.stories:
            sid = story["id"]
            for key in ("title", "story", "priority", "points", "sprint", "lane", "tasks", "acceptance"):
                if key not in story:
                    self.errors.append(f"{sid}: missing '{key}'")
            if story.get("priority") not in self.priorities:
                self.errors.append(f"{sid}: unknown priority {story.get('priority')}")
            if story.get("points") not in FIBONACCI:
                self.errors.append(f"{sid}: points must be Fibonacci, got {story.get('points')}")
            if story.get("lane") not in self.lanes:
                self.errors.append(f"{sid}: unknown lane {story.get('lane')}")
            if not str(story.get("story", "")).startswith("As "):
                self.errors.append(f"{sid}: story must use 'As a ..., I want ..., so that ...' form")
            for key, minimum in (("tasks", 3), ("acceptance", 2)):
                values = story.get(key, [])
                if not isinstance(values, list) or len(values) < minimum:
                    self.errors.append(f"{sid}: needs at least {minimum} {key}")
                    continue
                for value in values:
                    if not isinstance(value, str):
                        self.errors.append(f"{sid}: {key} entry is not a string (quote it): {value!r}")
            tags = {self.split_task(t)[0] for t in story.get("tasks", []) if isinstance(t, str)}
            if not tags - {None} and story.get("lane") != "ALL":
                self.warnings.append(f"{sid}: no tagged verification task (+test, +sec, +ci, +doc or +int)")
            sprint = story.get("sprint")
            phase_sprints = story["_phase"].get("sprints", [])
            if sprint == STRETCH:
                if story.get("priority") not in ("P2", "P3"):
                    self.errors.append(f"{sid}: only P2/P3 stories may be left in the stretch backlog")
            elif sprint not in phase_sprints:
                self.errors.append(f"{sid}: sprint {sprint} is outside its phase sprints {phase_sprints}")
            for dep_id in story.get("depends_on", []):
                dep = self.items.get(dep_id)
                if not dep or dep["_kind"] != "story":
                    self.errors.append(f"{sid}: depends on unknown story {dep_id}")
                    continue
                if not self.scheduled(story):
                    continue
                if not self.scheduled(dep):
                    self.errors.append(f"{sid}: scheduled story depends on stretch story {dep_id}")
                elif dep["sprint"] > sprint:
                    self.errors.append(f"{sid} (Sprint {sprint}) depends on {dep_id} planned later (Sprint {dep['sprint']})")

        self._detect_cycles()

        for milestone in self.milestones:
            if milestone["sprint"] not in sprint_numbers:
                self.errors.append(f"{milestone['id']}: unknown sprint {milestone['sprint']}")
            for ref in milestone.get("requires", []):
                if ref not in self.items:
                    self.errors.append(f"{milestone['id']}: requires unknown item {ref}")
                elif self.items[ref]["_kind"] == "story" and self.scheduled(self.items[ref]):
                    if self.items[ref]["sprint"] > milestone["sprint"]:
                        self.errors.append(f"{milestone['id']}: requires {ref} which lands after the milestone")

        capacity = self.meta["capacity_max"]
        for number in self.sprints:
            total = sum(s["points"] for s in self.stories_in_sprint(number))
            if total > capacity:
                self.errors.append(f"Sprint {number}: {total} SP exceeds capacity_max {capacity}")
            if total == 0:
                self.errors.append(f"Sprint {number}: no stories planned")

    def _detect_cycles(self) -> None:
        state: dict[str, int] = {}

        def visit(sid: str, path: list[str]) -> None:
            state[sid] = 1
            for dep in self.items[sid].get("depends_on", []):
                if dep not in self.items:
                    continue
                if state.get(dep) == 1:
                    self.errors.append("dependency cycle: " + " -> ".join(path + [dep]))
                elif state.get(dep) is None:
                    visit(dep, path + [dep])
            state[sid] = 2

        for story in self.stories:
            if state.get(story["id"]) is None:
                visit(story["id"], [story["id"]])


# ====================================================================== rendering


def lane_points(backlog: Backlog, stories: list[dict]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for story in stories:
        totals[story["lane"]] += story["points"]
    return totals


def tag_counts(backlog: Backlog, stories: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for story in stories:
        for task in story["tasks"]:
            tag, _ = backlog.split_task(task)
            if tag:
                counts[tag] += 1
    return counts


def render_story(backlog: Backlog, story: dict) -> list[str]:
    out = [f"##### {story['id']} - {story['title']}", ""]
    deps = ", ".join(backlog.link(d, "phases") for d in story.get("depends_on", [])) or "None"
    priority = backlog.priorities[story["priority"]]["label"]
    out += [
        "| Priority | Points | Sprint | Lane (owner) | Depends on | Parallelism |",
        "|---|---|---|---|---|---|",
        f"| {story['priority']} - {priority} | {story['points']} | {backlog.sprint_label(story)} | "
        f"{backlog.lanes[story['lane']]} | {deps} | {md_escape(backlog.parallel_label(story))} |",
        "",
        f"**User story:** {story['story']}",
        "",
        "**Technical tasks**",
        "",
    ]
    for index, task in enumerate(story["tasks"], 1):
        out.append(f"- [ ] `{story['id']}-T{index}` {backlog.task_text(task)}")
    out += ["", "**Acceptance criteria**", ""]
    for index, criterion in enumerate(story["acceptance"], 1):
        out.append(f"- [ ] AC{index}. {criterion}")
    out.append("")
    return out


def render_phase(backlog: Backlog, phase: dict, closure: dict[str, set[str]]) -> str:
    stories = backlog.phase_stories(phase)
    scheduled = [s for s in stories if backlog.scheduled(s)]
    sprint_range = ", ".join(f"Sprint {n}" for n in phase["sprints"])
    first, last = phase["sprints"][0], phase["sprints"][-1]
    weeks = f"Weeks {backlog.weeks(first).split()[1].split('-')[0]}-{backlog.weeks(last).split('-')[1]}"
    milestones = [m for m in backlog.milestones if m["sprint"] in phase["sprints"]]

    out = [GENERATED_BANNER, f"# {phase['id']} - {phase['name']}", ""]
    out += [
        "| Sprints | Duration | Release / increment | Scope | Planned points | Milestones |",
        "|---|---|---|---|---|---|",
        f"| {sprint_range} | {weeks} | {phase['release']} | {phase['scope']} | "
        f"{sum(s['points'] for s in scheduled)} SP ({len(scheduled)} stories"
        f"{', ' + str(len(stories) - len(scheduled)) + ' stretch' if len(stories) != len(scheduled) else ''}) | "
        f"{', '.join(m['id'] + ' ' + m['name'] for m in milestones) or '-'} |",
        "",
        "[Roadmap overview](../README.md) | [Sprint plan](../sprints.md) | "
        "[Dependencies](../dependencies.md) | [Milestones](../milestones.md)",
        "",
        "## 1. Objective",
        "",
        phase["objective"].strip(),
        "",
        "## 2. Epics",
        "",
        "| Epic | Goal | Sprints | Points | Depends on | Can run in parallel with |",
        "|---|---|---|---|---|---|",
    ]
    for epic in phase["epics"]:
        explicit, derived = backlog.epic_dependency_ids(epic)
        deps = ", ".join(backlog.link(d, "phases") for d in explicit + derived) or "None"
        parallel = ", ".join(backlog.link(d, "phases") for d in backlog.epic_parallel_with(epic, closure)) or "-"
        points = sum(s["points"] for s in backlog.epic_stories(epic) if backlog.scheduled(s))
        sprints = ", ".join(f"S{n}" for n in backlog.epic_sprints(epic)) or "Stretch"
        out.append(
            f"| {backlog.link(epic['id'], 'phases')} {md_escape(epic['name'])} | {md_escape(epic['goal'])} | "
            f"{sprints} | {points} | {deps} | {parallel} |"
        )
    out += [
        "",
        "## 3-6. Features, User Stories, Technical Tasks and Acceptance Criteria",
        "",
        "Task tags: " + ", ".join(f"`{v}`" for v in backlog.tags.values())
        + " mark testing, documentation, CI/CD, security and integration work that is built into the story itself. "
        "Every story is also subject to the global [story Definition of Done](../README.md#definition-of-done-story-level).",
        "",
    ]
    for epic in phase["epics"]:
        out += [f"### {epic['id']} - {epic['name']}", "", f"**Epic goal:** {epic['goal']}", ""]
        for feature in epic["features"]:
            out += [f"#### {feature['id']} - {feature['name']}", ""]
            if feature.get("description"):
                out += [feature["description"].strip(), ""]
            for story in feature["stories"]:
                out += render_story(backlog, story)

    out += ["## 7. Dependencies", "", "### Phase-level", ""]
    for dep in phase.get("depends_on", []):
        out.append(f"- Depends on {backlog.link(dep, 'phases')} {backlog.items[dep]['name']}.")
    if not phase.get("depends_on"):
        out.append("- No upstream phase; this phase starts the project.")
    for note in phase.get("dependency_notes", []):
        out.append(f"- {note}")
    downstream = [p for p in backlog.phases if phase["id"] in p.get("depends_on", [])]
    for other in downstream:
        out.append(f"- Unblocks {backlog.link(other['id'], 'phases')} {other['name']}.")

    incoming = []
    for story in stories:
        for dep in backlog.story_deps(story):
            if dep["_phase"] is not phase:
                incoming.append((story, dep))
    out += ["", "### Cross-phase story dependencies (inputs from earlier phases)", ""]
    if incoming:
        out += ["| Story | Needs | From phase | Ready by |", "|---|---|---|---|"]
        for story, dep in incoming:
            out.append(
                f"| {backlog.link(story['id'], 'phases')} {md_escape(story['title'])} | "
                f"{backlog.link(dep['id'], 'phases')} {md_escape(dep['title'])} | {dep['_phase']['id']} | "
                f"{backlog.sprint_label(dep)} |"
            )
    else:
        out.append("None.")

    out += ["", "### Same-sprint sequencing (everything else in a sprint runs in parallel)", ""]
    chains = [(s, backlog.intra_sprint_deps(s)) for s in scheduled if backlog.intra_sprint_deps(s)]
    if chains:
        for story, deps in chains:
            out.append(f"- Sprint {story['sprint']}: {', '.join(deps)} -> {story['id']} {story['title']}")
    else:
        out.append("- None.")

    out += ["", "## 8. Sprint allocation", ""]
    lanes = list(backlog.lanes)
    out += [
        "| Sprint | Sprint goal | Stories | SP | " + " | ".join(lanes) + " |",
        "|---|---|---|---|" + "---|" * len(lanes),
    ]
    for number in phase["sprints"]:
        in_sprint = [s for s in scheduled if s["sprint"] == number]
        per_lane = lane_points(backlog, in_sprint)
        out.append(
            f"| [Sprint {number}](../sprints.md#sprint-{number}) | {md_escape(backlog.sprints[number]['goal'])} | "
            f"{', '.join(s['id'] for s in in_sprint)} | {sum(s['points'] for s in in_sprint)} | "
            + " | ".join(str(per_lane.get(lane, 0)) for lane in lanes)
            + " |"
        )
    stretch = [s for s in stories if not backlog.scheduled(s)]
    if stretch:
        out += ["", "Stretch backlog (pulled in only if capacity allows): " + ", ".join(s["id"] for s in stretch)]

    out += ["", "## 9. Deliverables", ""]
    out += [f"- {d}" for d in phase["deliverables"]]
    out += ["", "## 10. Definition of Done", ""]
    out.append("The phase is done when all of the following hold (in addition to the story-level DoD for every story):")
    out.append("")
    out += [f"- [ ] {d}" for d in phase["definition_of_done"]]
    if milestones:
        out += ["", "### Milestone exit criteria", ""]
        for milestone in milestones:
            out.append(f"**{milestone['id']} - {milestone['name']}** (end of Sprint {milestone['sprint']})")
            out.append("")
            out += [f"- [ ] {c}" for c in milestone["exit_criteria"]]
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def render_sprints(backlog: Backlog) -> str:
    lanes = list(backlog.lanes)
    velocity = backlog.meta["velocity"]
    out = [GENERATED_BANNER, "# Sprint Plan", ""]
    out += [
        f"{len(backlog.sprints)} sprints x {backlog.meta['sprint_length_weeks']} weeks. Planning velocity "
        f"{velocity} SP per sprint (hard cap {backlog.meta['capacity_max']} SP). Each sprint ends with a working, "
        "demonstrable, tested increment merged to `main` and deployed to the shared staging environment.",
        "",
        "[Roadmap overview](README.md) | [Dependencies](dependencies.md) | [Milestones](milestones.md)",
        "",
        "## Summary",
        "",
        "| Sprint | Weeks | Phase | Sprint goal | SP | Milestone |",
        "|---|---|---|---|---|---|",
    ]
    for number, sprint in backlog.sprints.items():
        points = sum(s["points"] for s in backlog.stories_in_sprint(number))
        milestone = ", ".join(m["id"] for m in backlog.milestones if m["sprint"] == number) or "-"
        out.append(
            f"| [{number}](#sprint-{number}) | {backlog.weeks(number).replace('Weeks ', '')} | "
            f"{backlog.link(sprint['phase'])} | {md_escape(sprint['goal'])} | {points} | {milestone} |"
        )
    out += [
        "",
        "## Parallel workstreams at a glance",
        "",
        "Each row is a lane (primary owner). Stories in the same column but different rows run in parallel; "
        "the few same-sprint sequences are listed per sprint below.",
        "",
        "| Lane | " + " | ".join(f"S{n}" for n in backlog.sprints) + " |",
        "|---|" + "---|" * len(backlog.sprints),
    ]
    for lane in lanes:
        cells = []
        for number in backlog.sprints:
            ids = [s["id"] for s in backlog.stories_in_sprint(number) if s["lane"] == lane]
            cells.append("<br>".join(ids) or "-")
        out.append(f"| {lane} | " + " | ".join(cells) + " |")
    out.append("")

    for number, sprint in backlog.sprints.items():
        stories = backlog.stories_in_sprint(number)
        per_lane = lane_points(backlog, stories)
        tags = tag_counts(backlog, stories)
        milestones = [m for m in backlog.milestones if m["sprint"] == number]
        phase = backlog.items[sprint["phase"]]
        out += [
            f'<a id="sprint-{number}"></a>',
            "",
            f"## Sprint {number} - {sprint['title']}",
            "",
            f"**{backlog.weeks(number)}** | Phase {backlog.link(phase['id'])} {phase['name']} | "
            f"Committed {sum(s['points'] for s in stories)} SP / velocity {velocity} SP",
            "",
            f"**Sprint goal:** {sprint['goal']}",
            "",
            f"**Working increment (Sprint Review demo):** {sprint['increment']}",
            "",
            "**Expected deliverables**",
            "",
        ]
        out += [f"- {d}" for d in sprint["deliverables"]]
        if milestones:
            out += ["", "**Milestones and checkpoints closed in this sprint**", ""]
            out += [f"- [{m['id']} - {m['name']}](milestones.md#{m['id'].lower()}) ({m['type']})" for m in milestones]
        out += [
            "",
            "**Sprint backlog**",
            "",
            "| Story | Epic | Lane | SP | Priority | Depends on | Start |",
            "|---|---|---|---|---|---|---|",
        ]
        for story in sorted(stories, key=lambda s: (lanes.index(s["lane"]), natural_key(s["id"]))):
            deps = ", ".join(story.get("depends_on", [])) or "-"
            same = backlog.intra_sprint_deps(story)
            start = "After " + ", ".join(same) if same else "Day 1 (parallel)"
            out.append(
                f"| {backlog.link(story['id'])} {md_escape(story['title'])} | {story['_epic']['id']} | {story['lane']} | "
                f"{story['points']} | {story['priority']} | {deps} | {start} |"
            )
        out += ["", "**Parallel workstreams**", ""]
        for lane in lanes:
            ids = [s["id"] for s in stories if s["lane"] == lane]
            if ids:
                out.append(f"- **{lane}** ({backlog.lanes[lane]}, {per_lane[lane]} SP): {', '.join(ids)}")
        chains = [(s, backlog.intra_sprint_deps(s)) for s in stories if backlog.intra_sprint_deps(s)]
        out += ["", "**Same-sprint sequencing**", ""]
        if chains:
            out += [f"- {', '.join(d)} -> {s['id']}" for s, d in chains]
            out.append("- Downstream work starts against the agreed contract (schema/OpenAPI/stub) and integrates when the upstream story merges.")
        else:
            out.append("- None - every story in this sprint can start on day 1.")
        out += [
            "",
            "**Built-in quality work this sprint** (tagged technical tasks): "
            + ", ".join(f"{backlog.tags[t]} x{tags.get(t, 0)}" for t in backlog.tags),
            "",
        ]
        if sprint.get("risks"):
            out += ["**Sprint risks and mitigations**", ""]
            out += [f"- {r}" for r in sprint["risks"]]
            out.append("")

    stretch = backlog.stretch_stories()
    if stretch:
        out += [
            "## Stretch backlog",
            "",
            "Not committed to any sprint. Pulled in only when a sprint finishes early or the team has 6 members.",
            "",
            "| Story | Epic | Lane | SP | Priority | Depends on |",
            "|---|---|---|---|---|---|",
        ]
        for story in stretch:
            out.append(
                f"| {backlog.link(story['id'])} {md_escape(story['title'])} | {story['_epic']['id']} | {story['lane']} | "
                f"{story['points']} | {story['priority']} | {', '.join(story.get('depends_on', [])) or '-'} |"
            )
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def render_dependencies(backlog: Backlog, closure: dict[str, set[str]]) -> str:
    out = [GENERATED_BANNER, "# Dependency Map", ""]
    out += ["[Roadmap overview](README.md) | [Sprint plan](sprints.md) | [Milestones](milestones.md)", ""]
    out += ["## Phase dependencies", "", "```mermaid", "flowchart LR"]
    for phase in backlog.phases:
        sprints = f"S{phase['sprints'][0]}-S{phase['sprints'][-1]}"
        out.append(f'    {phase["id"]}["{phase["id"]} {phase["name"]}<br/>{sprints}"]')
    for phase in backlog.phases:
        for dep in phase.get("depends_on", []):
            out.append(f"    {dep} --> {phase['id']}")
    out += ["```", "", "## Epic dependencies", "", "```mermaid", "flowchart LR"]
    for phase in backlog.phases:
        out.append(f'    subgraph {phase["id"]}["{phase["id"]} {phase["name"]}"]')
        for epic in phase["epics"]:
            sprints = backlog.epic_sprints(epic)
            label = f"S{sprints[0]}-S{sprints[-1]}" if sprints else "stretch"
            name = epic["name"].replace('"', "'")
            out.append(f'        {epic["id"].replace("-", "")}["{epic["id"]} {name}<br/>{label}"]')
        out.append("    end")
    for epic in backlog.epics:
        explicit, derived = backlog.epic_dependency_ids(epic)
        for dep in explicit:
            out.append(f"    {dep.replace('-', '')} --> {epic['id'].replace('-', '')}")
        for dep in derived:
            out.append(f"    {dep.replace('-', '')} -.-> {epic['id'].replace('-', '')}")
    out += ["```", "", "Solid arrows are declared epic dependencies; dotted arrows are derived from story-level dependencies.", ""]

    out += ["## Epic dependency and parallelism table", "", "| Epic | Phase | Sprints | Depends on (declared) | Depends on (derived from stories) | Parallel with |", "|---|---|---|---|---|---|"]
    for epic in backlog.epics:
        explicit, derived = backlog.epic_dependency_ids(epic)
        sprints = ", ".join(f"S{n}" for n in backlog.epic_sprints(epic)) or "Stretch"
        out.append(
            f"| {backlog.link(epic['id'])} {md_escape(epic['name'])} | {epic['_phase']['id']} | {sprints} | "
            f"{', '.join(explicit) or '-'} | {', '.join(derived) or '-'} | "
            f"{', '.join(backlog.epic_parallel_with(epic, closure)) or '-'} |"
        )

    path = backlog.critical_path()
    out += [
        "",
        "## Critical path",
        "",
        "Longest chain of dependent stories weighted by story points. Any slip on these stories moves the final "
        "milestone; they get first pick of reviewers and are never left unassigned at sprint start.",
        "",
        "| # | Story | Sprint | SP | Lane |",
        "|---|---|---|---|---|",
    ]
    for index, story in enumerate(path, 1):
        out.append(
            f"| {index} | {backlog.link(story['id'])} {md_escape(story['title'])} | {story['sprint']} | {story['points']} | {story['lane']} |"
        )
    out += [
        "",
        "## Story dependency register",
        "",
        "| Story | Sprint | Depends on | Dependency sprint | Type |",
        "|---|---|---|---|---|",
    ]
    for story in backlog.stories:
        for dep in backlog.story_deps(story):
            if not backlog.scheduled(story):
                kind = "stretch"
            elif dep["sprint"] == story["sprint"]:
                kind = "same sprint (sequential)"
            elif dep["_phase"] is not story["_phase"]:
                kind = "cross-phase"
            else:
                kind = "earlier sprint"
            out.append(
                f"| {backlog.link(story['id'])} {md_escape(story['title'])} | {backlog.sprint_label(story)} | "
                f"{backlog.link(dep['id'])} {md_escape(dep['title'])} | {backlog.sprint_label(dep)} | {kind} |"
            )
    return "\n".join(out).rstrip() + "\n"


def render_milestones(backlog: Backlog) -> str:
    out = [GENERATED_BANNER, "# Milestones and Checkpoints", ""]
    out += [
        "Milestones are release-level outcomes reviewed with the supervisor at Sprint Review. Checkpoints are "
        "technical gates the team verifies internally; failing a checkpoint triggers the listed fallback instead of "
        "silently slipping the schedule.",
        "",
        "[Roadmap overview](README.md) | [Sprint plan](sprints.md) | [Dependencies](dependencies.md)",
        "",
        "| ID | Name | Type | End of | Phase |",
        "|---|---|---|---|---|",
    ]
    for m in backlog.milestones:
        phase = backlog.sprints[m["sprint"]]["phase"]
        out.append(f"| [{m['id']}](#{m['id'].lower()}) | {md_escape(m['name'])} | {m['type']} | Sprint {m['sprint']} ({backlog.weeks(m['sprint'])}) | {phase} |")
    out.append("")
    for m in backlog.milestones:
        out += [f'<a id="{m["id"].lower()}"></a>', "", f"## {m['id']} - {m['name']}", ""]
        out.append(f"**Type:** {m['type']} | **Due:** end of Sprint {m['sprint']} ({backlog.weeks(m['sprint'])})")
        out += ["", "**Exit criteria**", ""]
        out += [f"- [ ] {c}" for c in m["exit_criteria"]]
        if m.get("requires"):
            out += ["", "**Requires:** " + ", ".join(backlog.link(r) for r in m["requires"])]
        if m.get("fallback"):
            out += ["", f"**If missed:** {m['fallback']}"]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def story_description(backlog: Backlog, story: dict) -> str:
    lines = [story["story"], "", "Acceptance criteria:"]
    lines += [f"- {c}" for c in story["acceptance"]]
    lines += ["", "Technical tasks:"]
    lines += [f"- {backlog.task_text(t)}" for t in story["tasks"]]
    if story.get("depends_on"):
        lines += ["", "Depends on: " + ", ".join(story["depends_on"])]
    lines += ["", f"Parallelism: {backlog.parallel_label(story)}"]
    return "\n".join(lines)


def render_full_csv(backlog: Backlog) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["ID", "Type", "Parent ID", "Title", "Description", "Phase", "Epic", "Feature", "Sprint",
                     "Lane", "Priority", "Story Points", "Depends On", "Parallel", "Labels"])
    for phase in backlog.phases:
        writer.writerow([phase["id"], "Phase", "", phase["name"], phase["objective"].strip(), phase["id"], "", "",
                         ";".join(f"Sprint {n}" for n in phase["sprints"]), "", "", "",
                         ";".join(phase.get("depends_on", [])), "", phase["scope"]])
        for epic in phase["epics"]:
            explicit, derived = backlog.epic_dependency_ids(epic)
            writer.writerow([epic["id"], "Epic", phase["id"], epic["name"], epic["goal"], phase["id"], epic["id"], "",
                             ";".join(f"Sprint {n}" for n in backlog.epic_sprints(epic)), "", "", "",
                             ";".join(explicit + derived), "", phase["scope"]])
            for feature in epic["features"]:
                writer.writerow([feature["id"], "Feature", epic["id"], feature["name"], feature.get("description", "").strip(),
                                 phase["id"], epic["id"], feature["id"], "", "", "", "", "", "", phase["scope"]])
                for story in feature["stories"]:
                    labels = [phase["scope"], story["lane"].lower(), story["priority"]]
                    if story.get("sprint") == STRETCH:
                        labels.append("stretch")
                    writer.writerow([story["id"], "Story", feature["id"], story["title"], story_description(backlog, story),
                                     phase["id"], epic["id"], feature["id"], backlog.sprint_label(story),
                                     story["lane"], story["priority"], story["points"],
                                     ";".join(story.get("depends_on", [])), backlog.parallel_label(story), ";".join(labels)])
                    for index, task in enumerate(story["tasks"], 1):
                        tag, text = backlog.split_task(task)
                        writer.writerow([f"{story['id']}-T{index}", "Task", story["id"], text, "", phase["id"], epic["id"],
                                         feature["id"], backlog.sprint_label(story), story["lane"], story["priority"], "",
                                         "", "", backlog.tags[tag].lower() if tag else ""])
    return buffer.getvalue()


def render_jira_csv(backlog: Backlog) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["Issue Id", "Parent Id", "Issue Type", "Summary", "Description", "Priority", "Story Points",
                     "Sprint", "Component/s", "Labels", "Labels", "Labels", "Labels"])
    for epic in backlog.epics:
        phase = epic["_phase"]
        writer.writerow([epic["id"], "", "Epic", f"{epic['id']} {epic['name']}", epic["goal"], "", "", "",
                         "", phase["id"], phase["scope"], "", ""])
        for feature in epic["features"]:
            for story in feature["stories"]:
                priority = backlog.priorities[story["priority"]]["jira"]
                sprint = backlog.sprint_label(story) if backlog.scheduled(story) else ""
                writer.writerow([story["id"], epic["id"], "Story", f"{story['id']} {story['title']}",
                                 story_description(backlog, story), priority, story["points"], sprint,
                                 backlog.lanes[story["lane"]], phase["id"], feature["id"], story["priority"],
                                 "stretch" if not sprint else phase["scope"]])
                for index, task in enumerate(story["tasks"], 1):
                    tag, text = backlog.split_task(task)
                    writer.writerow([f"{story['id']}-T{index}", story["id"], "Sub-task", text[:250], text, priority, "",
                                     sprint, backlog.lanes[story["lane"]], phase["id"],
                                     backlog.tags[tag].lower() if tag else "", "", ""])
    return buffer.getvalue()


def render_all(backlog: Backlog) -> dict[Path, str]:
    closure = backlog.epic_closure()
    files = {
        ROADMAP_DIR / "sprints.md": render_sprints(backlog),
        ROADMAP_DIR / "dependencies.md": render_dependencies(backlog, closure),
        ROADMAP_DIR / "milestones.md": render_milestones(backlog),
        ROADMAP_DIR / "export" / "backlog-full.csv": render_full_csv(backlog),
        ROADMAP_DIR / "export" / "jira-import.csv": render_jira_csv(backlog),
    }
    for phase in backlog.phases:
        files[ROADMAP_DIR / backlog.phase_file(phase)] = render_phase(backlog, phase, closure)
    return files


def load_backlog() -> Backlog:
    plan = yaml.safe_load((DATA_DIR / "plan.yaml").read_text(encoding="utf-8"))
    phases = [yaml.safe_load((DATA_DIR / "phases" / name).read_text(encoding="utf-8")) for name in plan["phase_files"]]
    return Backlog(plan, phases)


def summary(backlog: Backlog) -> str:
    lanes = list(backlog.lanes)
    rows = ["Sprint  SP  " + "  ".join(f"{lane:>4}" for lane in lanes)]
    for number in backlog.sprints:
        stories = backlog.stories_in_sprint(number)
        per_lane = lane_points(backlog, stories)
        rows.append(f"{number:>6} {sum(s['points'] for s in stories):>3}  "
                    + "  ".join(f"{per_lane.get(lane, 0):>4}" for lane in lanes))
    scheduled = [s for s in backlog.stories if backlog.scheduled(s)]
    rows.append(
        f"{len(backlog.phases)} phases, {len(backlog.epics)} epics, {len(backlog.features)} features, "
        f"{len(backlog.stories)} stories ({len(scheduled)} scheduled), "
        f"{sum(len(s['tasks']) for s in backlog.stories)} tasks, {sum(s['points'] for s in scheduled)} SP scheduled"
    )
    return "\n".join(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail if generated files are out of date")
    parser.add_argument("--quiet", action="store_true", help="only print problems")
    args = parser.parse_args()

    backlog = load_backlog()
    backlog.validate()
    for warning in backlog.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if backlog.errors:
        for error in backlog.errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    files = render_all(backlog)
    stale = []
    for path, content in files.items():
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                stale.append(path.relative_to(ROOT))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    if stale:
        print("error: generated roadmap files are stale; run python3 tools/roadmap/build_roadmap.py", file=sys.stderr)
        for path in stale:
            print(f"  {path}", file=sys.stderr)
        return 1
    if not args.quiet:
        print(summary(backlog))
    return 0


if __name__ == "__main__":
    sys.exit(main())
