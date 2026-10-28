import { loadWebConfig } from "../infrastructure/config";
import { correlationIdFromRequest } from "./project-actions";

const uuid = (id: string) =>
  id.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const headers = { "cache-control": "private, no-store" };

async function json(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) throw new Error("Missing JSON body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new Error("JSON exceeds bound");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed operations only. Browser input cannot choose routing, executables or object keys. */
export async function proxyEditor(
  request: Request,
  project: string,
  parts: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const fail = (status: number, message: string) =>
    Response.json({ ok: false, status, message }, { status, headers });
  if (!uuid(project)) return fail(400, "Invalid project identity.");
  let path: string | undefined;
  if (parts.length === 0 && request.method === "POST") path = "timelines";
  else if (parts.length === 1 && uuid(parts[0]!) && request.method === "GET")
    path = `timelines/${parts[0]}`;
  else if (
    parts.length === 2 &&
    uuid(parts[0]!) &&
    ["trim", "split", "render"].includes(parts[1]!) &&
    request.method === "POST"
  )
    path = `timelines/${parts[0]}/${parts[1]}`;
  else if (parts[0] === "exports" && uuid(parts[1] ?? "")) {
    if (parts.length === 2 && request.method === "GET") path = `exports/${parts[1]}`;
    if (parts.length === 3 && parts[2] === "download" && request.method === "GET")
      path = `exports/${parts[1]}/download`;
    if (parts.length === 3 && parts[2] === "cancel" && request.method === "POST")
      path = `exports/${parts[1]}/cancel`;
  } else if (uuid(parts[0] ?? "") && parts[1] === "captions") {
    if (parts.length === 2 && request.method === "POST") path = `timelines/${parts[0]}/captions`;
    if (parts.length === 3 && parts[2] === "history" && request.method === "GET")
      path = `timelines/${parts[0]}/captions/history`;
    if (parts.length === 4 && parts[2] === "sources" && uuid(parts[3]!) && request.method === "GET")
      path = `timelines/${parts[0]}/captions/sources/${parts[3]}`;
    if (
      parts.length === 4 &&
      uuid(parts[2]!) &&
      ["style", "undo"].includes(parts[3]!) &&
      request.method === "POST"
    )
      path = `timelines/${parts[0]}/captions/${parts[2]}/${parts[3]}`;
  }
  if (!path) return fail(400, "Invalid editing operation.");
  try {
    const forwarded = new Headers({ "x-request-id": correlationIdFromRequest(request) });
    for (const name of ["cookie", "x-editagent-csrf"]) {
      const value = request.headers.get(name);
      if (value !== null) forwarded.set(name, value);
    }
    let body: string | undefined;
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return fail(415, "Send JSON editing parameters.");
      body = JSON.stringify(await json(request.body, 8192));
      forwarded.set("content-type", "application/json");
    }
    const response = await fetchImpl(`${loadWebConfig().apiBaseUrl}/projects/${project}/${path}`, {
      method: request.method,
      headers: forwarded,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message =
        response.status === 409
          ? "The timeline changed or this operation is not available. Reload the timeline."
          : response.status === 401 || response.status === 403 || response.status === 404
            ? "This project or export is not available to you."
            : response.status === 400
              ? "The edit is outside the selected clip or has invalid parameters."
              : response.status === 503
                ? "Rendering is not configured or a required service is unavailable."
                : "The editing request could not be completed. Try again.";
      return fail(response.status, message);
    }
    const data = await json(response.body, 524288);
    if (!data || typeof data !== "object") throw new Error("Invalid editing response");
    const record = data as Record<string, unknown>;
    const expectsHistory = path.endsWith("/captions/history");
    const expectsCaptionSource = path.includes("/captions/sources/");
    const expectsTimeline =
      path.startsWith("timelines") &&
      !path.endsWith("/render") &&
      !expectsHistory &&
      !expectsCaptionSource;
    if (
      expectsHistory &&
      (!Array.isArray(data) ||
        data.length > 100 ||
        data.some(
          (v) => !v || !uuid(v.id) || !["admitted", "committed", "undone"].includes(v.status),
        ))
    )
      throw new Error("Invalid caption history");
    if (
      expectsCaptionSource &&
      (record.assetId !== parts[3] ||
        typeof record.sourceSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.sourceSha256) ||
        typeof record.analysisSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.analysisSha256))
    )
      throw new Error("Invalid caption evidence identity");
    const expectsDownload = path.endsWith("/download");
    if (expectsTimeline) {
      const timeline = record.timeline as Record<string, unknown>;
      if (
        !timeline ||
        timeline.projectId !== project ||
        !uuid(String(timeline.id)) ||
        (parts.length > 0 && timeline.id !== parts[0]) ||
        String(record.stateSha256).length !== 64 ||
        !/^[a-f0-9]{64}$/.test(String(record.stateSha256))
      )
        throw new Error("Timeline identity mismatch");
    }
    if (
      !expectsTimeline &&
      !expectsHistory &&
      !expectsCaptionSource &&
      !expectsDownload &&
      (!uuid(String(record.jobId)) || (parts[0] === "exports" && record.jobId !== parts[1]))
    )
      throw new Error("Render identity mismatch");
    if (expectsDownload) {
      for (const field of ["previewUrl", "downloadUrl"]) {
        if (
          typeof record[field] !== "string" ||
          !["http:", "https:"].includes(new URL(record[field]).protocol)
        )
          throw new Error("Invalid export URL");
      }
    }
    return Response.json({ ok: true, data }, { headers });
  } catch {
    return fail(502, "The editing request could not be completed. Try again.");
  }
}
