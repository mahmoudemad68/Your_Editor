import { loadWebConfig } from "../infrastructure/config";
import { createHttpProjectApi } from "../infrastructure/project-api";
import type {
  ApiResult,
  BeginUpload,
  MediaAssetRecord,
  MediaDetails,
  ProjectRecord,
  UploadDeclaration,
} from "../project-contract";

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

export async function beginUpload(
  projectId: string,
  body: UploadDeclaration,
): Promise<ApiResult<BeginUpload>> {
  return api().beginUpload(projectId, body);
}

export async function completeUpload(
  projectId: string,
  body: UploadDeclaration,
): Promise<ApiResult<MediaAssetRecord>> {
  return api().completeUpload(projectId, body);
}

export async function getMediaDetails(
  projectId: string,
  mediaAssetId: string,
): Promise<ApiResult<MediaDetails>> {
  return api().getMediaDetails(projectId, mediaAssetId);
}
