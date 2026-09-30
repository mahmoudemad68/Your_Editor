import { Project, type ProjectRepository } from "@editagent/domain";

/**
 * Compile-time and runtime proof that a workspace package can import the domain
 * root. PostgresProjectRepository is the US-120 adapter. This file is not one.
 */
export type ProjectPersistencePort = ProjectRepository;

export const projectAggregateName: string = Project.name;
