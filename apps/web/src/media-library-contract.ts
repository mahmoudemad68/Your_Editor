import type { components } from "./generated/schema";
import type { ApiResult, RequestOptions } from "./project-contract";

export type LibraryItem = components["schemas"]["MediaLibraryItemDto"];
export type MediaPreview = components["schemas"]["MediaPreviewResponseDto"];
export type SpriteLayout = components["schemas"]["SpriteLayoutDto"];
export interface MediaLibraryApi {
  listMedia(
    projectId: string,
    options?: RequestOptions,
  ): Promise<ApiResult<readonly LibraryItem[]>>;
  getMediaPreview(
    projectId: string,
    mediaId: string,
    options?: RequestOptions,
  ): Promise<ApiResult<MediaPreview>>;
}
