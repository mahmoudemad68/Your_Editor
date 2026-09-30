/** Public module id. Other modules must not import this folder. */
export const projectsModule = "projects" as const;

export { BrandKit } from "./brand-kit.js";
export { ProjectConflict } from "./project-repository.js";
export { membershipRole, Project, visibleProjects } from "./project.js";
export type {
  ProjectMembership,
  ProjectMembershipRole,
  ProjectMembershipSnapshot,
  ProjectSnapshot,
} from "./project.js";
export type { LoadedProject, ProjectRepository } from "./project-repository.js";
