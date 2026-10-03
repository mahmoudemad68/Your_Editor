import { acceptCorrelationId, createCorrelationId } from "@editagent/shared";

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

function api(correlationId?: string) {
  return createHttpProjectApi({
    baseUrl: loadWebConfig().apiBaseUrl,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

export function correlationIdFromRequest(request: Request): string {
  return (
    acceptCorrelationId(request.headers.get("x-request-id") ?? undefined) ?? createCorrelationId()
  );
}

export async function listProjects(
  correlationId?: string,
): Promise<ApiResult<readonly ProjectRecord[]>> {
  return api(correlationId).listProjects();
}

export async function createProject(
  name: string,
  correlationId?: string,
): Promise<ApiResult<ProjectRecord>> {
  return api(correlationId).createProject(name);
}

export async function renameProject(
  projectId: string,
  name: string,
  correlationId?: string,
): Promise<ApiResult<ProjectRecord>> {
  return api(correlationId).renameProject(projectId, name);
}

export async function deleteProject(
  projectId: string,
  correlationId?: string,
): Promise<ApiResult<void>> {
  return api(correlationId).deleteProject(projectId);
}

export async function beginUpload(
  projectId: string,
  body: UploadDeclaration,
  correlationId?: string,
): Promise<ApiResult<BeginUpload>> {
  return api(correlationId).beginUpload(projectId, body);
}

export async function completeUpload(
  projectId: string,
  body: UploadDeclaration,
  correlationId?: string,
): Promise<ApiResult<MediaAssetRecord>> {
  return api(correlationId).completeUpload(projectId, body);
}

export async function getMediaDetails(
  projectId: string,
  mediaAssetId: string,
  correlationId?: string,
): Promise<ApiResult<MediaDetails>> {
  return api(correlationId).getMediaDetails(projectId, mediaAssetId);
}
