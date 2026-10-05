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

function api(request?: Request) {
  const headers = new Headers();
  for (const name of ["cookie", "x-editagent-csrf"]) {
    const value = request?.headers.get(name);
    if (value != null) headers.set(name, value);
  }
  const correlationId = request === undefined ? undefined : correlationIdFromRequest(request);
  return createHttpProjectApi({
    baseUrl: loadWebConfig().apiBaseUrl,
    requestHeaders: headers,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

export function correlationIdFromRequest(request: Request): string {
  return (
    acceptCorrelationId(request.headers.get("x-request-id") ?? undefined) ?? createCorrelationId()
  );
}

export async function listProjects(
  request?: Request,
): Promise<ApiResult<readonly ProjectRecord[]>> {
  return api(request).listProjects();
}

export async function createProject(
  name: string,
  request?: Request,
): Promise<ApiResult<ProjectRecord>> {
  return api(request).createProject(name);
}

export async function renameProject(
  projectId: string,
  name: string,
  request?: Request,
): Promise<ApiResult<ProjectRecord>> {
  return api(request).renameProject(projectId, name);
}

export async function deleteProject(
  projectId: string,
  request?: Request,
): Promise<ApiResult<void>> {
  return api(request).deleteProject(projectId);
}

export async function beginUpload(
  projectId: string,
  body: UploadDeclaration,
  request?: Request,
): Promise<ApiResult<BeginUpload>> {
  return api(request).beginUpload(projectId, body);
}

export async function completeUpload(
  projectId: string,
  body: UploadDeclaration,
  request?: Request,
): Promise<ApiResult<MediaAssetRecord>> {
  return api(request).completeUpload(projectId, body);
}

export async function getMediaDetails(
  projectId: string,
  mediaAssetId: string,
  request?: Request,
): Promise<ApiResult<MediaDetails>> {
  return api(request).getMediaDetails(projectId, mediaAssetId);
}
