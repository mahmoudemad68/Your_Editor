import { proxyJobEvents } from "../../../../../../composition/job-proxy";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  return proxyJobEvents(request, (await context.params).projectId);
}
