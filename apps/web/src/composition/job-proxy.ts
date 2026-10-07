import { loadWebConfig } from "../infrastructure/config";
import { jobStreamRegistry } from "../infrastructure/job-stream-lifecycle";
import { correlationIdFromRequest } from "./project-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function forwarded(request: Request) {
  const headers = new Headers({ "x-request-id": correlationIdFromRequest(request) });
  for (const name of ["cookie", "x-editagent-csrf"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
/** Fixed upstream route and byte stream. Cancellation aborts fetch AND its reader. */
export async function proxyJobEvents(
  request: Request,
  project: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = { "cache-control": "private, no-store" };
  if (!UUID.test(project)) return new Response(null, { status: 400, headers });
  const abort = new AbortController();
  const unregister = jobStreamRegistry.register(abort);
  if (!unregister) return new Response(null, { status: 503, headers });
  let finished = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    unregister();
    request.signal.removeEventListener("abort", stop);
    abort.signal.removeEventListener("abort", stop);
    abort.abort();
    void reader
      ?.cancel()
      .catch(() => {})
      .finally(() => reader?.releaseLock());
  };
  const stop = () => {
    if (finished) return;
    try {
      downstream?.close();
    } catch {
      /* Downstream cancellation may already have closed the stream. */
    }
    cleanup();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  abort.signal.addEventListener("abort", stop, { once: true });
  if (request.signal.aborted) stop();
  try {
    const upstream = await fetchImpl(
      `${loadWebConfig().apiBaseUrl}/projects/${project}/jobs/events`,
      { headers: forwarded(request), cache: "no-store", redirect: "error", signal: abort.signal },
    );
    if (
      !upstream.ok ||
      !upstream.body ||
      !upstream.headers.get("content-type")?.startsWith("text/event-stream")
    ) {
      await upstream.body?.cancel();
      cleanup();
      return new Response(null, { status: upstream.ok ? 502 : upstream.status, headers });
    }
    if (finished) {
      await upstream.body.cancel();
      return new Response(null, { status: 503, headers });
    }
    reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        downstream = controller;
      },
      async pull(controller) {
        try {
          const chunk = await reader!.read();
          if (finished) return;
          if (chunk.done) {
            controller.close();
            cleanup();
          } else controller.enqueue(chunk.value);
        } catch {
          if (finished) return;
          controller.error(new Error("The event stream was interrupted."));
          cleanup();
        }
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      // This connection stays open for the SSE body, but must not become an
      // idle HTTP keep-alive socket after shutdown closes that body.
      headers: {
        ...headers,
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
        connection: "close",
      },
    });
  } catch {
    cleanup();
    return new Response(null, { status: 502, headers });
  }
}
/** Existing cookie/CSRF boundary for the two small authoritative JSON routes. */
export async function proxyInspectionJob(
  request: Request,
  project: string,
  media: string,
  retry: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = { "cache-control": "private, no-store", "content-type": "application/json" };
  if (!UUID.test(project) || !UUID.test(media))
    return Response.json({ message: "Identifiers must be UUIDv7." }, { status: 400, headers });
  try {
    const response = await fetchImpl(
      `${loadWebConfig().apiBaseUrl}/projects/${project}/media/${media}/${retry ? "inspection/retry" : "inspection-job"}`,
      {
        method: retry ? "POST" : "GET",
        headers: forwarded(request),
        cache: "no-store",
        redirect: "error",
        signal: request.signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json(
        { message: "The inspection request was not completed." },
        { status: response.status, headers },
      );
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json(
      { message: "The inspection service is unavailable." },
      { status: 502, headers },
    );
  }
}
