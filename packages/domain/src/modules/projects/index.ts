/** Public module id. Other modules must not import this folder. */
export const projectsModule = "projects" as const;

export { BrandKit } from "./brand-kit.js";
export { membershipRole, Project, visibleProjects } from "./project.js";
export type { ProjectMembership, ProjectMembershipRole } from "./project.js";
export type { ProjectRepository } from "./project-repository.js";
