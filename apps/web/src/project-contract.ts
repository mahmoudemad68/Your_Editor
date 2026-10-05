import type { components } from "./generated/schema";

/** Project row from the generated OpenAPI schema. Do not add fields the API does not return. */
export type ProjectRecord = components["schemas"]["ProjectResponseDto"];
export type UploadDeclaration = components["schemas"]["UploadDeclarationBody"];
export type BeginUpload = components["schemas"]["BeginUploadResponseDto"];
export type MediaAssetRecord = components["schemas"]["MediaAssetResponseDto"];
export type MediaDetails = components["schemas"]["MediaDetailsResponseDto"];

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** Optional client cancellation. Aborting does not roll back a request the API already accepted. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * Port for Project and media commands.
 * Production wiring does not attach a user id. US-118 will authenticate the transport.
 */
export interface ProjectApi {
  listProjects(): Promise<ApiResult<readonly ProjectRecord[]>>;
  createProject(name: string): Promise<ApiResult<ProjectRecord>>;
  renameProject(projectId: string, name: string): Promise<ApiResult<ProjectRecord>>;
  deleteProject(projectId: string): Promise<ApiResult<void>>;
  beginUpload(
    projectId: string,
    body: UploadDeclaration,
    options?: RequestOptions,
  ): Promise<ApiResult<BeginUpload>>;
  completeUpload(
    projectId: string,
    body: UploadDeclaration,
    options?: RequestOptions,
  ): Promise<ApiResult<MediaAssetRecord>>;
  getMediaDetails(
    projectId: string,
    mediaAssetId: string,
    options?: RequestOptions,
  ): Promise<ApiResult<MediaDetails>>;
}
export type MultipartState = components["schemas"]["MultipartStateDto"];
export type PartUrl = components["schemas"]["PartUrlDto"];
export interface MultipartApi {
  start(projectId: string, body: UploadDeclaration, signal?: AbortSignal): Promise<MultipartState>;
  state(projectId: string, id: string, signal?: AbortSignal): Promise<MultipartState>;
  sign(projectId: string, id: string, partNumber: number, signal?: AbortSignal): Promise<PartUrl>;
  record(
    projectId: string,
    id: string,
    partNumber: number,
    etag: string,
    signal?: AbortSignal,
  ): Promise<MultipartState>;
  complete(projectId: string, id: string, signal?: AbortSignal): Promise<MediaAssetRecord>;
  abort(projectId: string, id: string): Promise<void>;
}
