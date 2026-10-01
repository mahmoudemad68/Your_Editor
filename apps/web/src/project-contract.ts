import type { components } from "./generated/schema";

/** Project row from the generated OpenAPI schema. Do not add fields the API does not return. */
export type ProjectRecord = components["schemas"]["ProjectResponseDto"];
export type UploadDeclaration = components["schemas"]["UploadDeclarationBody"];
export type BeginUpload = components["schemas"]["BeginUploadResponseDto"];
export type MediaAssetRecord = components["schemas"]["MediaAssetResponseDto"];
export type MediaDetails = components["schemas"]["MediaDetailsResponseDto"];

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/**
 * Port for Project and media commands.
 * Production wiring does not attach a user id. US-118 will authenticate the transport.
 */
export interface ProjectApi {
  listProjects(): Promise<ApiResult<readonly ProjectRecord[]>>;
  createProject(name: string): Promise<ApiResult<ProjectRecord>>;
  renameProject(projectId: string, name: string): Promise<ApiResult<ProjectRecord>>;
  deleteProject(projectId: string): Promise<ApiResult<void>>;
  beginUpload(projectId: string, body: UploadDeclaration): Promise<ApiResult<BeginUpload>>;
  completeUpload(projectId: string, body: UploadDeclaration): Promise<ApiResult<MediaAssetRecord>>;
  getMediaDetails(projectId: string, mediaAssetId: string): Promise<ApiResult<MediaDetails>>;
}
