import { Project, type ProjectRepository } from "@editagent/domain";

/**
 * Compile-time and runtime proof that a workspace package can import the domain
 * root. US-120 will implement ProjectRepository. This file is not a repository.
 */
export type ProjectPersistencePort = ProjectRepository;

export const projectAggregateName: string = Project.name;
