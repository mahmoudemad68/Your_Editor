import type { ApiResult } from "../project-contract";
import type { EditorDownload, EditorRender, EditorTimeline } from "../editor-contract";
import { request } from "./browser-project-api";

export interface EditorApi {
  create(project: string, media: string, signal: AbortSignal): Promise<ApiResult<EditorTimeline>>;
  read(project: string, id: string, signal: AbortSignal): Promise<ApiResult<EditorTimeline>>;
  edit(
    project: string,
    id: string,
    operation: "trim" | "split",
    body: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ApiResult<EditorTimeline>>;
  render(
    project: string,
    id: string,
    hash: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<ApiResult<EditorRender>>;
  job(project: string, id: string, signal: AbortSignal): Promise<ApiResult<EditorRender>>;
  cancel(project: string, id: string, signal: AbortSignal): Promise<ApiResult<EditorRender>>;
  download(project: string, id: string, signal: AbortSignal): Promise<ApiResult<EditorDownload>>;
}
const root = (project: string) => `/api/projects/${encodeURIComponent(project)}/editor`;
const post = (body: object, signal: AbortSignal): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  signal,
});
export const browserEditorApi: EditorApi = {
  create: (p, mediaAssetId, signal) => request(root(p), post({ mediaAssetId }, signal)),
  read: (p, id, signal) => request(`${root(p)}/${encodeURIComponent(id)}`, { signal }),
  edit: (p, id, operation, body, signal) =>
    request(`${root(p)}/${encodeURIComponent(id)}/${operation}`, post(body, signal)),
  render: (p, id, stateSha256, requestId, signal) =>
    request(
      `${root(p)}/${encodeURIComponent(id)}/render`,
      post({ stateSha256, requestId }, signal),
    ),
  job: (p, id, signal) => request(`${root(p)}/exports/${encodeURIComponent(id)}`, { signal }),
  cancel: (p, id, signal) =>
    request(`${root(p)}/exports/${encodeURIComponent(id)}/cancel`, post({}, signal)),
  download: (p, id, signal) =>
    request(`${root(p)}/exports/${encodeURIComponent(id)}/download`, { signal }),
};
