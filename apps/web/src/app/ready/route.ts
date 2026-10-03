import { apiDependenciesReady } from "../../composition/api-readiness";

export const dynamic = "force-dynamic";

/** Ready means the API readiness endpoint answered. Health does not call it. */
export async function GET(): Promise<Response> {
  if (!(await apiDependenciesReady())) {
    return Response.json({ status: "not-ready" }, { status: 503 });
  }
  return Response.json({ status: "ready" });
}
