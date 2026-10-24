import { parseMediaAnalysis, parseAnalysisFailureDetails } from "@editagent/schemas";
import { loadWebConfig } from "../infrastructure/config";
import { correlationIdFromRequest } from "./project-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const headers = { "cache-control": "private, no-store" };

/** Read the existing authorized API; browser input cannot choose an upstream URL. */
export async function proxyMediaAnalysis(
  request: Request,
  project: string,
  media: string,
  fetchImpl: typeof fetch = fetch,
  failures = false,
): Promise<Response> {
  const failure = (status: number, message: string) =>
    Response.json({ ok: false, status, message }, { status, headers });
  if (!UUID.test(project) || !UUID.test(media)) return failure(400, "Invalid media identity.");
  try {
    const forwarded = new Headers({ "x-request-id": correlationIdFromRequest(request) });
    const cookie = request.headers.get("cookie");
    if (cookie !== null) forwarded.set("cookie", cookie);
    const response = await fetchImpl(
      `${loadWebConfig().apiBaseUrl}/projects/${project}/media/${media}/analysis${failures ? "/failures" : ""}`,
      {
        headers: forwarded,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      const message =
        response.status === 404
          ? "Analysis is not available yet. Refresh after processing finishes."
          : response.status === 401 || response.status === 403
            ? "You do not have access to this analysis."
            : "Analysis could not be loaded. Try again.";
      return failure(response.status, message);
    }
    const analysis = failures
      ? parseAnalysisFailureDetails(await response.json())
      : parseMediaAnalysis(await response.json());
    if (analysis.mediaAssetId !== media)
      return failure(502, "Analysis response could not be verified.");
    return Response.json({ ok: true, data: analysis }, { headers });
  } catch {
    return failure(502, "Analysis could not be loaded. Try again.");
  }
}
