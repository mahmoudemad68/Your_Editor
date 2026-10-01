import { loadWebConfig } from "../infrastructure/config";
import { createHttpProjectApi } from "../infrastructure/project-api";
import type { ApiResult, ProjectRecord } from "../project-contract";

function api() {
  return createHttpProjectApi({ baseUrl: loadWebConfig().apiBaseUrl });
}

export async function listProjects(): Promise<ApiResult<readonly ProjectRecord[]>> {
  return api().listProjects();
}

export async function createProject(name: string): Promise<ApiResult<ProjectRecord>> {
  return api().createProject(name);
}

export async function renameProject(
  projectId: string,
  name: string,
): Promise<ApiResult<ProjectRecord>> {
  return api().renameProject(projectId, name);
}

export async function deleteProject(projectId: string): Promise<ApiResult<void>> {
  return api().deleteProject(projectId);
}
