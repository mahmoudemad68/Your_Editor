import { CORRELATION_HEADER, createCorrelationId } from "@editagent/shared";

import type {
  ApiResult,
  BeginUpload,
  MediaAssetRecord,
  MediaDetails,
  ProjectApi,
  ProjectRecord,
} from "../project-contract";

/**
 * Browser transport for the dashboard.
 * It calls this app's server routes. Those routes talk to the Project API.
 * It does not send a user id or a test actor header.
 */
export const browserProjectApi: ProjectApi = {
  listProjects: () => request<readonly ProjectRecord[]>("/api/projects"),
  createProject: (name) =>
    request<ProjectRecord>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  renameProject: (projectId, name) =>
    request<ProjectRecord>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  deleteProject: (projectId) =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
  beginUpload: (projectId, body, options) =>
    request<BeginUpload>(`/api/projects/${encodeURIComponent(projectId)}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    }),
  completeUpload: (projectId, body, options) =>
    request<MediaAssetRecord>(`/api/projects/${encodeURIComponent(projectId)}/uploads/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    }),
  getMediaDetails: (projectId, mediaAssetId, options) =>
    request<MediaDetails>(
      `/api/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaAssetId)}`,
      { signal: options?.signal },
    ),
};

async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has(CORRELATION_HEADER)) {
      headers.set(CORRELATION_HEADER, createCorrelationId());
    }
    const response = await fetch(url, { ...init, headers, cache: "no-store" });
    const body: unknown = await response.json();
    if (isResult<T>(body)) {
      return body;
    }
    return { ok: false, status: response.status, message: "The request was not completed." };
  } catch {
    return { ok: false, status: 0, message: "The Project service could not be reached." };
  }
}

function isResult<T>(body: unknown): body is ApiResult<T> {
  return typeof body === "object" && body !== null && "ok" in body && typeof body.ok === "boolean";
}
