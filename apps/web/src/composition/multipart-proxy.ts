import { loadWebConfig } from "../infrastructure/config";
import { correlationIdFromRequest } from "./project-actions";
import type { ApiResult } from "../project-contract";

/** Control-plane JSON only. Large bytes go directly to object storage. */
export async function proxyMultipart(
  request: Request,
  projectId: string,
  path: readonly string[],
): Promise<ApiResult<unknown>> {
  const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const tail = path.join("/");
  const valid =
    (request.method === "POST" && tail === "") ||
    (["GET", "DELETE"].includes(request.method) && new RegExp(`^${id}$`).test(tail)) ||
    (request.method === "POST" &&
      new RegExp(`^${id}/(?:complete|parts/[0-9]+(?:/complete)?)$`).test(tail));
  if (!valid || !new RegExp(`^${id}$`).test(projectId))
    return { ok: false, status: 400, message: "The upload route is not valid." };
  const headers = new Headers({ "x-request-id": correlationIdFromRequest(request) });
  for (const name of ["cookie", "x-editagent-csrf"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let body: string | undefined;
  if (request.method === "POST") {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let text = "",
      size = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2048) {
            await reader.cancel();
            break;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    if (size > 2048)
      return { ok: false, status: 400, message: "The upload metadata is too large." };
    if (text) {
      try {
        body = JSON.stringify(JSON.parse(text));
      } catch {
        return { ok: false, status: 400, message: "The upload metadata is not valid." };
      }
      headers.set("content-type", "application/json");
    }
  }
  try {
    const response = await fetch(
      `${loadWebConfig().apiBaseUrl}/projects/${projectId}/uploads/multipart${tail ? "/" + tail : ""}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: request.signal,
      },
    );
    if (response.status === 204) return { ok: true, data: null };
    const data: unknown = await response.json();
    if (response.ok) return { ok: true, data };
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string" &&
      data.message.length < 200
        ? data.message
        : "The upload request was not completed.";
    return {
      ok: false,
      status: response.status,
      message: response.status >= 500 ? "The upload service is unavailable." : message,
    };
  } catch {
    return { ok: false, status: 502, message: "The upload service is unavailable." };
  }
}
