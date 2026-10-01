import type { components } from "./generated/schema";

/** Project row from the generated OpenAPI schema. Do not add fields the API does not return. */
export type ProjectRecord = components["schemas"]["ProjectResponseDto"];

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/**
 * Port for Project commands.
 * Production wiring does not attach a user id. US-118 will authenticate the transport.
 */
export interface ProjectApi {
  listProjects(): Promise<ApiResult<readonly ProjectRecord[]>>;
  createProject(name: string): Promise<ApiResult<ProjectRecord>>;
  renameProject(projectId: string, name: string): Promise<ApiResult<ProjectRecord>>;
  deleteProject(projectId: string): Promise<ApiResult<void>>;
}
