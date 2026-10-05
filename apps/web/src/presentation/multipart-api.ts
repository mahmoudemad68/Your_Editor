import type { MultipartApi } from "../project-contract";
import { sessionClient } from "./session-client";
export class UploadRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function control<T>(
  project: string,
  path: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await sessionClient.authenticatedFetch(
      `/api/projects/${encodeURIComponent(project)}/uploads/multipart${path}`,
      {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // Fetch reports network disconnects as TypeError; preserve abort/permanent
    // failures and let the same bounded part retry cover control-plane loss.
    if (error instanceof TypeError)
      throw new UploadRequestError(0, "The upload connection was interrupted. Resume when online.");
    throw error;
  }
  const result = await response.json();
  if (!result.ok) throw new UploadRequestError(result.status, result.message);
  return result.data as T;
}
export const browserMultipartApi: MultipartApi = {
  start: (p, body, signal) => control(p, "", "POST", body, signal),
  state: (p, id, signal) => control(p, `/${encodeURIComponent(id)}`, "GET", undefined, signal),
  sign: (p, id, n, signal) =>
    control(p, `/${encodeURIComponent(id)}/parts/${n}`, "POST", undefined, signal),
  record: (p, id, n, etag, signal) =>
    control(p, `/${encodeURIComponent(id)}/parts/${n}/complete`, "POST", { etag }, signal),
  complete: (p, id, signal) =>
    control(p, `/${encodeURIComponent(id)}/complete`, "POST", undefined, signal),
  abort: (p, id) => control(p, `/${encodeURIComponent(id)}`, "DELETE"),
};
