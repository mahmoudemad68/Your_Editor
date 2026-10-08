import type { LibraryItem, MediaLibraryApi, MediaPreview } from "../media-library-contract";
import { request } from "./browser-project-api";

export const browserMediaLibraryApi: MediaLibraryApi = {
  listMedia: (project, options) =>
    request<readonly LibraryItem[]>(`/api/projects/${encodeURIComponent(project)}/media`, {
      signal: options?.signal,
    }),
  getMediaPreview: (project, media, options) =>
    request<MediaPreview>(
      `/api/projects/${encodeURIComponent(project)}/media/${encodeURIComponent(media)}/preview`,
      { signal: options?.signal },
    ),
};
