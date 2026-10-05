import { proxyMultipart } from "../../../../../../../composition/multipart-proxy";
import { projectApiResponse } from "../../../../../../../composition/project-response";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string; path?: string[] }> };
async function control(request: Request, context: Context) {
  const { projectId, path = [] } = await context.params;
  return projectApiResponse(await proxyMultipart(request, projectId, path));
}
export const GET = control;
export const POST = control;
export const DELETE = control;
