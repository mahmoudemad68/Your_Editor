/** Portable project.json. Authorization remains the canonical Project aggregate's responsibility. */
import { Project, type ProjectSnapshot } from "./modules/projects/project.js";
import { Timeline, type TimelineSnapshot } from "./modules/editing/timeline.js";
import { object, list, text } from "./modules/editing/validation.js";
import { DomainError } from "./kernel/error.js";

export interface ProjectJson {
  schemaVersion: 1;
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    memberships: { userId: string; role: string; createdAt: string }[];
  };
  timeline: TimelineSnapshot;
}
export function projectDocument(project: Project, timeline: Timeline): ProjectJson {
  if (project.id !== timeline.projectId)
    throw new DomainError("Project/Timeline identity differs.");
  return {
    schemaVersion: 1,
    project: {
      id: project.id,
      name: project.name,
      memberships: project.memberships.map((m) => ({
        userId: m.userId,
        role: m.role,
        createdAt: String(m.createdAt),
      })),
      createdAt: String(project.createdAt),
      updatedAt: String(project.updatedAt),
      deletedAt: project.deletedAt === null ? null : String(project.deletedAt),
    },
    timeline: timeline.toSnapshot(),
  };
}
export function serializeProject(project: Project, timeline: Timeline): string {
  return JSON.stringify(projectDocument(project, timeline));
}
export function deserializeProject(value: unknown): { project: Project; timeline: Timeline } {
  const d = object(typeof value === "string" ? JSON.parse(value) : value, [
    "schemaVersion",
    "project",
    "timeline",
  ]);
  if (d.schemaVersion !== 1) throw new DomainError("Unsupported project schema version.");
  const p = object(d.project, ["id", "name", "memberships", "createdAt", "updatedAt", "deletedAt"]);
  const snapshot: ProjectSnapshot = {
    id: text(p.id),
    name: text(p.name),
    createdAt: text(p.createdAt),
    updatedAt: text(p.updatedAt),
    deletedAt: p.deletedAt === null ? null : text(p.deletedAt),
    memberships: list(p.memberships).map((entry) => {
      const m = object(entry, ["userId", "role", "createdAt"]);
      return { userId: text(m.userId), role: text(m.role), createdAt: text(m.createdAt) };
    }),
  };
  const project = Project.restore(snapshot),
    timeline = Timeline.restore(d.timeline);
  if (project.id !== timeline.projectId)
    throw new DomainError("Project/Timeline identity differs.");
  return { project, timeline };
}
